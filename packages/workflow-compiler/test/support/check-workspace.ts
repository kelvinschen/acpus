import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflow } from "../../src/check/runner.js";
import { createScratchDir } from "../../src/preflight/temp.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export type WorkflowCheck = Awaited<ReturnType<typeof checkWorkflow>>;

export async function runCheck(
  cwd: string,
  workflowSource: string,
  files: Record<string, string> = {},
): Promise<WorkflowCheck> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const workflow = join(cwd, "workflow.ts");
  await writeFile(workflow, workflowSource);
  const scratchDir = await createScratchDir();
  try {
    return await checkWorkflow(workflow, cwd, scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function withCheckWorkspace<T>(name: string, fn: (cwd: string) => Promise<T>): Promise<T> {
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
