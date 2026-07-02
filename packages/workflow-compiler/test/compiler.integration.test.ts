import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileWorkflowModule,
  tryCompileWorkflowModule,
} from "../src/index.js";
import type { NodeIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe.concurrent("workflow module compiler", () => {
  it("compiles a TypeScript workflow module with reusable module references and inline task source", async () => {
    const ir = await compileFixture("release.workflow.ts");

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("release-readiness");
    expect(ir.diagnostics).toEqual([]);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(taskTarget(ir.root, "normalize_package")).toMatchObject({
      kind: "module",
      specifier: "./tasks/local-dependency.task.js",
      exportName: "default",
      referrer: { kind: "workflow", path: expect.stringContaining("release.workflow.ts") },
    });
    expect(taskTarget(ir.root, "normalize_path")).toMatchObject({
      kind: "module",
      specifier: "./tasks/node-module-dependency.task.js",
      exportName: "default",
    });
    expect(taskTarget(ir.root, "prepare_release")).toMatchObject({ kind: "inline", source: expect.any(String) });
    expect(taskTarget(ir.root, "run_tests")).toMatchObject({ kind: "inline", source: expect.any(String) });
  });

  it("keeps compileWorkflowModule as the lower-level no-check API", async () => {
    const ir = await compileFixture("inline-capture.workflow.ts");

    expect(ir.diagnostics).not.toContainEqual(expect.objectContaining({ code: "TB007" }));
    expect(ir.diagnostics).toEqual([]);
  });

  it("compiles exported same-file reusable tasks as live workflow module references", async () => {
    const ir = await compileFixture("same-file-reusable.workflow.ts");

    expect(ir.diagnostics).toEqual([]);
    expect(taskTarget(ir.root, "normalize_path")).toMatchObject({
      kind: "module",
      specifier: "./same-file-reusable.workflow.ts",
      exportName: "normalizePath",
      referrer: { kind: "workflow", path: expect.stringContaining("same-file-reusable.workflow.ts") },
    });
    expect(ir.outputs.normalized).toEqual({ kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] });
  });

  it("compiles same-file task references without generated task source", async () => {
    const ir = await compileFixture("same-file-build-callback.workflow.ts");
    expect(taskTarget(ir.root, "stable_task")).toMatchObject({
      kind: "module",
      specifier: "./same-file-build-callback.workflow.ts",
      exportName: "stableTask",
    });
  });

  it("derives reusable task references from source, stable across compiles", async () => {
    const entry = fixture("release.workflow.ts");
    const first = await compileWorkflowModule(entry, { sourcePath: "x" });
    const second = await compileWorkflowModule(entry, { sourcePath: "x" });

    expect(taskTarget(first.root, "normalize_path")).toEqual(taskTarget(second.root, "normalize_path"));
  });

  it("returns tagged errors for invalid workflow module exports", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-invalid-export-"));
    try {
      const workflow = join(cwd, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await tryCompileWorkflowModule(workflow);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected invalid default export");
      expect(result.error).toEqual({
        type: "invalid-default-export",
        entry: workflow,
        message: `Default export of ${workflow} is not an Acpus workflow definition.`,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns tagged errors for workflows outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-outside-workspace-"));
    try {
      const workflow = fixture("release.workflow.ts");
      const result = await tryCompileWorkflowModule(workflow, { cwd });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected outside workspace failure");
      expect(result.error).toMatchObject({
        type: "workflow-outside-workspace",
        workflowFile: workflow,
        cwd,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns tagged errors when workflow lowering throws", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-build-failure-"));
    try {
      await symlink(join(repoRoot, "node_modules"), join(cwd, "node_modules"), "dir");
      const workflow = join(cwd, "throws.workflow.ts");
      await writeFile(workflow, `import { defineWorkflow } from "acpus/core";

export default defineWorkflow({ name: "throws" }).build(() => {
  throw new Error("boom");
});
`);

      const result = await tryCompileWorkflowModule(workflow);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected workflow build failure");
      expect(result.error).toMatchObject({
        type: "workflow-build-failed",
        entry: workflow,
        message: expect.stringContaining("boom"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
      initial: {
        kind: "object",
        fields: {
          branch: { kind: "literal", value: "" },
          round: { kind: "literal", value: 0 },
          continue: { kind: "literal", value: true },
          summary: { kind: "literal", value: "" },
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
    if (loop?.kind !== "loop") throw new Error("expected loop fixture node");

    expect(getNode(loop.do, "repair_round")).toMatchObject({
      kind: "agent",
      run: {
        prompt: {
          parts: expect.arrayContaining([
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["loop", "repair_loop", "previous", "summary"],
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

function taskTarget(scope: ScopeIR, nodeId: string): Extract<NodeIR, { kind: "task" }>["run"]["target"] {
  const node = getNode(scope, nodeId);
  if (node.kind !== "task") throw new Error(`expected task node ${nodeId}`);
  return node.run.target;
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
