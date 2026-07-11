import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { WorkflowPreparationError, prepareWorkflow, tryPrepareWorkflow } from "@acpus/workflow-compiler";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures");

describe("workflow preparation", () => {
  it("prepares exported same-file reusable tasks with workflow-module import semantics", async () => {
    await withCompilerWorkspace("compiler-same-file-task", async cwd => {
      const workflow = await copyFixture(cwd, "workflows/same-file-reusable.workflow.ts");
      const packageLock = "lockfileVersion: '9.0'\n";
      await writeFile(join(cwd, "pnpm-lock.yaml"), packageLock);
      const prepared = await prepareWorkflow({ workflow, cwd });
      const repeated = await prepareWorkflow({ workflow, cwd });
      const sourceDigest = digest(await readFile(workflow, "utf8"));
      const packageLockDigest = digest(packageLock);

      expect(JSON.parse(prepared.irJson)).toMatchObject({ irVersion: 4, name: "same-file-reusable" });
      expect(prepared.lock.workflow.sourceDigest).toBe(sourceDigest);
      expect(prepared.packageLockDigest).toBe(packageLockDigest);
      expect(prepared.lock.packageLockDigest).toBe(packageLockDigest);
      expect(prepared.sourceGraphDigest).toBe(digest(`${sourceDigest}\n${packageLockDigest}`));
      expect(prepared.lock.sourceGraphDigest).toBe(prepared.sourceGraphDigest);
      expectSha256Digest(prepared.lock.ir.digest);
      expect(prepared.lock.ir.digest).toBe(digest(prepared.irJson));
      expect(prepared.lock).toMatchObject({
        kind: "acpus_workflow_preparation_lock",
        version: 1,
        workflow: {
          entry: "same-file-reusable.workflow.ts",
          sourceDigest: prepared.lock.workflow.sourceDigest,
        },
        ir: { path: "workflow.ir.json", digest: prepared.lock.ir.digest },
      });
      expect(repeated.irJson).toBe(prepared.irJson);
      expect(repeated.sourceGraphDigest).toBe(prepared.sourceGraphDigest);
      expect(repeated.lock).toEqual(prepared.lock);
      expect(taskTarget(prepared.ir, "normalize_path")).toMatchObject({
        kind: "module",
        specifier: "./same-file-reusable.workflow.ts",
        exportName: "normalizePath",
        referrer: { path: expect.stringContaining("same-file-reusable.workflow.ts") },
      });
      expect(prepared.ir.outputs.normalized).toEqual({ kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] });
    });
  });

  it("prepares reusable tasks imported from a real package export", async () => {
    await withCompilerWorkspace("compiler-package-task", async cwd => {
      await writePackageTask(cwd);
      const workflow = join(cwd, "package-task.workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";
import { packageTask } from "fixture-task-package/tasks";

export default defineWorkflow({
  name: "package-task",
  inputSchema: z.object({ value: z.string() }),
}).build(({ input, step }) => {
  const result = step("package_task").task({
    run: { task: packageTask, input: { value: input.value } },
  });
  return { value: result.output.value };
});
`);

      const prepared = await prepareWorkflow({ workflow, cwd });

      expect(prepared.ir.diagnostics).toEqual([]);
      expect(taskTarget(prepared.ir, "package_task")).toMatchObject({
        kind: "module",
        specifier: "fixture-task-package/tasks",
        exportName: "packageTask",
        referrer: { path: "package-task.workflow.ts" },
      });
    });
  });

  it("returns typed check failures without throwing", async () => {
    await withCompilerWorkspace("compiler-task-check-result", async cwd => {
      const inlineCapture = await copyFixture(cwd, "workflows/inline-capture.workflow.ts");
      const result = await tryPrepareWorkflow({ workflow: inlineCapture, cwd });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected check failure");
      if (result.error.type !== "check-failed") throw new Error("expected typed check failure");
      expect(result.error.type).toBe("check-failed");
      expect(result.error.phase).toBe("check");
      expect(result.error.diagnostics).toContainEqual(expect.objectContaining({
        code: "TB003",
        source: expect.objectContaining({ file: expect.stringContaining("inline-capture.workflow.ts") }),
        hint: expect.stringContaining("run.input"),
      }));
    });
  });

  it("returns validation diagnostics for compiled invalid IR", async () => {
    await withCompilerWorkspace("compiler-validate", async cwd => {
      const workflow = await copyFixture(cwd, "workflows/basic/malformed.workflow.ts");
      const failure = await expectPreparationFailure(workflow, cwd);
      expect(failure.phase).toBe("validate");
      if (failure.phase !== "validate") throw new Error("expected validate failure");
      expect(failure.diagnostics).toContainEqual(expect.objectContaining({ code: "ID001", severity: "error" }));
    });
  });
});

function expectSha256Digest(value: string): void {
  expect(value).toMatch(/^sha256:[a-f0-9]{64}$/);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function expectPreparationFailure(workflow: string, cwd: string): Promise<WorkflowPreparationFailure> {
  try {
    await prepareWorkflow({ workflow, cwd });
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowPreparationError);
    return (error as WorkflowPreparationError).failure;
  }
  throw new Error("expected workflow preparation to fail");
}

function fixture(relativePath: string): string {
  return join(fixturesRoot, relativePath);
}

function taskTarget(ir: WorkflowIR, id: string): Extract<WorkflowIR["root"]["nodes"][number], { kind: "task" }>["run"]["target"] {
  const node = ir.root.nodes.find(item => item.id === id);
  if (!node || node.kind !== "task") throw new Error(`expected task node ${id}`);
  return node.run.target;
}

async function copyFixture(cwd: string, relativePath: string): Promise<string> {
  const target = join(cwd, basename(relativePath).replace(/\.fixture$/, ".ts"));
  await copyFile(fixture(relativePath), target);
  return target;
}

async function writePackageTask(cwd: string): Promise<void> {
  const root = join(cwd, "node_modules", "fixture-task-package");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture-task-package",
    type: "module",
    exports: {
      "./tasks": "./tasks.ts",
    },
  }, null, 2));
  await writeFile(join(root, "tasks.ts"), `import { task, z } from "acpus/core";

export const packageTask = task.define({
  inputSchema: z.object({ value: z.string() }),
  exec: async ({ input }) => ({ value: input.value }),
});
`);
}

async function withCompilerWorkspace<T>(name: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await symlink(join(repoRoot, "node_modules"), join(cwd, "node_modules"), "dir");
    await linkWorkspaceCore(cwd);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function linkWorkspaceCore(cwd: string): Promise<void> {
  await mkdir(join(cwd, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(cwd, "packages", "core"), "dir");
}
