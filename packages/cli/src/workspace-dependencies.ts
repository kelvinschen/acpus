import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";

export async function exposeWorkspaceDependencies(tempRoot: string, workspace: string): Promise<void> {
  const source = join(workspace, "node_modules");
  try {
    const info = await lstat(source);
    if (!info.isDirectory() && !info.isSymbolicLink()) return;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await symlink(source, join(tempRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
