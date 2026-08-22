import * as Result from "effect/Result";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import { describe, expect, it } from "vitest";
import {
  tryCompileWorkflowModule,
  type CompiledWorkflowModule,
} from "../src/compiler/module.js";
import { walkNodes, type NodeIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { settle } from "./effect.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const compilerEntry = new URL("../src/compiler/module.ts", import.meta.url).href;

describe.concurrent("workflow module compiler", () => {
  it("compiles a TypeScript workflow module with reusable module references and inline task source", async () => {
    const compiled = await compileFixtureResult("release.workflow.ts");
    const { ir } = compiled;

    expect(ir.irVersion).toBe(8);
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
    expect(ir.root.output).toMatchObject({ kind: "object", fields: { normalized: { kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] } } });
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

      const result = await settle(tryCompileWorkflowModule(workflow, cwd, await compileOptions(workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected invalid default export");
      expect(result.failure).toEqual({
        type: "invalid-default-export",
        entry: workflow,
        message: `Default export of ${workflow} is not an Acpus workflow definition.`,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a changed source before importing the workflow module", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-source-generation-"));
    try {
      const marker = join(cwd, "imported");
      const workflow = join(cwd, "workflow.ts");
      const source = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default {};
`;
      await writeFile(workflow, source);

      const result = await settle(tryCompileWorkflowModule(workflow, cwd, {
        expectedSourceDigest: sha256Digest(`${source}\nchanged`),
      }));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected source generation failure");
      expect(result.failure).toMatchObject({
        type: "workflow-source-changed",
        entry: workflow,
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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
  inputSchema: z.string(),
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "direct-import",
  inputSchema: z.object({}),
}).build(({ step }) => {
  const result = step("run").task({ task: noop, input: "value" });
  return { ok: result.output.ok };
});
`);

      const stdout = await runCompilerScript(`
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { tryCompileWorkflowModule } from ${JSON.stringify(compilerEntry)};

const result = await Effect.runPromise(Effect.result(tryCompileWorkflowModule(${JSON.stringify(workflow)}, ${JSON.stringify(cwd)}, {
  expectedSourceDigest: ${JSON.stringify(await sourceDigest(workflow))},
})));
if (Result.isFailure(result)) throw new Error(result.failure.message);
const node = result.success.ir.root.nodes.find(item => item.id === "run");
console.log(JSON.stringify({ name: result.success.ir.name, target: node.run.target }));
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
    const [cwd, outside] = await Promise.all([
      mkdtemp(join(tmpdir(), "compiler-source-root-")),
      mkdtemp(join(tmpdir(), "compiler-outside-workspace-")),
    ]);
    try {
      const workflow = join(outside, "throws.workflow.ts");
      const marker = join(outside, "imported");
      await writeFile(workflow, `import { writeFileSync } from "node:fs";
import { defineWorkflow } from "acpus/core";
writeFileSync(${JSON.stringify(marker)}, "executed");

export default defineWorkflow({ name: "outside" }).build(() => {
  throw new Error("build callback must not win source containment");
});
`);
      const result = await settle(tryCompileWorkflowModule(workflow, cwd, await compileOptions(workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected outside workspace failure");
      expect(result.failure).toMatchObject({
        type: "workflow-outside-workspace",
        workflowFile: workflow,
        cwd,
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("accepts contained workflow names that begin with two dots", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-dot-prefix-"));
    try {
      const workflow = join(cwd, "..workflow.ts");
      await writeFile(workflow, `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "dot_prefix" }).build(() => ({}));
`);

      const result = await settle(tryCompileWorkflowModule(workflow, cwd, await compileOptions(workflow)));

      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) throw new Error(result.failure.message);
      expect(result.success.ir.name).toBe("dot_prefix");
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

      const result = await settle(tryCompileWorkflowModule(workflow, cwd, await compileOptions(workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected workflow build failure");
      expect(result.failure).toMatchObject({
        type: "workflow-build-failed",
        entry: workflow,
        message: expect.stringContaining("boom"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails compilation when a runtime reusable Task has no static source link", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compiler-missing-task-link-"));
    try {
      await symlink(join(repoRoot, "node_modules"), join(cwd, "node_modules"), "dir");
      const workflow = join(cwd, "missing-link.workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, task, z } from "acpus/core";

const noop = task.define({
  inputSchema: z.string(),
  exec: async () => ({ ok: true }),
});
const tasks = { noop };

export default defineWorkflow({ name: "missing-link" }).build(({ step }) => {
  step("run").task({ task: tasks.noop, input: "value" });
  return {};
});
`);

      const result = await settle(tryCompileWorkflowModule(workflow, cwd, await compileOptions(workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected missing reusable Task link");
      expect(result.failure).toMatchObject({
        type: "workflow-build-failed",
        entry: workflow,
        message: expect.stringContaining("Reusable Task node 'run' requires source link metadata"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
  const result = await settle(tryCompileWorkflowModule(entry, cwd, await compileOptions(entry)));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

async function compileOptions(entry: string) {
  return { expectedSourceDigest: await sourceDigest(entry) };
}

async function sourceDigest(entry: string): Promise<Sha256Digest> {
  return sha256Digest(await readFile(entry, "utf8"));
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
