import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { WorkflowPreparationError, prepareWorkflow, writePreflightArtifact } from "@acpus/workflow-compiler";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures");

describe("workflow preflight preparation", () => {
  it("writes frozen preflight artifacts for valid workflows", async () => {
    await withCompilerWorkspace("compiler-preflight", async cwd => {
      const workflow = await copyFixture(cwd, "workflows/tasks/task-artifact.workflow.ts");
      const prepared = await prepareWorkflow({ workflow, cwd });
      const artifact = await writePreflightArtifact(prepared, cwd);

      const ir = JSON.parse(await readFile(join(artifact.dir, "workflow.ir.json"), "utf8")) as WorkflowIR;
      const lock = JSON.parse(await readFile(join(artifact.dir, "lock.json"), "utf8"));
      expect(ir.name).toBe("cli-task");
      expectSha256Digest(prepared.irDigest);
      expectSha256Digest(prepared.sourceGraphDigest);
      expect(lock).toMatchObject({
        kind: "acpus_preflight_lock",
        version: 1,
        ir: { path: "workflow.ir.json", digest: prepared.irDigest },
      });
      const bundleId = Object.keys(ir.assets.taskBundles)[0];
      expect(bundleId).toBeDefined();
      await access(join(artifact.dir, "task-bundles", `${bundleId}.mjs`));
    });
  });

  it("prepares exported same-file reusable tasks with workflow-module import semantics", async () => {
    await withCompilerWorkspace("compiler-same-file-task", async cwd => {
      const workflow = await copyFixture(cwd, "workflows/same-file-reusable.workflow.ts");
      const prepared = await prepareWorkflow({ workflow, cwd });
      const bundle = Object.values(prepared.ir.assets.taskBundles).find(item => item.sourceFile?.endsWith("same-file-reusable.workflow.ts"));

      expect(bundle).toMatchObject({
        inline: false,
        sourceFile: expect.stringContaining("same-file-reusable.workflow.ts"),
      });
      expect(bundle?.source?.length).toBeGreaterThan(0);
      expect(bundle?.source).not.toMatch(/from\s+["']slash["']/);
      expect(bundle?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expectSha256Digest(prepared.sourceGraphDigest);
      expect(prepared.ir.outputs.normalized).toEqual({ kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] });
    });
  });

  it("fails before compile and preserves check diagnostics", async () => {
    await withCompilerWorkspace("compiler-task-check", async cwd => {
      const inlineCapture = await copyFixture(cwd, "workflows/inline-capture.workflow.ts");
      const inlineFailure = await expectPreparationFailure(inlineCapture, cwd);
      expect(inlineFailure.phase).toBe("check");
      if (inlineFailure.phase !== "check") throw new Error("expected inline capture check failure");
      expect(inlineFailure.diagnostics).toContainEqual(expect.objectContaining({
        code: "TB007",
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

async function copyFixture(cwd: string, relativePath: string): Promise<string> {
  const target = join(cwd, basename(relativePath).replace(/\.fixture$/, ".ts"));
  await copyFile(fixture(relativePath), target);
  return target;
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
