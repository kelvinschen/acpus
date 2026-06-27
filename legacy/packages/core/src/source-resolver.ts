import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Core helper to resolve Workflow Spec source paths and read include content.
 *
 * Validates that source and include paths exist and are readable by resolving
 * real filesystem paths (including symlink resolution). The resolved real paths
 * are returned so callers can use them for subsequent operations (cycle guards,
 * compilation, etc.).
 *
 * Unlike the previous `WorkflowSourcePolicy`, this resolver does not restrict
 * paths to workspace or global catalog roots — any readable filesystem path is
 * accepted. Catalog discovery scope remains constrained; file references from
 * discovered specs are not constrained by those roots.
 */
export interface WorkflowSourceResolver {
  createIncludeResolver: (defaultSourcePath?: string) => (path: string, fromPath?: string) => string;
  validateSourcePath: (path: string) => string;
}

export function globalWorkflowRoot(): string {
  return resolve(homedir(), ".acpus", "workflows");
}

export function createIncludeResolver(
  defaultSourcePath?: string
): (path: string, fromPath?: string) => string {
  const defaultBaseDir = defaultSourcePath ? dirname(resolve(defaultSourcePath)) : process.cwd();
  return createIncludeResolverFromBase(defaultBaseDir);
}

export function workflowSourceResolver(workspace = process.cwd()): WorkflowSourceResolver {
  return {
    createIncludeResolver: (defaultSourcePath) => createIncludeResolverFromBase(
      defaultSourcePath ? dirname(resolve(defaultSourcePath)) : resolve(workspace)
    ),
    validateSourcePath: (path) => {
      const resolved = resolve(path);
      const realPath = realPathOrUndefined(resolved);
      if (realPath === undefined) {
        throw new Error("sourcePath does not exist or is not readable");
      }
      return realPath;
    }
  };
}

function createIncludeResolverFromBase(
  defaultBaseDir: string
): (path: string, fromPath?: string) => string {
  return (includePath, fromPath) => {
    const baseDir = fromPath ? dirname(resolve(fromPath)) : defaultBaseDir;
    const resolved = resolve(baseDir, includePath);
    const realPath = realPathOrUndefined(resolved);
    if (realPath === undefined) {
      throw new Error(`Include path '${includePath}' does not exist or is not readable`);
    }
    return readFileSync(realPath, "utf8");
  };
}

export function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}
