import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dependencyAuthorities = new Map<string, string>();

export function registerDependencyAuthority(options: {
  parentURL: string;
  sourceRoot?: string;
  dependencyRoot?: string;
}): void {
  if (!options.dependencyRoot || !options.parentURL.startsWith("file:")) return;
  const sourceRoot = canonicalPath(options.sourceRoot ?? dirname(fileURLToPath(options.parentURL)));
  dependencyAuthorities.set(sourceRoot, dependencyParentURL(options.dependencyRoot));
}

export function dependencyAuthority(parentURL: string): { sourceRoot: string; dependencyParentURL: string } | undefined {
  if (!parentURL.startsWith("file:")) return undefined;
  const parentPath = canonicalPath(fileURLToPath(parentURL));
  let closest: { sourceRoot: string; dependencyParentURL: string } | undefined;
  for (const [sourceRoot, dependencyParentURL] of dependencyAuthorities) {
    if (isContainedPath(sourceRoot, parentPath) && (!closest || sourceRoot.length > closest.sourceRoot.length)) {
      closest = { sourceRoot, dependencyParentURL };
    }
  }
  return closest;
}

export function dependencyParentURL(root: string): string {
  return pathToFileURL(join(canonicalPath(root), "__acpus_dependency_authority__.mjs")).href;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return resolve(path);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isMissingPathError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
