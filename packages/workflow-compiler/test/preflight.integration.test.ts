import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
        hint: expect.stringContaining("through Task input"),
      }));
    });
  });

  it("returns validation diagnostics for compiled invalid IR", async () => {
    await withCompilerWorkspace("compiler-validate", async cwd => {
      const workflow = await copyFixture(cwd, "workflows/basic/malformed.workflow.ts");
      const failure = await expectPreparationFailure(workflow, cwd);
      expect(failure).toMatchObject({
        type: "validate-failed",
        phase: "validate",
      });
      if (failure.phase !== "validate") throw new Error("expected validate failure");
      expect(failure.diagnostics).toContainEqual(expect.objectContaining({
        code: "ID001",
        severity: "error",
        path: "root.nodes.bad id",
      }));
    });
  });

  it("retains the typed compile worker failure", async () => {
    await withCompilerWorkspace("compiler-worker-result", async cwd => {
      const workflow = join(cwd, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await tryPrepareWorkflow({ workflow, cwd });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected compile failure");
      expect(result.error).toEqual({
        type: "compile-failed",
        phase: "compile",
        message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        failure: {
          type: "invalid-default-export",
          entry: workflow,
          message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        },
      });
    });
  });

  it("rejects a workflow entry that changes while it is compiling", async () => {
    await withCompilerWorkspace("compiler-source-generation", async cwd => {
      const workflow = join(cwd, "workflow.ts");
      const changedSource = `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "changed" }).build(() => ({}));
`;
      const checkedSource = `import { writeFileSync } from "node:fs";
import { defineWorkflow } from "acpus/core";
writeFileSync(${JSON.stringify(workflow)}, ${JSON.stringify(changedSource)});
export default defineWorkflow({ name: "checked" }).build(() => ({}));
`;
      await writeFile(workflow, checkedSource);

      const result = await tryPrepareWorkflow({ workflow, cwd });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source generation failure");
      expect(result.error).toMatchObject({
        type: "compile-failed",
        phase: "compile",
        failure: {
          type: "workflow-source-changed",
          entry: workflow,
        },
      });
      expect(await readFile(workflow, "utf8")).toBe(changedSource);
    });
  });

  it("derives one contained source entry from workflow path and source identity", async () => {
    await withCompilerWorkspace("compiler-source-identity", async cwd => {
      const sourceRoot = join(cwd, "snapshot");
      const workflow = join(sourceRoot, "workflow.ts");
      await mkdir(sourceRoot);
      await writeFile(workflow, `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "source-identity" }).build(() => ({}));
`);

      const prepared = await tryPrepareWorkflow({
        workflow,
        cwd,
        sourceRoot,
        source: { kind: "global_catalog", name: "source-identity", digest: "sha256:test" },
      });

      expect(prepared.isOk()).toBe(true);
      if (prepared.isErr()) throw new Error(prepared.error.message);
      expect(prepared.value).toMatchObject({
        workflowPath: workflow,
        sourceRoot,
        source: {
          kind: "global_catalog",
          name: "source-identity",
          digest: "sha256:test",
          entry: "workflow.ts",
        },
      });
    });
  });

  it("rejects inconsistent source roots before check or compilation", async () => {
    const cwd = "/workspace";
    for (const options of [
      {
        workflow: "/snapshot/workflow.ts",
        cwd,
        source: { kind: "global_catalog" as const, name: "catalog", digest: "sha256:test" },
      },
      {
        workflow: "/outside/workflow.ts",
        cwd,
        sourceRoot: "/snapshot",
        source: { kind: "global_catalog" as const, name: "catalog", digest: "sha256:test" },
      },
      {
        workflow: "/other/workflow.ts",
        cwd,
        sourceRoot: "/other",
        source: { kind: "workspace" as const },
      },
    ]) {
      const result = await tryPrepareWorkflow(options);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source identity failure");
      expect(result.error).toMatchObject({
        type: "source-invalid",
        phase: "source",
      });
    }
  });

  it("rejects a workflow symlink that resolves outside the source root", async () => {
    const [cwd, outside] = await Promise.all([
      mkdtemp(join(tmpdir(), "compiler-source-root-")),
      mkdtemp(join(tmpdir(), "compiler-outside-source-")),
    ]);
    try {
      const target = join(outside, "workflow.ts");
      const workflow = join(cwd, "workflow.ts");
      await writeFile(target, "throw new Error('outside workflow must not be checked or executed');\n");
      await symlink(target, workflow);

      const result = await tryPrepareWorkflow({ workflow, cwd });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source containment failure");
      expect(result.error).toMatchObject({
        type: "source-invalid",
        phase: "source",
        message: expect.stringContaining("resolves outside source root"),
      });
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
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
