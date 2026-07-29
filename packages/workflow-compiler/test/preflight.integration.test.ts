import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import {
  WorkflowPreparationError,
  prepareWorkflow,
  tryPrepareWorkflow,
} from "@acpus/workflow-compiler";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures");
const scratchDirectories = vi.hoisted((): string[] => []);

vi.mock("../src/preflight/temp.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/preflight/temp.js")>();
  return {
    ...original,
    createScratchDir: async (): Promise<string> => {
      const path = await original.createScratchDir();
      scratchDirectories.push(path);
      return path;
    },
  };
});

describe("workflow preparation", () => {
  it.concurrent("returns typed check failures without throwing", async () => {
    await withCompilerWorkspace("compiler-task-check-result", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/inline-capture.workflow.ts");
      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected check failure");
      if (result.error.type !== "check-failed") throw new Error("expected typed check failure");
      expect(result.error.phase).toBe("check");
      expect(result.error.diagnostics).toContainEqual(expect.objectContaining({
        code: "TB003",
        source: expect.objectContaining({ file: expect.stringContaining("inline-capture.workflow.ts") }),
        hint: expect.stringContaining("through Task input"),
      }));
    });
  });

  it.concurrent("returns validation diagnostics for compiled invalid IR", async () => {
    await withCompilerWorkspace("compiler-validate", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/basic/malformed.workflow.ts");
      const failure = await expectPreparationFailure(workflow, workspaceDir);
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

  it.concurrent("retains the typed compile worker failure", async () => {
    await withCompilerWorkspace("compiler-worker-result", async workspaceDir => {
      const workflow = join(workspaceDir, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

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

  it.concurrent("rejects a live workspace entry that changes while it is compiling", async () => {
    await withCompilerWorkspace("compiler-source-generation", async workspaceDir => {
      const workflow = join(workspaceDir, "workflow.ts");
      const changedSource = `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "changed" }).build(() => ({}));
`;
      const checkedSource = `import { writeFileSync } from "node:fs";
import { defineWorkflow } from "acpus/core";
writeFileSync(${JSON.stringify(workflow)}, ${JSON.stringify(changedSource)});
export default defineWorkflow({ name: "checked" }).build(() => ({}));
`;
      await writeFile(workflow, checkedSource);

      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

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

  it.concurrent("keeps workspace paths live without an inline bundle", async () => {
    await withCompilerWorkspace("compiler-workspace-source", async workspaceDir => {
      const workflow = join(workspaceDir, "workflow.ts");
      await writeFile(workflow, workflowSource("workspace-source"));

      const prepared = await prepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(prepared.source).toEqual({ kind: "workspace", entry: "workflow.ts" });
      expect("sourceBundle" in prepared).toBe(false);
      expect(prepared.lock).toMatchObject({
        kind: "acpus_workflow_preparation_lock",
        version: 2,
        workflow: {
          source: { kind: "workspace", entry: "workflow.ts" },
          entryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
    });
  });

  it.concurrent("captures a sparse external static module closure across parent directories", async () => {
    await withCompilerWorkspace("compiler-external-workspace", async workspaceDir => {
      const external = await mkdtemp(join(tmpdir(), "compiler-external-source-"));
      try {
        await Promise.all([
          mkdir(join(external, "flows")),
          mkdir(join(external, "tasks")),
          mkdir(join(external, "types")),
        ]);
        await writeFile(join(external, "package.json"), `${JSON.stringify({
          type: "module",
          imports: {
            "#slug": "./tasks/slug.ts",
            "#slash": "slash",
          },
        })}\n`);
        await writeFile(join(external, "unrelated.ts"), "throw new Error('must not be captured');\n");
        await writeFile(
          join(external, "flows", "workflow.ts"),
          `import type { DeclaredOnly } from "../types/declared-only.js";
void (null as DeclaredOnly | null);
${(await readFile(fixture("workflows/nested-reusable.workflow.ts"), "utf8"))
    .replaceAll("./tasks/", "../tasks/")}`,
        );
        await Promise.all([
          writeFile(
            join(external, "tasks", "local-dependency.task.ts"),
            (await readFile(fixture("workflows/tasks/local-dependency.task.ts"), "utf8"))
              .replace("./slug.js", "#slug"),
          ),
          writeFile(
            join(external, "tasks", "node-module-dependency.task.ts"),
            (await readFile(fixture("workflows/tasks/node-module-dependency.task.ts"), "utf8"))
              .replace('"slash"', '"#slash"'),
          ),
          copyFile(
            fixture("workflows/tasks/slug.ts"),
            join(external, "tasks", "slug.ts"),
          ),
          writeFile(
            join(external, "types", "declared-only.d.ts"),
            "export type DeclaredOnly = { ok: true };\n",
          ),
        ]);

        const scratchIndex = scratchDirectories.length;
        const prepared = await prepareWorkflow(pathOptions(
          workspaceDir,
          join(external, "flows", "workflow.ts"),
        ));

        expect(prepared.source).toEqual({
          kind: "snapshot",
          entry: "flows/workflow.ts",
          digest: prepared.sourceGraphDigest,
        });
        if (prepared.source.kind !== "snapshot") throw new Error("expected snapshot source");
        const bundle = prepared.sourceBundle;
        if (!bundle) throw new Error("expected snapshot bundle");
        expect(bundle.files.map(file => file.path)).toEqual([
          "flows/workflow.ts",
          "package.json",
          "tasks/local-dependency.task.ts",
          "tasks/node-module-dependency.task.ts",
          "tasks/slug.ts",
          "types/declared-only.d.ts",
        ]);
        expect(prepared.ir.diagnostics).toContainEqual(expect.objectContaining({
          code: "SC001",
          severity: "warning",
          source: expect.objectContaining({ file: "flows/workflow.ts", line: 1 }),
        }));
        expect(JSON.stringify(prepared)).not.toContain(external);
        expectNoScratchReference(prepared, scratchDirectories.slice(scratchIndex));
        expect(bundle.files.every(file => !file.path.includes("node_modules"))).toBe(true);
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });

  it.concurrent("keeps package locks out of source graph identity", async () => {
    const prepareWithLock = (name: string, lockContent: string) =>
      withCompilerWorkspace(name, async workspaceDir => {
        const workflow = join(workspaceDir, "workflow.ts");
        await writeFile(workflow, workflowSource("lock-metadata"));
        await writeFile(join(workspaceDir, "pnpm-lock.yaml"), lockContent);
        return prepareWorkflow(pathOptions(workspaceDir, workflow));
      });
    const [first, second] = await Promise.all([
      prepareWithLock("compiler-lock-metadata-a", "lockfileVersion: '9.0'\n"),
      prepareWithLock("compiler-lock-metadata-b", "lockfileVersion: '9.1'\n"),
    ]);

    expect(first.sourceGraphDigest).toBe(second.sourceGraphDigest);
    expect(first.packageLockDigest).not.toBe(second.packageLockDigest);
    expect(first.lock.workflow.source).toEqual(second.lock.workflow.source);
  });

  it("rejects private materialization paths in snapshot IR and removes scratch", async () => {
    await withCompilerWorkspace("compiler-snapshot-failure-paths", async workspaceDir => {
      const scratchIndex = scratchDirectories.length;
      const result = await tryPrepareWorkflow({
        workspaceDir,
        source: {
          kind: "files",
          entry: "workflow.ts",
          files: [
            { path: "package.json", content: "{\"type\":\"module\"}\n" },
            {
              path: "workflow.ts",
              content: `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({
  name: "private-materialization",
  description: import.meta.url,
}).build(() => ({}));
`,
            },
          ],
        },
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source failure");
      expect(result.error).toEqual({
        type: "source-invalid",
        phase: "source",
        message: "Snapshot workflow IR must not reference the compiler's private source materialization.",
      });
      const scratch = scratchDirectories.slice(scratchIndex);
      expect(scratch).toHaveLength(1);
      expectNoScratchReference(result.error, scratch);
      await expect(stat(scratch[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

function pathOptions(workspaceDir: string, entry: string) {
  return {
    workspaceDir,
    source: { kind: "path" as const, entry },
  };
}

async function expectPreparationFailure(
  workflow: string,
  workspaceDir: string,
): Promise<WorkflowPreparationFailure> {
  try {
    await prepareWorkflow(pathOptions(workspaceDir, workflow));
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowPreparationError);
    return (error as WorkflowPreparationError).failure;
  }
  throw new Error("expected workflow preparation to fail");
}

function workflowSource(name: string): string {
  return `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({}));
`;
}

function fixture(relativePath: string): string {
  return join(fixturesRoot, relativePath);
}

function expectNoScratchReference(value: unknown, paths: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const path of paths) {
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(pathToFileURL(path).href);
  }
}

async function copyFixture(workspaceDir: string, relativePath: string): Promise<string> {
  const target = join(workspaceDir, basename(relativePath).replace(/\.fixture$/, ".ts"));
  await copyFile(fixture(relativePath), target);
  return target;
}

async function withCompilerWorkspace<T>(
  name: string,
  fn: (workspaceDir: string) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await symlink(join(repoRoot, "node_modules"), join(workspaceDir, "node_modules"), "dir");
    await linkWorkspaceCore(workspaceDir);
    return await fn(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function linkWorkspaceCore(workspaceDir: string): Promise<void> {
  await mkdir(join(workspaceDir, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(workspaceDir, "packages", "core"), "dir");
}
