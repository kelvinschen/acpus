import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLayout } from "../runtime-layout.js";

export type RuntimeGenerationState = "absent" | "empty" | "complete";

export type RuntimeGenerationEntry =
  | { name: string; kind: "file" | "symbolic-link" | "other" }
  | { name: string; kind: "directory"; children: number };

export class PartialRuntimeGenerationError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`Runtime generation '${path}' is incomplete: ${detail}.`);
    this.name = "PartialRuntimeGenerationError";
  }
}

export async function inspectRuntimeGeneration(layout: RuntimeLayout): Promise<RuntimeGenerationState> {
  let root;
  try {
    root = await lstat(layout.runtimeRoot);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new PartialRuntimeGenerationError(layout.runtimeRoot, "generation root is not a regular directory");
  }

  const dirents = await readdir(layout.runtimeRoot, { withFileTypes: true });
  const hasDatabase = dirents.some(entry => entry.name === "runtime.db");
  const entries: RuntimeGenerationEntry[] = await Promise.all(dirents.map(async entry => {
    if (entry.isSymbolicLink()) return { name: entry.name, kind: "symbolic-link" as const };
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        kind: "directory" as const,
        children: hasDatabase ? 0 : (await readdir(join(layout.runtimeRoot, entry.name))).length,
      };
    }
    if (entry.isFile()) return { name: entry.name, kind: "file" as const };
    return { name: entry.name, kind: "other" as const };
  }));
  return classifyRuntimeGeneration(layout.runtimeRoot, entries);
}

export function classifyRuntimeGeneration(
  runtimeRoot: string,
  entries: RuntimeGenerationEntry[],
): Exclude<RuntimeGenerationState, "absent"> {
  const allowed = new Set(["runtime.db", "runtime.db-shm", "runtime.db-wal", "runs", "sources", "trash"]);
  const unexpected = entries.find(entry => !allowed.has(entry.name));
  if (unexpected) {
    throw new PartialRuntimeGenerationError(runtimeRoot, `unexpected entry '${unexpected.name}'`);
  }
  for (const entry of entries) {
    const directory = entry.name === "runs" || entry.name === "sources" || entry.name === "trash";
    if (directory ? entry.kind !== "directory" : entry.kind !== "file") {
      throw new PartialRuntimeGenerationError(runtimeRoot, `entry '${entry.name}' has an invalid file type`);
    }
  }

  const names = new Set(entries.map(entry => entry.name));
  if (!names.has("runtime.db")) {
    if (names.has("runtime.db-shm") || names.has("runtime.db-wal")) {
      throw new PartialRuntimeGenerationError(runtimeRoot, "SQLite sidecars exist without runtime.db");
    }
    for (const name of ["runs", "sources", "trash"]) {
      const entry = entries.find(candidate => candidate.name === name);
      if (entry?.kind === "directory" && entry.children > 0) {
        throw new PartialRuntimeGenerationError(runtimeRoot, `${name}/ contains state but runtime.db is missing`);
      }
    }
    return "empty";
  }

  const missing = ["runs", "sources", "trash"].find(name => !names.has(name));
  if (missing) {
    throw new PartialRuntimeGenerationError(runtimeRoot, `${missing}/ is missing while runtime.db exists`);
  }
  return "complete";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
