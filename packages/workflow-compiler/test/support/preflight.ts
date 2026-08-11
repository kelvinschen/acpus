import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import {
  WorkflowPreparationError,
  prepareWorkflow,
} from "@acpus/workflow-compiler";
import { expect } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const fixturesRoot = join(repoRoot, "packages", "workflow-compiler", "test", "fixtures");

export function pathOptions(workspaceDir: string, entry: string) {
  return {
    workspaceDir,
    source: { kind: "path" as const, entry },
  };
}

export async function expectPreparationFailure(
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

export function workflowSource(name: string): string {
  return `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({}));
`;
}

export function fixture(relativePath: string): string {
  return join(fixturesRoot, relativePath);
}

export function expectNoScratchReference(value: unknown, paths: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const path of paths) {
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(pathToFileURL(path).href);
  }
}

export async function copyFixture(workspaceDir: string, relativePath: string): Promise<string> {
  const target = join(workspaceDir, basename(relativePath).replace(/\.fixture$/, ".ts"));
  await copyFile(fixture(relativePath), target);
  return target;
}

export async function withCompilerWorkspace<T>(
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
