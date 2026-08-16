import { lstat, readFile } from "node:fs/promises";
import { writePrivateJsonAtomically } from "./private-json.js";

export const H1_RUN_INDEX_STORAGE_VERSION = 9;

export type RuntimeGenerationMetadata = {
  schemaVersion: 1;
  id: string;
  storageVersion: number | null;
  createdAt: string;
  archivedAt?: string;
};

export type ArchivedRunSummary = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeRunIndex = {
  schemaVersion: 1;
  runs: ArchivedRunSummary[];
};

export class RuntimeMetadataFormatError extends Error {}

export async function readGenerationMetadataForRecovery(
  path: string,
): Promise<RuntimeGenerationMetadata | undefined> {
  try {
    const value = await readJsonFile(path);
    if (value === undefined) return undefined;
    if (!isGenerationMetadata(value)) throw new RuntimeMetadataFormatError(`Runtime generation metadata '${path}' is invalid.`);
    return value;
  } catch (error) {
    if (error instanceof RuntimeMetadataFormatError) return undefined;
    throw error;
  }
}

export async function readRunIndex(path: string): Promise<RuntimeRunIndex | undefined> {
  const value = await readJsonFile(path);
  if (value === undefined) return undefined;
  if (!isRunIndex(value)) throw new RuntimeMetadataFormatError(`Runtime run index '${path}' is invalid.`);
  return value;
}

export async function writeGenerationMetadata(path: string, value: RuntimeGenerationMetadata): Promise<void> {
  if (!isGenerationMetadata(value)) throw new Error("Runtime generation metadata is invalid.");
  await writePrivateJsonAtomically(path, value);
}

export async function writeRunIndex(path: string, runs: ArchivedRunSummary[]): Promise<void> {
  await writePrivateJsonAtomically(path, {
    schemaVersion: 1,
    runs: [...runs].sort(compareArchivedRuns),
  } satisfies RuntimeRunIndex);
}

function compareArchivedRuns(left: ArchivedRunSummary, right: ArchivedRunSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.id.localeCompare(right.id);
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new RuntimeMetadataFormatError(`Runtime metadata '${path}' is not a regular file.`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new RuntimeMetadataFormatError(`Runtime metadata '${path}' is not valid JSON: ${errorMessage(error)}.`);
  }
}

function isGenerationMetadata(value: unknown): value is RuntimeGenerationMetadata {
  return isPlainRecord(value)
    && hasExactKeys(value, ["schemaVersion", "id", "storageVersion", "createdAt"], ["archivedAt"])
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && /^gen_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
    && (value.storageVersion === null || Number.isSafeInteger(value.storageVersion) && Number(value.storageVersion) >= 0)
    && isCanonicalTimestamp(value.createdAt)
    && (value.archivedAt === undefined || isCanonicalTimestamp(value.archivedAt));
}

function isRunIndex(value: unknown): value is RuntimeRunIndex {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "runs"])
    || value.schemaVersion !== 1
    || !Array.isArray(value.runs)
    || !value.runs.every(isArchivedRunSummary)) return false;
  const runs = value.runs as ArchivedRunSummary[];
  return runs.every((run, index) => index === 0 || compareArchivedRuns(runs[index - 1]!, run) <= 0);
}

function isArchivedRunSummary(value: unknown): value is ArchivedRunSummary {
  return isPlainRecord(value)
    && hasExactKeys(value, ["id", "name", "status", "createdAt", "updatedAt"])
    && typeof value.id === "string" && value.id.length > 0
    && typeof value.name === "string"
    && typeof value.status === "string"
    && isCanonicalTimestamp(value.createdAt)
    && isCanonicalTimestamp(value.updatedAt);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
