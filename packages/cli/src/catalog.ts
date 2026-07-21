import { createHash } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { extractWorkflowMetadata, type WorkflowMetadataError } from "@acpus/workflow-compiler";
import { ResultAsync, type Result } from "neverthrow";
import { CliError, usageError } from "./errors.js";

export type WorkflowCatalogScope = "project" | "global";

export type WorkflowCatalogScopeOptions = {
  project?: boolean;
  global?: boolean;
};

type WorkflowCatalogErrorCode =
  | "CATALOG_ENTRY_MISSING"
  | "CATALOG_ENTRY_READ_FAILED"
  | "CATALOG_METADATA_FAILED"
  | "CATALOG_SOURCE_INVALID"
  | "CATALOG_DEFAULT_EXPORT_MISSING"
  | "CATALOG_WORKFLOW_NOT_STATIC"
  | "CATALOG_NAME_NOT_STATIC"
  | "CATALOG_NAME_INVALID"
  | "CATALOG_NAME_MISMATCH";

export type AvailableWorkflowCatalogEntry = {
  scope: WorkflowCatalogScope;
  name: string;
  packagePath: string;
  entryPath: string;
  status: "available";
  requiresScope: boolean;
};

type InvalidWorkflowCatalogEntry = {
  scope: WorkflowCatalogScope;
  name?: string;
  packagePath: string;
  entryPath: string;
  status: "invalid";
  requiresScope: false;
  errorCode: WorkflowCatalogErrorCode;
  error: string;
};

export type WorkflowCatalogEntry = AvailableWorkflowCatalogEntry | InvalidWorkflowCatalogEntry;

export type ResolvedWorkflowReference = {
  workflow: string;
  catalog?: AvailableWorkflowCatalogEntry;
};

type WorkflowCatalogCommitFailure = {
  type: "invalid-name" | "collision" | "commit-failed";
  message: string;
};

type PreparedWorkflowCatalogCommit = {
  commit(stagedPackage: string): ResultAsync<AvailableWorkflowCatalogEntry, WorkflowCatalogCommitFailure>;
};

class CatalogCommitAbort extends Error {
  constructor(readonly failure: WorkflowCatalogCommitFailure) {
    super(failure.message);
  }
}

const catalogNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const catalogWorkflowEntry = "workflow.ts";
const metadataCache = new Map<string, {
  source: string;
  result: Result<{ name: string }, WorkflowMetadataError>;
}>();

export async function discoverWorkflowCatalog(cwd: string, options: WorkflowCatalogScopeOptions = {}): Promise<WorkflowCatalogEntry[]> {
  const scope = selectedScope(options);
  const allEntries = (await Promise.all(([
    "project",
    "global",
  ] satisfies WorkflowCatalogScope[]).map(item => discoverScope(cwd, item)))).flat();
  const counts = new Map<string, number>();
  for (const entry of allEntries) {
    if (entry.status === "available") counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  return allEntries
    .filter(entry => scope === undefined || entry.scope === scope)
    .map(entry => entry.status === "available"
      ? { ...entry, requiresScope: (counts.get(entry.name) ?? 0) > 1 }
      : entry)
    .sort(compareCatalogEntries);
}

export async function lookupWorkflowCatalogEntry(cwd: string, name: string, options: WorkflowCatalogScopeOptions = {}): Promise<AvailableWorkflowCatalogEntry> {
  assertCatalogName(name);
  const discovered = await discoverWorkflowCatalog(cwd, options);
  const entries = discovered.filter((entry): entry is AvailableWorkflowCatalogEntry => entry.status === "available" && entry.name === name);
  if (entries.length === 0) {
    const scope = selectedScope(options);
    const invalid = discovered.find((entry): entry is InvalidWorkflowCatalogEntry => entry.status === "invalid" && (entry.name === name || basename(entry.packagePath) === name));
    if (invalid) {
      throw inspectError(`Workflow catalog entry '${name}' is invalid: ${invalid.error}`, invalid.errorCode);
    }
    throw inspectError(scope
      ? `Workflow catalog entry '${name}' was not found in ${scope} scope.`
      : `Workflow catalog entry '${name}' was not found.`);
  }
  if (entries.length > 1) throw usageError(`Workflow catalog entry '${name}' exists in project and global scopes. Pass --project or --global.`);
  return entries[0]!;
}

export async function resolveWorkflowReference(cwd: string, workflow: string, options: WorkflowCatalogScopeOptions = {}): Promise<ResolvedWorkflowReference> {
  if (!hasSelectedScope(options) && await isPathLikeWorkflowReference(cwd, workflow)) return { workflow };
  const catalog = await lookupWorkflowCatalogEntry(cwd, workflow, options);
  if (catalog.scope === "project") return { workflow: catalog.entryPath, catalog };
  return { workflow: await materializeGlobalCatalogEntry(cwd, catalog), catalog };
}

export function prepareWorkflowCatalogCommit(
  cwd: string,
  scope: WorkflowCatalogScope,
  name: string,
): ResultAsync<PreparedWorkflowCatalogCommit, WorkflowCatalogCommitFailure> {
  return ResultAsync.fromPromise(prepareCatalogCommit(cwd, scope, name), catalogCommitFailure);
}

async function prepareCatalogCommit(cwd: string, scope: WorkflowCatalogScope, name: string): Promise<PreparedWorkflowCatalogCommit> {
  if (!catalogNamePattern.test(name)) {
    abortCatalogCommit("invalid-name", `Authored workflow name '${name}' must match ${catalogNamePattern.source}.`);
  }
  const root = catalogRoot(cwd, scope);
  const packagePath = join(root, name);
  const entryPath = join(packagePath, catalogWorkflowEntry);
  if (await pathExists(packagePath)) abortCatalogCommit("collision", `Workflow '${name}' already exists in the ${scope} catalog.`);
  const otherScope = scope === "project" ? "global" : "project";
  const requiresScope = (await discoverWorkflowCatalog(cwd, { [otherScope]: true }))
    .some(entry => entry.status === "available" && entry.name === name);
  return {
    commit: stagedPackage => ResultAsync.fromPromise((async () => {
      await mkdir(root, { recursive: true });
      if (await pathExists(packagePath)) abortCatalogCommit("collision", `Workflow '${name}' already exists in the ${scope} catalog.`);
      try {
        await rename(stagedPackage, packagePath);
      } catch (error) {
        if (await pathExists(packagePath)) abortCatalogCommit("collision", `Workflow '${name}' already exists in the ${scope} catalog.`);
        abortCatalogCommit("commit-failed", `Workflow import could not be committed: ${causeMessage(error)}`);
      }
      return { scope, name, packagePath, entryPath, status: "available", requiresScope };
    })(), catalogCommitFailure),
  };
}

function catalogRoot(cwd: string, scope: WorkflowCatalogScope): string {
  return scope === "project"
    ? resolve(cwd, ".acpus", "workflows")
    : resolve(process.env.HOME || homedir(), ".acpus", "workflows");
}

function selectedScope(options: WorkflowCatalogScopeOptions): WorkflowCatalogScope | undefined {
  if (options.project && options.global) throw usageError("--project and --global are mutually exclusive.");
  if (options.project) return "project";
  if (options.global) return "global";
  return undefined;
}

function hasSelectedScope(options: WorkflowCatalogScopeOptions): boolean {
  return Boolean(options.project || options.global);
}

async function discoverScope(cwd: string, scope: WorkflowCatalogScope): Promise<WorkflowCatalogEntry[]> {
  const root = catalogRoot(cwd, scope);
  let dirents: Dirent<string>[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw inspectError(`Workflow catalog ${scope} root '${root}' could not be read: ${causeMessage(error)}`);
  }

  const entries: WorkflowCatalogEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    entries.push(await inspectCatalogPackage(root, dirent.name, scope));
  }
  return entries;
}

async function inspectCatalogPackage(root: string, directoryName: string, scope: WorkflowCatalogScope): Promise<WorkflowCatalogEntry> {
  const packagePath = join(root, directoryName);
  const entryPath = join(packagePath, catalogWorkflowEntry);
  try {
    const packageStat = await lstat(packagePath);
    if (!packageStat.isDirectory()) return invalidEntry(scope, packagePath, entryPath, "CATALOG_SOURCE_INVALID", "Catalog package must be a directory and cannot be a symbolic link.");
  } catch (error) {
    return invalidEntry(scope, packagePath, entryPath, "CATALOG_ENTRY_READ_FAILED", `Catalog package could not be read: ${causeMessage(error)}`);
  }

  try {
    const entryStat = await lstat(entryPath);
    if (!entryStat.isFile()) return invalidEntry(scope, packagePath, entryPath, "CATALOG_ENTRY_MISSING", `Catalog package must contain a regular ${catalogWorkflowEntry} entry.`);
  } catch (error) {
    return invalidEntry(scope, packagePath, entryPath, isMissingPath(error) ? "CATALOG_ENTRY_MISSING" : "CATALOG_ENTRY_READ_FAILED", isMissingPath(error)
      ? `Catalog package must contain ${catalogWorkflowEntry}.`
      : `Catalog entry could not be read: ${causeMessage(error)}`);
  }

  let source: string;
  try {
    source = await readFile(entryPath, "utf8");
  } catch (error) {
    return invalidEntry(scope, packagePath, entryPath, "CATALOG_ENTRY_READ_FAILED", `Catalog entry could not be read: ${causeMessage(error)}`);
  }
  const cached = metadataCache.get(entryPath);
  const metadata = cached?.source === source ? cached.result : await extractWorkflowMetadata(source, entryPath);
  metadataCache.set(entryPath, { source, result: metadata });
  if (metadata.isErr()) {
    const mapped = metadataCatalogError(metadata.error);
    return invalidEntry(scope, packagePath, entryPath, mapped.errorCode, metadata.error.message);
  }
  const name = metadata.value.name;
  if (!catalogNamePattern.test(name)) {
    return invalidEntry(scope, packagePath, entryPath, "CATALOG_NAME_INVALID", `Authored workflow name '${name}' must match ${catalogNamePattern.source}.`, name);
  }
  if (name !== directoryName) {
    return invalidEntry(scope, packagePath, entryPath, "CATALOG_NAME_MISMATCH", `Authored workflow name '${name}' must exactly match catalog directory '${directoryName}'.`, name);
  }
  return { scope, name, packagePath, entryPath, status: "available", requiresScope: false };
}

function invalidEntry(
  scope: WorkflowCatalogScope,
  packagePath: string,
  entryPath: string,
  errorCode: WorkflowCatalogErrorCode,
  error: string,
  name?: string,
): InvalidWorkflowCatalogEntry {
  return { scope, ...(name === undefined ? {} : { name }), packagePath, entryPath, status: "invalid", requiresScope: false, errorCode, error };
}

function metadataCatalogError(error: WorkflowMetadataError): { errorCode: WorkflowCatalogErrorCode } {
  switch (error.type) {
    case "typescript-analysis-failed": return { errorCode: "CATALOG_METADATA_FAILED" };
    case "syntax-invalid": return { errorCode: "CATALOG_SOURCE_INVALID" };
    case "default-export-missing": return { errorCode: "CATALOG_DEFAULT_EXPORT_MISSING" };
    case "workflow-definition-not-static": return { errorCode: "CATALOG_WORKFLOW_NOT_STATIC" };
    case "workflow-name-not-static": return { errorCode: "CATALOG_NAME_NOT_STATIC" };
  }
}

function assertCatalogName(name: string): void {
  if (!catalogNamePattern.test(name)) throw usageError(`Workflow catalog name '${name}' must match ${catalogNamePattern.source}.`);
}

async function isPathLikeWorkflowReference(cwd: string, workflow: string): Promise<boolean> {
  if (isAbsolute(workflow)
    || workflow.startsWith("./")
    || workflow.startsWith("../")
    || workflow.includes("/")
    || workflow.includes("\\")
    || workflow.endsWith(".ts")) {
    return true;
  }
  return isFile(resolve(cwd, workflow));
}

async function materializeGlobalCatalogEntry(cwd: string, entry: AvailableWorkflowCatalogEntry): Promise<string> {
  try {
    const digest = await digestDirectory(entry.packagePath);
    const target = join(cwd, ".acpus", ".local", "catalog-cache", "global", entry.name, digest);
    const targetEntry = join(target, catalogWorkflowEntry);
    if (await isFile(targetEntry)) return targetEntry;
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(entry.packagePath, target, { recursive: true, dereference: true });
    if (!await isFile(targetEntry)) throw new Error(`materialized package is missing ${catalogWorkflowEntry}`);
    return targetEntry;
  } catch (error) {
    throw inspectError(`Workflow catalog entry '${entry.name}' could not be materialized: ${causeMessage(error)}`);
  }
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await addToDigest(hash, root, "");
  return hash.digest("hex");
}

async function addToDigest(hash: ReturnType<typeof createHash>, path: string, relativePath: string): Promise<void> {
  const item = await stat(path);
  const normalizedPath = relativePath.split(/[\\/]/).filter(Boolean).join("/");
  if (item.isDirectory()) {
    if (normalizedPath) hash.update(`D ${normalizedPath}\n`);
    const names = (await readdir(path)).sort();
    for (const name of names) await addToDigest(hash, join(path, name), join(relativePath, name));
    return;
  }
  if (!item.isFile()) return;
  hash.update(`F ${normalizedPath}\n`);
  hash.update(await readFile(path));
  hash.update("\n");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function compareCatalogEntries(left: WorkflowCatalogEntry, right: WorkflowCatalogEntry): number {
  if (left.status !== right.status) return left.status === "available" ? -1 : 1;
  if (left.status === "invalid" && right.status === "invalid") return left.packagePath.localeCompare(right.packagePath);
  if (left.status === "available" && right.status === "available") {
    const name = left.name.localeCompare(right.name);
    if (name !== 0) return name;
    return scopeRank(left.scope) - scopeRank(right.scope);
  }
  return 0;
}

function scopeRank(scope: WorkflowCatalogScope): number {
  return scope === "project" ? 0 : 1;
}

function inspectError(message: string, errorCode?: string): CliError {
  return new CliError(1, { ok: false, phase: "inspect", message, ...(errorCode === undefined ? {} : { errorCode }) });
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function catalogCommitFailure(cause: unknown): WorkflowCatalogCommitFailure {
  return cause instanceof CatalogCommitAbort
    ? cause.failure
    : { type: "commit-failed", message: `Workflow import could not access its catalog destination: ${causeMessage(cause)}` };
}

function abortCatalogCommit(type: WorkflowCatalogCommitFailure["type"], message: string): never {
  throw new CatalogCommitAbort({ type, message });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
