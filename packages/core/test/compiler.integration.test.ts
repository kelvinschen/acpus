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
    expect(Object.values(ir.assets.taskBundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([
      expect.objectContaining({
        code: "C001",
        severity: "warning",
      }),
    ]);
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
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([
      expect.objectContaining({
        code: "C001",
        severity: "warning",
      }),
    ]);
    expect(Object.keys(ir.outputs).sort()).toEqual([
      "changelogDraft",
      "maxRiskCount",
      "ready",
      "summary",
    ]);
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
    expect(ir.diagnostics).toEqual([
      expect.objectContaining({
        code: "C001",
        severity: "warning",
      }),
    ]);
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
