import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  tryCompileWorkflowModule,
  type CompiledWorkflowModule,
} from "../src/compiler/module.js";
import { walkNodes, type NodeIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const compilerEntry = new URL("../src/compiler/module.ts", import.meta.url).href;

describe.concurrent("workflow module compiler", () => {
  it("compiles a TypeScript workflow module with reusable module references and inline task source", async () => {
    const compiled = await compileFixtureResult("release.workflow.ts");
    const { ir } = compiled;

    expect(ir.irVersion).toBe(4);
    expect(ir.name).toBe("release-readiness");
    expect(ir.diagnostics).toEqual([]);
    expect(compiled.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir).not.toHaveProperty("lock");
    expect(taskTarget(ir.root, "normalize_package")).toMatchObject({
      kind: "module",
      specifier: "./tasks/local-dependency.task.js",
      exportName: "default",
      referrer: { path: expect.stringContaining("release.workflow.ts") },
    });
    expect(taskTarget(ir.root, "normalize_path")).toMatchObject({
      kind: "module",
      specifier: "./tasks/node-module-dependency.task.js",
      exportName: "default",
    });
    expect(taskTarget(ir.root, "prepare_release")).toMatchObject({ kind: "inline", source: expect.any(String) });
    expect(taskTarget(ir.root, "run_tests")).toMatchObject({ kind: "inline", source: expect.any(String) });
  });

  it("applies reusable module metadata to nested tasks in structural order", async () => {
    const ir = await compileFixture("nested-reusable.workflow.ts");

    expect(ir.diagnostics).toEqual([]);
    expect(Array.from(walkNodes(ir.root)).flatMap(({ node }) => {
      if (node.kind !== "task" || node.run.target.kind !== "module") return [];
      return [{
        nodeId: node.id,
        target: {
          kind: node.run.target.kind,
          specifier: node.run.target.specifier,
          exportName: node.run.target.exportName,
          referrerPath: node.run.target.referrer.path,
        },
      }];
    })).toEqual([
      {
        nodeId: "nested_local",
        target: {
          kind: "module",
          specifier: "./tasks/local-dependency.task.js",
          exportName: "default",
          referrerPath: "packages/workflow-compiler/test/fixtures/workflows/nested-reusable.workflow.ts",
        },
      },
      {
        nodeId: "nested_node_module",
        target: {
          kind: "module",
          specifier: "./tasks/node-module-dependency.task.js",
          exportName: "default",
          referrerPath: "packages/workflow-compiler/test/fixtures/workflows/nested-reusable.workflow.ts",
        },
      },
    ]);
  });

  it("keeps the internal module compiler free of the authoring check phase", async () => {
    const ir = await compileFixture("inline-capture.workflow.ts");

    expect(ir.diagnostics).not.toContainEqual(expect.objectContaining({ code: "TB003" }));
    expect(ir.diagnostics).toEqual([]);
  });

  it("compiles exported same-file reusable tasks as live workflow module references", async () => {
    const ir = await compileFixture("same-file-reusable.workflow.ts");

    expect(ir.diagnostics).toEqual([]);
    expect(taskTarget(ir.root, "normalize_path")).toMatchObject({
      kind: "module",
      specifier: "./same-file-reusable.workflow.ts",
      exportName: "normalizePath",
      referrer: { path: expect.stringContaining("same-file-reusable.workflow.ts") },
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
    const first = await compileModuleResult(entry);
    const second = await compileModuleResult(entry);

    expect(second).toEqual(first);
    expect(JSON.stringify(second.ir, null, 2)).toBe(JSON.stringify(first.ir, null, 2));
  });

  it("resolves reusable tasks from a generic package exports subpath", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-package-subpath-"));
    try {
      const nodeModules = join(cwd, "node_modules");
      const packageRoot = join(nodeModules, "fixture-task-package");
      await mkdir(packageRoot, { recursive: true });
      await symlink(join(repoRoot, "packages", "cli"), join(nodeModules, "acpus"), "dir");
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({
        name: "fixture-task-package",
        type: "module",
        exports: { "./tasks": "./tasks.ts" },
      }));
      await writeFile(join(packageRoot, "tasks.ts"), `import { task, z } from "acpus/core";
export const packageTask = task.define({
  inputSchema: z.object({ value: z.string() }),
  exec: async ({ input }) => ({ value: input.value }),
});
`);
      const workflow = join(cwd, "package-task.workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";
import { packageTask } from "fixture-task-package/tasks";
export default defineWorkflow({
  name: "package-task",
  inputSchema: z.object({ value: z.string() }),
}).build(({ input, step }) => {
  const result = step("package_task").task({ task: packageTask, input: { value: input.value } });
  return { value: result.output.value };
});
`);

      const ir = await compileModule(workflow, cwd);
      expect(taskTarget(ir.root, "package_task")).toMatchObject({
        kind: "module",
        specifier: "fixture-task-package/tasks",
        exportName: "packageTask",
        referrer: { path: "package-task.workflow.ts" },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns tagged errors for invalid workflow module exports", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-invalid-export-"));
    try {
      const workflow = join(cwd, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await tryCompileWorkflowModule(workflow, cwd);

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

  it("imports a TypeScript workflow directly without project loader setup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-direct-import-"));
    try {
      const workflow = join(cwd, "workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, task, z } from "acpus/core";

export const noop = task.define({
  inputSchema: z.object({}),
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "direct-import",
  inputSchema: z.object({}),
}).build(({ step }) => {
  const result = step("run").task({ task: noop, input: {} });
  return { ok: result.output.ok };
});
`);

      const stdout = await runCompilerScript(`
import { tryCompileWorkflowModule } from ${JSON.stringify(compilerEntry)};

const result = await tryCompileWorkflowModule(${JSON.stringify(workflow)}, ${JSON.stringify(cwd)});
if (result.isErr()) throw new Error(result.error.message);
const node = result.value.ir.root.nodes.find(item => item.id === "run");
console.log(JSON.stringify({ name: result.value.ir.name, target: node.run.target }));
`);

      const result = JSON.parse(stdout) as { name: string; target: unknown };
      expect(result.name).toBe("direct-import");
      expect(result.target).toMatchObject({
        kind: "module",
        specifier: "./workflow.ts",
        exportName: "noop",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns tagged errors for workflows outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-outside-workspace-"));
    try {
      const workflow = fixture("release.workflow.ts");
      const result = await tryCompileWorkflowModule(workflow, cwd);

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

      const result = await tryCompileWorkflowModule(workflow, cwd);

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

    const fanout = getNode(ir.root, "lanes");
    expect(fanout).toMatchObject({
      kind: "fanout",
      over: { kind: "ref", path: ["input", "lanes"] },
      do: {
        outputs: {
          lane: {
            kind: "ref",
            path: ["fanout", "lanes", "item", "id"],
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
          outputs: {
            ok: { kind: "ref", path: ["nodes", "review_lane", "output", "ok"] },
          },
        },
        route: {
          outputs: {
            route: {
              kind: "ref",
              path: ["nodes", "route_lane", "output", "route"],
            },
          },
        },
      },
    });
    if (parallel?.kind !== "parallel") throw new Error("expected parallel fixture node");

    const repairBranch = parallel.branches.repair;
    if (!repairBranch) throw new Error("expected repair branch fixture node");
    const loop = getNode(repairBranch, "repair_loop");
    expect(loop).toMatchObject({
      kind: "loop",
      state: {
        kind: "object",
        fields: {
          branch: { kind: "literal", value: "" },
          continue: { kind: "literal", value: true },
          summary: { kind: "literal", value: "" },
        },
      },
      do: {
        outputs: {
          stop: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["nodes", "repair_round", "output", "continue"] },
              { kind: "ref", path: ["loop", "repair_loop", "round"] },
              { kind: "literal", value: expect.any(String) },
            ],
          },
        },
      },
    });
    if (loop?.kind !== "loop") throw new Error("expected loop fixture node");

    expect(getNode(loop.do, "repair_round")).toMatchObject({
      kind: "agent",
      run: {
        prompt: {
          kind: "template",
          parts: expect.arrayContaining([
            {
              kind: "expr",
              expr: {
                kind: "ref",
                path: ["loop", "repair_loop", "state", "summary"],
              },
            },
          ]),
        },
      },
    });

    const routeBranch = parallel.branches.route;
    if (!routeBranch) throw new Error("expected route branch fixture node");
    const routeSwitch = getNode(routeBranch, "route_lane");
    expect(routeSwitch).toMatchObject({
      kind: "switch",
      cases: [
        {
          when: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["fanout", "lanes", "item", "mode"] },
              { kind: "literal", value: expect.any(String) },
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
  return (await compileFixtureResult(relativePath)).ir;
}

async function compileFixtureResult(relativePath: string): Promise<CompiledWorkflowModule> {
  return compileModuleResult(fixture(relativePath));
}

async function compileModule(entry: string, cwd = repoRoot): Promise<WorkflowIR> {
  return (await compileModuleResult(entry, cwd)).ir;
}

async function compileModuleResult(entry: string, cwd = repoRoot): Promise<CompiledWorkflowModule> {
  const result = await tryCompileWorkflowModule(entry, cwd);
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

function fixture(relativePath: string): string {
  return fileURLToPath(new URL(`./fixtures/workflows/${relativePath}`, import.meta.url));
}

async function runCompilerScript(script: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--conditions=development",
    "--import",
    tsxImport,
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: repoRoot });
  return result.stdout.trim();
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
