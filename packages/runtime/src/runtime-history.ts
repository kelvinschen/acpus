import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isGenerationId,
  resolveRuntimeLayoutAtWorkspace,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
  validateRuntimeLayoutBoundary,
  type RuntimeLayout,
  type RuntimeLayoutOptions,
} from "./runtime-layout.js";
import {
  H1_RUN_INDEX_STORAGE_VERSION,
  readGenerationMetadataForRecovery,
  readRunIndex,
  RuntimeMetadataFormatError,
  type ArchivedRunSummary,
} from "./storage/generation-metadata.js";

export type RuntimeGenerationSummary = {
  id: string;
  state: "active" | "sealed" | "partial";
  access: "full" | "summary" | "catalog-only";
  storageVersion: number | null;
  createdAt: string;
  archivedAt?: string;
};

export type ArchivedRunLookup =
  | { kind: "found"; run: ArchivedRunSummary }
  | { kind: "not-found" }
  | { kind: "unavailable"; message: string };

export async function listRuntimeGenerations(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Promise<RuntimeGenerationSummary[]> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  return listRuntimeGenerationsAtLayout(workspace);
}

export async function listRuntimeGenerationsAtLayout(
  workspace: RuntimeLayout,
): Promise<RuntimeGenerationSummary[]> {
  await validateRuntimeLayoutBoundary(workspace);
  let activeGenerationId: string | undefined;
  try {
    activeGenerationId = resolveRuntimeLayoutAtWorkspace(workspace).generationId;
  } catch {
    activeGenerationId = undefined;
  }
  let entries;
  try {
    const info = await lstat(workspace.generationsRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Runtime generations root '${workspace.generationsRoot}' is not a regular directory.`);
    entries = await readdir(workspace.generationsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const generations: RuntimeGenerationSummary[] = [];
  for (const entry of entries) {
    const path = join(workspace.generationsRoot, entry.name);
    if (!isGenerationId(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Runtime generation entry '${path}' is unsafe or has an invalid id.`);
    }
    const layout = runtimeLayoutForGeneration(workspace, entry.name);
    const info = await lstat(path);
    const metadata = await readGenerationMetadataForRecovery(layout.generationMetadataPath);
    const active = entry.name === activeGenerationId;
    const partial = metadata?.id !== entry.name || active && metadata.archivedAt !== undefined;
    const index = !partial && !active && metadata.storageVersion === H1_RUN_INDEX_STORAGE_VERSION
      ? await readPortableRunIndex(layout.runIndexPath)
      : undefined;
    generations.push({
      id: entry.name,
      state: partial ? "partial" : active ? "active" : "sealed",
      access: partial ? "catalog-only" : active ? "full" : index ? "summary" : "catalog-only",
      storageVersion: metadata?.storageVersion ?? null,
      createdAt: metadata?.createdAt ?? canonicalTime(info.birthtimeMs || info.mtimeMs),
      ...(metadata?.archivedAt === undefined ? {} : { archivedAt: metadata.archivedAt }),
    });
  }
  return generations.sort((left, right) => {
    if (left.state === "active") return -1;
    if (right.state === "active") return 1;
    return (right.archivedAt ?? right.createdAt).localeCompare(left.archivedAt ?? left.createdAt)
      || left.id.localeCompare(right.id);
  });
}

export async function findArchivedRun(cwd: string, runId: string): Promise<ArchivedRunLookup> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd);
  const generations = await listRuntimeGenerations(cwd);
  let unavailable = false;
  for (const generation of generations) {
    if (generation.state === "active") continue;
    if (generation.access !== "summary") {
      unavailable = true;
      continue;
    }
    const index = await readPortableRunIndex(runtimeLayoutForGeneration(workspace, generation.id).runIndexPath);
    const run = index?.runs.find(candidate => candidate.id === runId);
    if (run) return { kind: "found", run };
  }
  return unavailable
    ? { kind: "unavailable", message: "Archived runs from an older store cannot be searched." }
    : { kind: "not-found" };
}

async function readPortableRunIndex(path: string) {
  try {
    return await readRunIndex(path);
  } catch (error) {
    if (error instanceof RuntimeMetadataFormatError) return undefined;
    throw error;
  }
}

function canonicalTime(timestamp: number): string {
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0).toISOString();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
