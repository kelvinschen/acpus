import { createHash } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CliError, usageError } from "./errors.js";

export type WorkflowCatalogScope = "project" | "global";

export type WorkflowCatalogScopeOptions = {
  project?: boolean;
  global?: boolean;
};

export type WorkflowCatalogEntry = {
  scope: WorkflowCatalogScope;
  name: string;
  packagePath: string;
  entryPath: string;
  status: "available";
  requiresScope: boolean;
};

export type ResolvedWorkflowReference = {
  workflow: string;
  catalog?: WorkflowCatalogEntry;
};

const catalogNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const catalogWorkflowEntry = "workflow.ts";

export async function discoverWorkflowCatalog(cwd: string, options: WorkflowCatalogScopeOptions = {}): Promise<WorkflowCatalogEntry[]> {
  const scope = selectedScope(options);
  const allEntries = (await Promise.all((["project", "global"] satisfies WorkflowCatalogScope[]).map(item => discoverScope(cwd, item)))).flat();
  const counts = new Map<string, number>();
  for (const entry of allEntries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return allEntries
    .filter(entry => scope === undefined || entry.scope === scope)
    .map(entry => ({ ...entry, requiresScope: (counts.get(entry.name) ?? 0) > 1 }))
    .sort(compareCatalogEntries);
}

export async function showWorkflowCatalogEntry(cwd: string, name: string, options: WorkflowCatalogScopeOptions = {}): Promise<WorkflowCatalogEntry> {
  assertCatalogName(name);
  return findCatalogEntry(cwd, name, options);
}

export async function resolveWorkflowReference(cwd: string, workflow: string, options: WorkflowCatalogScopeOptions = {}): Promise<ResolvedWorkflowReference> {
  if (!hasSelectedScope(options) && await isPathLikeWorkflowReference(cwd, workflow)) return { workflow };
  assertCatalogName(workflow);
  const catalog = await findCatalogEntry(cwd, workflow, options);
  if (catalog.scope === "project") return { workflow: catalog.entryPath, catalog };
  return { workflow: await materializeGlobalCatalogEntry(cwd, catalog), catalog };
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

async function findCatalogEntry(cwd: string, name: string, options: WorkflowCatalogScopeOptions): Promise<WorkflowCatalogEntry> {
  const entries = (await discoverWorkflowCatalog(cwd, options)).filter(entry => entry.name === name);
  if (entries.length === 0) {
    const scope = selectedScope(options);
    throw inspectError(scope
      ? `Workflow catalog entry '${name}' was not found in ${scope} scope.`
      : `Workflow catalog entry '${name}' was not found.`);
  }
  if (entries.length > 1) throw usageError(`Workflow catalog entry '${name}' exists in project and global scopes. Pass --project or --global.`);
  return entries[0]!;
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
    const name = dirent.name;
    if (!catalogNamePattern.test(name)) continue;
    const packagePath = join(root, name);
    if (!await isDirectory(packagePath)) continue;
    const entryPath = join(packagePath, catalogWorkflowEntry);
    if (!await isFile(entryPath)) continue;
    entries.push({
      scope,
      name,
      packagePath,
      entryPath,
      status: "available",
      requiresScope: false,
    });
  }
  return entries;
}

function catalogRoot(cwd: string, scope: WorkflowCatalogScope): string {
  return scope === "project"
    ? join(cwd, ".acpus", "workflows")
    : join(process.env.HOME || homedir(), ".acpus", "workflows");
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

async function materializeGlobalCatalogEntry(cwd: string, entry: WorkflowCatalogEntry): Promise<string> {
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function compareCatalogEntries(left: WorkflowCatalogEntry, right: WorkflowCatalogEntry): number {
  const name = left.name.localeCompare(right.name);
  if (name !== 0) return name;
  return scopeRank(left.scope) - scopeRank(right.scope);
}

function scopeRank(scope: WorkflowCatalogScope): number {
  return scope === "project" ? 0 : 1;
}

function inspectError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "inspect", message });
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
