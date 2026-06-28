import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileWorkflowModule,
  type NodeIR,
  type ScopeIR,
} from "../src/index.js";

describe("workflow module compiler", () => {
  it("compiles a TypeScript workflow module through the module API", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/module.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/module.workflow.ts",
    });

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("module-fixture");
    expect(ir.root.nodes.map(node => node.id)).toEqual([
      "normalize_package",
      "review",
      "require_ready",
    ]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual(["task", "agent", "assert"]);
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(1);
    expectProductionBundles(ir.assets.taskBundles);
    expect(Object.values(ir.assets.taskBundles)[0]?.source).toContain("slugifyPackageName");
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([]);
    expect(Object.keys(ir.outputs).sort()).toEqual(["ready", "slug"]);
  });

  it("compiles a richer TypeScript workflow fixture with reusable and inline tasks", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/release.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/release.workflow.ts",
    });

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("release-readiness");
    expect(ir.root.nodes.map(node => node.id)).toEqual([
      "normalize_package",
      "prepare_release",
      "run_tests",
      "require_tests",
      "review_security",
      "review_performance",
      "review_docs",
      "require_all_reviews_ready",
      "final_summary",
    ]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual([
      "task",
      "task",
      "task",
      "assert",
      "agent",
      "agent",
      "agent",
      "assert",
      "agent",
    ]);
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(3);
    expect(Object.values(ir.assets.taskBundles).some(bundle => bundle.inline === false)).toBe(true);
    expect(Object.values(ir.assets.taskBundles).some(bundle => bundle.inline === true)).toBe(true);
    expectProductionBundles(ir.assets.taskBundles);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([]);
    expect(Object.keys(ir.outputs).sort()).toEqual([
      "changelogDraft",
      "maxRiskCount",
      "ready",
      "summary",
    ]);
  });

  it("rejects reusable tasks that are private workflow-local values", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/local-task.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/local-task.workflow.ts",
    });

    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "TB004",
      severity: "error",
      path: expect.stringMatching(/^assets\.taskBundles\..+\.sourceFile$/),
    }));
  });

  it("rejects inline tasks that capture workflow-module scope", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/inline-capture.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/inline-capture.workflow.ts",
    });

    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "TB007",
      severity: "error",
      path: expect.stringMatching(/^assets\.taskBundles\..+\.source$/),
    }));
  });

  it("bundles a reusable task dependency graph including third-party imports", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/third-party-task.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/third-party-task.workflow.ts",
    });

    expect(ir.diagnostics).toEqual([]);
    const bundle = Object.values(ir.assets.taskBundles)[0];
    expect(bundle?.inline).toBe(false);
    expect(bundle?.sourceFile?.endsWith("tasks/check-version.task.ts")).toBe(true);
    // The third-party dependency must be inlined into the frozen bundle source,
    // not left as a bare import for the runtime to re-resolve.
    expect(bundle?.source).not.toMatch(/from\s+["']zod["']/);
    expect(bundle?.source).toContain("safeParse");
  });

  it("derives reusable task provenance from source, stable across compiles", async () => {
    // Guards the Error.stack -> static-source provenance migration: provenance
    // must be a deterministic function of the source, not of call timing.
    const entry = fileURLToPath(new URL("fixtures/workflows/third-party-task.workflow.ts", import.meta.url));
    const first = await compileWorkflowModule(entry, { sourcePath: "x" });
    const second = await compileWorkflowModule(entry, { sourcePath: "x" });

    const a = Object.values(first.assets.taskBundles)[0];
    const b = Object.values(second.assets.taskBundles)[0];
    expect(a?.sourceFile).toBe(b?.sourceFile);
    expect(a?.digest).toBe(b?.digest);
    expect(first.lock.taskBundleDigests).toEqual(second.lock.taskBundleDigests);
  });

  it("fails closed when a valid and an invalid task share one bundle id", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/shared-bundle.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/shared-bundle.workflow.ts",
    });

    // Both task nodes collapse to one bundle id; the workflow-local callsite
    // must still be rejected even though the valid callsite is declared first.
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(1);
    expect(ir.root.nodes.map(node => node.kind === "task" && node.run.bundleId)).toEqual([
      Object.keys(ir.assets.taskBundles)[0],
      Object.keys(ir.assets.taskBundles)[0],
    ]);
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({ code: "TB004", severity: "error" }));
  });

  it("compiles a representative orchestration fixture with composite scopes", async () => {
    const entry = fileURLToPath(new URL("fixtures/workflows/orchestration.workflow.ts", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/workflows/orchestration.workflow.ts",
    });

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("orchestration-fixture");
    expect(ir.root.nodes.map(node => node.id)).toEqual([
      "lanes",
      "approval",
      "require_approval",
    ]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual([
      "fanout",
      "if",
      "assert",
    ]);
    expect([...new Set(collectKinds(ir.root))].sort()).toEqual([
      "agent",
      "assert",
      "fanout",
      "if",
      "loop",
      "parallel",
      "signal",
      "switch",
      "task",
    ]);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([]);
    expect(Object.keys(ir.outputs).sort()).toEqual([
      "approved",
      "first_lane",
      "first_review_ok",
      "first_route",
      "notes",
    ]);

    const fanout = ir.root.nodes[0];
    expect(fanout).toMatchObject({
      id: "lanes",
      kind: "fanout",
      over: { kind: "ref", path: ["input", "lanes"] },
      strategy: "all",
      itemOutputSchema: { kind: "object" },
      key: {
        kind: "template",
        parts: [
          { kind: "text", value: "lane-" },
          {
            kind: "expr",
            expr: { kind: "ref", path: ["fanout", "lanes", "item", "id"] },
          },
        ],
      },
      do: {
        outputs: {
          lane: {
            kind: "call",
            fn: "coalesce",
            args: [
              { kind: "ref", path: ["fanout", "lanes", "item", "id"] },
              { kind: "literal", value: "" },
            ],
          },
          route: {
            kind: "ref",
            path: ["nodes", "lane_parallel", "output", "route", "route"],
          },
        },
      },
    });
    if (fanout.kind !== "fanout") throw new Error("expected fanout fixture node");

    const parallel = fanout.do.nodes[0];
    expect(parallel).toMatchObject({
      id: "lane_parallel",
      kind: "parallel",
      strategy: "all",
      branches: {
        review: {
          outputSchema: { kind: "object" },
          scope: {
            outputs: {
              ok: { kind: "ref", path: ["nodes", "review_lane", "output", "ok"] },
            },
          },
        },
        route: {
          scope: {
            outputs: {
              route: {
                kind: "ref",
                path: ["nodes", "route_lane", "output", "route"],
              },
            },
          },
        },
      },
    });
    if (parallel.kind !== "parallel") throw new Error("expected parallel fixture node");

    const loop = parallel.branches.repair.scope.nodes[0];
    expect(loop).toMatchObject({
      id: "repair_loop",
      kind: "loop",
      onExhausted: "returnLast",
      do: {
        outputs: {
          summary: {
            kind: "ref",
            path: ["nodes", "repair_round", "output", "summary"],
          },
        },
      },
      stopWhen: {
        kind: "call",
        fn: "not",
        args: [
          {
            kind: "ref",
            path: ["loop", "repair_loop", "result", "continue"],
          },
        ],
      },
    });
    if (loop.kind !== "loop") throw new Error("expected loop fixture node");

    expect(loop.do.nodes[0]).toMatchObject({
      id: "repair_round",
      kind: "agent",
      run: {
        prompt: {
          parts: expect.arrayContaining([
            {
              kind: "expr",
              expr: {
                kind: "call",
                fn: "coalesce",
                args: [
                  {
                    kind: "ref",
                    path: ["loop", "repair_loop", "previous", "summary"],
                  },
                  { kind: "literal", value: "(none)" },
                ],
              },
            },
          ]),
        },
      },
    });

    const routeSwitch = parallel.branches.route.scope.nodes[0];
    expect(routeSwitch).toMatchObject({
      id: "route_lane",
      kind: "switch",
      cases: [
        {
          when: {
            kind: "call",
            fn: "eq",
            args: [
              { kind: "ref", path: ["fanout", "lanes", "item", "mode"] },
              { kind: "literal", value: "auto" },
            ],
          },
        },
      ],
      default: {
        outputs: {
          route: {
            kind: "ref",
            path: ["nodes", "manual_route", "output", "route"],
          },
        },
      },
    });

    const approval = ir.root.nodes[1];
    expect(approval).toMatchObject({
      id: "approval",
      kind: "if",
      then: {
        nodes: [
          {
            id: "human_approval",
            kind: "signal",
          },
        ],
        outputs: {
          approved: {
            kind: "ref",
            path: ["nodes", "human_approval", "output", "approved"],
          },
        },
      },
      else: {
        nodes: [
          {
            id: "automatic_approval",
            kind: "task",
            inputs: {},
          },
        ],
      },
    });
    expect((approval.then.nodes[0] as any)).not.toHaveProperty("inputs");

    expect(ir.root.nodes[2]).toMatchObject({
      id: "require_approval",
      kind: "assert",
      condition: {
        kind: "ref",
        path: ["nodes", "approval", "output", "approved"],
      },
      message: {
        parts: [
          { kind: "text", value: "Approval failed: " },
          {
            kind: "expr",
            expr: {
              kind: "ref",
              path: ["nodes", "approval", "output", "notes"],
            },
          },
        ],
      },
    });
  });
});

function expectProductionBundles(bundles: Record<string, { digest: string; source?: string; note?: string }>): void {
  expect(Object.values(bundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
  expect(Object.values(bundles).every(bundle => typeof bundle.source === "string" && bundle.source.length > 0)).toBe(true);
  expect(Object.values(bundles).every(bundle => bundle.note === undefined)).toBe(true);
}

function collectKinds(scope: ScopeIR): NodeIR["kind"][] {
  const kinds: NodeIR["kind"][] = [];
  for (const node of scope.nodes) {
    kinds.push(node.kind);
    for (const child of childScopes(node)) kinds.push(...collectKinds(child));
  }
  return kinds;
}

function childScopes(node: NodeIR): ScopeIR[] {
  switch (node.kind) {
    case "if":
      return node.else ? [node.then, node.else] : [node.then];
    case "switch":
      return [
        ...node.cases.map(item => item.then),
        ...(node.default ? [node.default] : []),
      ];
    case "parallel":
      return Object.values(node.branches).map(branch => branch.scope);
    case "fanout":
      return [node.do];
    case "loop":
      return [node.do];
    default:
      return [];
  }
}
