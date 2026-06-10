import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function createIncludeResolver(allowedSourceRoots?: string[]): (path: string, fromPath?: string) => string {
  const allowedRoots = allowedSourceRoots?.map((root) => resolve(root)) ?? [];
  return (includePath, fromPath) => {
    const baseDir = fromPath ? dirname(resolve(fromPath)) : process.cwd();
    const resolved = resolve(baseDir, includePath);
    if (allowedRoots.length > 0 && !allowedRoots.some((root) => resolved === root || resolved.startsWith(root + "/"))) {
      throw new Error(`Include path '${includePath}' resolves outside allowed Workflow Spec roots`);
    }
    return readTextFile(resolved);
  };
}

export function parseInput(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const possiblePath = resolve(process.cwd(), value);
  if (existsSync(possiblePath)) {
    const contents = readTextFile(possiblePath);
    if (possiblePath.endsWith(".yaml") || possiblePath.endsWith(".yml")) {
      return ensureObject(parseYaml(contents), "--input");
    }
    return ensureObject(JSON.parse(contents), "--input");
  }

  return ensureObject(JSON.parse(value), "--input");
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must resolve to an object.`);
  }
  return value as Record<string, unknown>;
}
