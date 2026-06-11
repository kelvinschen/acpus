import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface WorkflowSourcePolicy {
  allowedSourceRoots: string[];
  createIncludeResolver: (defaultSourcePath?: string) => (path: string, fromPath?: string) => string;
  isAllowedSourcePath: (path: string) => boolean;
  validateSourcePath: (path: string) => string;
}

export function globalWorkflowRoot(): string {
  return resolve(homedir(), ".acpus", "workflows");
}

export function createIncludeResolver(
  allowedSourceRoots?: string[],
  defaultSourcePath?: string
): (path: string, fromPath?: string) => string {
  const allowedRoots = realExistingRoots(allowedSourceRoots?.map((root) => resolve(root)) ?? []);
  const defaultBaseDir = defaultSourcePath ? dirname(resolve(defaultSourcePath)) : process.cwd();
  return createIncludeResolverFromBase(allowedRoots, defaultBaseDir);
}

export function workflowSourcePolicy(workspace = process.cwd()): WorkflowSourcePolicy {
  const workspaceRoot = resolve(workspace);
  const allowedSourceRoots = [workspaceRoot, globalWorkflowRoot()];

  return {
    allowedSourceRoots,
    createIncludeResolver: (defaultSourcePath) => createIncludeResolverFromBase(
      realExistingRoots(allowedSourceRoots),
      defaultSourcePath ? dirname(resolve(defaultSourcePath)) : workspaceRoot
    ),
    isAllowedSourcePath: (path) => {
      const realPath = realPathOrUndefined(resolve(path));
      return realPath !== undefined && isInsideAnyRoot(realPath, realExistingRoots(allowedSourceRoots));
    },
    validateSourcePath: (path) => {
      const resolved = resolve(path);
      const realPath = realPathOrUndefined(resolved);
      if (realPath === undefined) {
        throw new Error("sourcePath must exist and be readable");
      }
      if (!isInsideAnyRoot(realPath, realExistingRoots(allowedSourceRoots))) {
        throw new Error("sourcePath must be within the workspace or global Workflow Catalog");
      }
      return realPath;
    }
  };
}

function createIncludeResolverFromBase(
  allowedRoots: string[],
  defaultBaseDir: string
): (path: string, fromPath?: string) => string {
  return (includePath, fromPath) => {
    const baseDir = fromPath ? dirname(resolve(fromPath)) : defaultBaseDir;
    const resolved = resolve(baseDir, includePath);
    const realPath = realPathOrUndefined(resolved);
    if (realPath === undefined) {
      throw new Error(`Include path '${includePath}' does not exist or is not readable`);
    }
    if (allowedRoots.length > 0 && !isInsideAnyRoot(realPath, allowedRoots)) {
      throw new Error(`Include path '${includePath}' resolves outside allowed Workflow Spec roots`);
    }
    return readFileSync(realPath, "utf8");
  };
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function realExistingRoots(roots: string[]): string[] {
  return roots.flatMap((root) => {
    const realRoot = realPathOrUndefined(root);
    return realRoot === undefined ? [] : [realRoot];
  });
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}
