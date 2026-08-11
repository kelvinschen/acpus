import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { importWorkflowPackage } from "../../src/workflow/import/index.js";
import { runCli } from "../../src/program.js";
import { CaptureStream } from "./capture-stream.js";
import { repoRoot } from "./cli-runner.js";

export async function importDirect(
  workspace: string,
  source: string,
  options: { scope?: "project" | "global"; check?: boolean } = {},
) {
  return importWorkflowPackage({
    cwd: workspace,
    source,
    scope: options.scope ?? "project",
    check: options.check ?? false,
  });
}

export async function runImportText(
  workspace: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

export function workflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    `export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}

export async function readNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function projectImportRoot(workspace: string): string {
  return join(workspace, ".acpus", "tmp");
}

export function globalImportRoot(home: string): string {
  return join(home, ".acpus", "tmp", "workflow-imports");
}

export async function withTestHome<T>(name: string, fn: (home: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, `${name}-`));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
