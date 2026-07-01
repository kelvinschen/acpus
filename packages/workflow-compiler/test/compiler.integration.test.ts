import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileWorkflowModule,
} from "../src/index.js";
import type { NodeIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";

describe.concurrent("workflow module compiler", () => {
  it("compiles a TypeScript workflow module with reusable, inline, and third-party task bundles", async () => {
    const ir = await compileFixture("release.workflow.ts");

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("release-readiness");
    expect(ir.diagnostics).toEqual([]);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(4);
    expect(Object.values(ir.assets.taskBundles).some(bundle => bundle.inline === false)).toBe(true);
    expect(Object.values(ir.assets.taskBundles).some(bundle => bundle.inline === true)).toBe(true);
    expectProductionBundles(ir.assets.taskBundles);
    expect(findTaskBundle(ir, "tasks/local-dependency.task.ts")?.source).toContain("slugifyPackageName");
    const thirdPartyBundle = findTaskBundle(ir, "tasks/node-module-dependency.task.ts");
    expect(thirdPartyBundle?.inline).toBe(false);
    // The third-party dependency must be inlined into the frozen bundle source,
    // not left as a bare import for the runtime to re-resolve.
    expect(thirdPartyBundle?.source).not.toMatch(/from\s+["']slash["']/);
    expect(thirdPartyBundle?.source).toContain("replace");
  });

  it("keeps compileWorkflowModule as the lower-level no-check API", async () => {
    const ir = await compileFixture("inline-capture.workflow.ts");

    expect(ir.diagnostics).not.toContainEqual(expect.objectContaining({ code: "TB007" }));
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({ code: "TB001", severity: "error" }));
  });

  it("bundles exported same-file reusable tasks through workflow module imports", async () => {
    const ir = await compileFixture("same-file-reusable.workflow.ts");

    expect(ir.diagnostics).toEqual([]);
    const bundle = findTaskBundle(ir, "same-file-reusable.workflow.ts");
    expect(bundle).toMatchObject({
      inline: false,
      sourceFile: expect.stringContaining("same-file-reusable.workflow.ts"),
    });
    expect(bundle?.source?.length).toBeGreaterThan(0);
    expect(bundle?.source).not.toMatch(/from\s+["']slash["']/);
    expect(bundle?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(getNode(ir.root, "normalize_path")).toMatchObject({
      kind: "task",
      run: {
        inline: false,
      },
    });
    expect(ir.outputs.normalized).toEqual({ kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] });
  });

  it("does not execute the workflow build callback when importing same-file task bundles", async () => {
    const ir = await compileFixture("same-file-build-callback.workflow.ts");
    const bundle = findTaskBundle(ir, "same-file-build-callback.workflow.ts");
    if (!bundle?.source) throw new Error("expected same-file task bundle source");

    const dir = await mkdtemp(join(tmpdir(), "acpus-same-file-task-"));
    const previous = process.env.ACPUS_FAIL_IF_BUILD_CALLBACK_EXECUTED;
    try {
      const bundlePath = join(dir, "bundle.mjs");
      await writeFile(bundlePath, bundle.source);
      process.env.ACPUS_FAIL_IF_BUILD_CALLBACK_EXECUTED = "1";
      const mod = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
      await expect(mod.default({ input: {}, abortSignal: new AbortController().signal })).resolves.toEqual({ ok: true });
    } finally {
      if (previous === undefined) {
        delete process.env.ACPUS_FAIL_IF_BUILD_CALLBACK_EXECUTED;
      } else {
        process.env.ACPUS_FAIL_IF_BUILD_CALLBACK_EXECUTED = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("derives reusable task provenance from source, stable across compiles", async () => {
    // Guards the Error.stack -> static-source provenance migration: provenance
    // must be a deterministic function of the source, not of call timing.
    const entry = fixture("release.workflow.ts");
    const first = await compileWorkflowModule(entry, { sourcePath: "x" });
    const second = await compileWorkflowModule(entry, { sourcePath: "x" });

    const a = findTaskBundle(first, "tasks/node-module-dependency.task.ts");
    const b = findTaskBundle(second, "tasks/node-module-dependency.task.ts");
    expect(a?.sourceFile).toBe(b?.sourceFile);
    expect(a?.digest).toBe(b?.digest);
    expect(first.lock.taskBundleDigests).toEqual(second.lock.taskBundleDigests);
  });

  it("fails closed when a valid and an invalid task share one bundle id", async () => {
    const ir = await compileFixture("shared-bundle.workflow.ts");

    // Both task nodes collapse to one bundle id. Direct compile does not run the
    // task-authoring rules, but the bundler still fails closed when any
    // reusable callsite lacks source metadata.
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(1);
    expect(getTaskBundleId(ir.root, "good_call")).toBe(getTaskBundleId(ir.root, "bad_call"));
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({ code: "TB001", severity: "error" }));
  });

  it("fails closed when one bundle id has conflicting reusable metadata", async () => {
    const ir = await compileFixture("conflicting-bundle-metadata.workflow.ts");

    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(1);
    expect(getTaskBundleId(ir.root, "first")).toBe(getTaskBundleId(ir.root, "second"));
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "TB001",
      severity: "error",
      message: expect.stringContaining("conflicting"),
    }));
  });

  it("compiles a representative orchestration fixture with composite scopes", async () => {
    const ir = await compileFixture("orchestration.workflow.ts");

    expect(ir.name).toBe("orchestration-fixture");
    expect(ir.diagnostics).toEqual([]);
    expect(ir.outputs.run_id).toEqual({ kind: "ref", path: ["meta", "runId"] });
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

    const fanout = getNode(ir.root, "lanes");
    expect(fanout).toMatchObject({
      kind: "fanout",
      over: { kind: "ref", path: ["input", "lanes"] },
      key: {
        parts: expect.arrayContaining([
          {
            kind: "expr",
            expr: { kind: "ref", path: ["fanout", "lanes", "item", "id"] },
          },
        ]),
      },
      do: {
        outputs: {
          lane: {
            kind: "call",
            fn: "coalesce",
            args: [
              { kind: "ref", path: ["fanout", "lanes", "item", "id"] },
              { kind: "literal", value: "(none)" },
            ],
          },
          route: {
            kind: "ref",
            path: ["nodes", "lane_parallel", "output", "route", "route"],
          },
        },
      },
    });
    if (fanout?.kind !== "fanout") throw new Error("expected fanout fixture node");

    const parallel = getNode(fanout.do, "lane_parallel");
    expect(parallel).toMatchObject({
      kind: "parallel",
      branches: {
        review: {
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
    if (parallel?.kind !== "parallel") throw new Error("expected parallel fixture node");

    const repairBranch = parallel.branches.repair;
    if (!repairBranch) throw new Error("expected repair branch fixture node");
    const loop = getNode(repairBranch.scope, "repair_loop");
    expect(loop).toMatchObject({
      kind: "loop",
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
    if (loop?.kind !== "loop") throw new Error("expected loop fixture node");

    expect(getNode(loop.do, "repair_round")).toMatchObject({
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

    const routeBranch = parallel.branches.route;
    if (!routeBranch) throw new Error("expected route branch fixture node");
    const routeSwitch = getNode(routeBranch.scope, "route_lane");
    expect(routeSwitch).toMatchObject({
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

    const approval = getNode(ir.root, "approval");
    expect(approval).toMatchObject({
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
            run: { input: {} },
          },
        ],
      },
    });
    if (approval?.kind !== "if") throw new Error("expected approval fixture node");
    expect((approval.then.nodes[0] as any)).not.toHaveProperty("inputs");
  });
});

async function compileFixture(relativePath: string): Promise<WorkflowIR> {
  return compileWorkflowModule(fixture(relativePath), {
    sourcePath: `packages/workflow-compiler/test/fixtures/workflows/${relativePath}`,
  });
}

function fixture(relativePath: string): string {
  return fileURLToPath(new URL(`./fixtures/workflows/${relativePath}`, import.meta.url));
}

function expectProductionBundles(bundles: Record<string, { digest: string; source?: string; note?: string }>): void {
  expect(Object.values(bundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
  expect(Object.values(bundles).every(bundle => typeof bundle.source === "string" && bundle.source.length > 0)).toBe(true);
  expect(Object.values(bundles).every(bundle => bundle.note === undefined)).toBe(true);
}

function findTaskBundle(ir: WorkflowIR, sourceFileSuffix: string): WorkflowIR["assets"]["taskBundles"][string] | undefined {
  return Object.values(ir.assets.taskBundles).find(bundle => bundle.sourceFile?.endsWith(sourceFileSuffix));
}

function getTaskBundleId(scope: ScopeIR, nodeId: string): string {
  const node = getNode(scope, nodeId);
  if (node.kind !== "task") throw new Error(`expected task node ${nodeId}`);
  return node.run.bundleId;
}

function getNode(scope: ScopeIR, nodeId: string): NodeIR {
  const node = scope.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error(`expected node ${nodeId}`);
  return node;
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
