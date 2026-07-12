import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { WorkflowPreparationError, prepareWorkflow, tryPrepareWorkflow } from "@acpus/workflow-compiler";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures");

describe("workflow preparation", () => {
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
        hint: expect.stringContaining("top-level input"),
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
