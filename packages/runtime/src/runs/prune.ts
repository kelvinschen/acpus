import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  runtimeLayoutFromManifest,
  validateRuntimeLayoutBoundary,
  validateWorkspaceManifest,
  type RuntimeLayout,
  type WorkspaceManifest,
} from "../runtime-layout.js";
import {
  assertRuntimeArchiveSafe,
  IncompatibleRuntimeDatabaseError,
  openExistingRuntimeStoreAtLayout,
  readRuntimeStorageVersion,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  type RuntimeStore,
  type WorkflowSourceRef,
} from "../store/store.js";
import { acquireRuntimeExclusiveLock } from "../runtime-lock.js";
import {
  archiveRuntimeGeneration,
  recreateRuntimeGeneration,
  runtimeArchiveVersion,
} from "../storage/maintenance.js";
import {
  inspectRuntimeGeneration,
  PartialRuntimeGenerationError,
} from "../storage/generation.js";

export type PruneReport = {
  dryRun: boolean;
  cutoff?: string;
  selected: {
    workspaces: number;
    runs: number;
    archives: number;
    bytes: number;
  };
  deleted: {
    workspaces: number;
    runs: number;
    archives: number;
    sources: number;
    bytes: number;
  };
  removedWorkspaces: number;
  failures: Array<{ workspaceKey: string; message: string }>;
};

export async function pruneRuns(
  cwd: string,
  options: {
    olderThanMs?: number;
    allWorkspaces: boolean;
    dryRun: boolean;
    selectionCutoff?: string;
  },
): Promise<PruneReport> {
  if (options.olderThanMs !== undefined
    && (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0)) {
    throw new Error("Prune olderThanMs must be a non-negative safe integer.");
  }
  if (options.selectionCutoff !== undefined && !isCanonicalTimestamp(options.selectionCutoff)) {
    throw new Error("Prune selectionCutoff must be a canonical UTC timestamp.");
  }
  const current = resolveRuntimeLayout(cwd);
  const cutoff = options.selectionCutoff ?? (options.olderThanMs === undefined
    ? undefined
    : new Date(Date.now() - options.olderThanMs).toISOString());
  const report: PruneReport = {
    dryRun: options.dryRun,
    ...(options.olderThanMs === undefined ? {} : { cutoff: cutoff! }),
    selected: { workspaces: 0, runs: 0, archives: 0, bytes: 0 },
    deleted: { workspaces: 0, runs: 0, archives: 0, sources: 0, bytes: 0 },
    removedWorkspaces: 0,
    failures: [],
  };
  const targets: PruneTargetResult[] = options.allWorkspaces
    ? await discoverWorkspaceLayouts(current.home)
    : await currentWorkspaceLayout(current);
  for (const target of targets) {
    if ("failure" in target) {
      report.failures.push(target.failure);
      continue;
    }
    try {
      mergeShardReport(report, await pruneShard(
        target.layout,
        cutoff,
        options.olderThanMs === undefined,
        options.dryRun,
        target.replaceFilesystemIdentity === true,
        target.replaceMissingManifest === true,
        target.recoveryFailure,
      ));
    } catch (error) {
      if (error instanceof ShardPruneError) mergeShardReport(report, error.summary);
      report.failures.push({
        workspaceKey: target.layout.workspaceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

type ShardSummary = {
  selected: { runs: number; archives: number; bytes: number };
  deleted: { runs: number; archives: number; sources: number; bytes: number };
  removedWorkspace: boolean;
};

type PruneTarget = {
  layout: RuntimeLayout;
  replaceFilesystemIdentity?: boolean;
  replaceMissingManifest?: boolean;
  recoveryFailure?: string;
};

type PruneTargetResult = PruneTarget | { failure: PruneReport["failures"][number] };

export type PruneSelectionInput = {
  cutoff?: string;
  runs: Array<{ id: string; status: string; updatedAt: string }>;
  archives: Array<{ name: string }>;
};

export type PruneSelection = {
  runIds: string[];
  archiveNames: string[];
};

class ShardPruneError extends Error {
  constructor(cause: unknown, readonly summary: ShardSummary) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function pruneShard(
  layout: RuntimeLayout,
  cutoff: string | undefined,
  unbounded: boolean,
  dryRun: boolean,
  replaceFilesystemIdentity: boolean,
  replaceMissingManifest = false,
  recoveryFailure?: string,
): Promise<ShardSummary> {
  await validateRuntimeLayoutBoundary(layout);
  const lock = dryRun ? undefined : await acquireRuntimeExclusiveLock(layout);
  let store: RuntimeStore | undefined;
  let summary: ShardSummary | undefined;
  try {
    const archiveInventory = await readArchiveInventory(layout.archivesRoot);
    const archiveNames = new Set(planPruneSelection({
      ...(cutoff === undefined ? {} : { cutoff }),
      runs: [],
      archives: archiveInventory,
    }).archiveNames);
    const archives = await Promise.all(archiveInventory
      .filter(archive => archiveNames.has(archive.name))
      .map(async archive => ({ ...archive, bytes: await treeSize(archive.path) })));
    const candidateSummary: ShardSummary = {
      selected: {
        runs: 0,
        archives: archives.length,
        bytes: sum(archives, "bytes"),
      },
      deleted: { runs: 0, archives: 0, sources: 0, bytes: 0 },
      removedWorkspace: false,
    };
    summary = candidateSummary;
    if (dryRun && recoveryFailure) throw new Error(recoveryFailure);

    if (replaceFilesystemIdentity) {
      await archiveRuntimeGeneration(layout, await runtimeArchiveVersion(layout), lock);
      await rm(layout.manifestPath);
      const ensured = await ensureRuntimeLayout(layout.canonicalPath);
      if (ensured.isErr()) throw new Error(ensured.error.message);
      layout = ensured.value;
      await recreateRuntimeGeneration(layout);
    }
    if (replaceMissingManifest) {
      const archived = await recoverGenerationWithoutManifest(layout, lock);
      const ensured = await ensureRuntimeLayout(layout.canonicalPath);
      if (ensured.isErr()) throw new Error(ensured.error.message);
      layout = ensured.value;
      if (archived) await recreateRuntimeGeneration(layout);
    } else {
      await recoverPartialGeneration(layout, dryRun, lock);
    }

    try {
      store = await openExistingRuntimeStoreAtLayout(layout, dryRun, {
        lock: false,
        immutable: dryRun,
      });
    } catch (error) {
      if (!(error instanceof IncompatibleRuntimeDatabaseError)) throw error;
      const deleteOldGeneration = unbounded
        && error.applicationId === RUNTIME_APPLICATION_ID
        && error.userVersion > 0
        && error.userVersion < RUNTIME_STORAGE_VERSION;
      if (!deleteOldGeneration && dryRun) throw error;
      const bytes = deleteOldGeneration ? await treeSize(layout.runtimeRoot) : 0;
      if (deleteOldGeneration) {
        candidateSummary.selected.archives += 1;
        candidateSummary.selected.bytes += bytes;
      }
      if (dryRun) return candidateSummary;
      const archive = await archiveRuntimeGeneration(layout, error.userVersion, lock);
      if (deleteOldGeneration) {
        if (!archive) throw new Error(`Runtime generation '${layout.runtimeRoot}' disappeared during pruning.`);
        archives.push({ name: basename(archive), path: archive, bytes });
      }
      await recreateRuntimeGeneration(layout);
      store = await openExistingRuntimeStoreAtLayout(layout, false, { lock: false });
    }

    const listedRuns = store?.listRuns() ?? [];
    const runIds = new Set(planPruneSelection({
      ...(cutoff === undefined ? {} : { cutoff }),
      runs: listedRuns,
      archives: [],
    }).runIds);
    const runs = store
      ? await Promise.all(listedRuns
        .filter(run => runIds.has(run.id))
        .map(async run => {
          const path = store!.getRunDir(run.id);
          if (!path) throw new Error(`Run '${run.id}' has no runtime directory.`);
          return { id: run.id, path, bytes: await treeSize(path) };
        }))
      : [];
    candidateSummary.selected.runs = runs.length;
    candidateSummary.selected.bytes += sum(runs, "bytes");
    if (dryRun) return candidateSummary;

    for (const run of runs) {
      const deleted = await store!.deleteRun(run.id);
      if (deleted.isErr()) throw new Error(deleted.error.message);
      if (!deleted.value) throw new Error(`Run '${run.id}' disappeared during pruning.`);
      candidateSummary.deleted.runs += 1;
      candidateSummary.deleted.bytes += run.bytes;
    }
    for (const archive of archives) {
      await rm(archive.path, { recursive: true });
      candidateSummary.deleted.archives += 1;
      candidateSummary.deleted.bytes += archive.bytes;
    }
    await pruneUnreferencedSources(layout, store?.listWorkflowSources() ?? [], (bytes) => {
      candidateSummary.deleted.sources += 1;
      candidateSummary.deleted.bytes += bytes;
    });
    store?.close();
    store = undefined;
    if (await shardIsEmpty(layout)) {
      await assertRuntimeArchiveSafe(layout);
      await rm(layout.workspaceRoot, { recursive: true });
      candidateSummary.removedWorkspace = true;
    }
    return candidateSummary;
  } catch (error) {
    if (error instanceof ShardPruneError || !summary) throw error;
    throw new ShardPruneError(error, summary);
  } finally {
    store?.close();
    await lock?.release();
  }
}

async function currentWorkspaceLayout(
  layout: RuntimeLayout,
): Promise<PruneTargetResult[]> {
  try {
    await validateRuntimeLayoutBoundary(layout);
  } catch (error) {
    return [{
      failure: {
        workspaceKey: layout.workspaceKey,
        message: error instanceof Error ? error.message : String(error),
      },
    }];
  }
  let manifestInfo;
  try {
    manifestInfo = await lstat(layout.manifestPath);
  } catch (error) {
    if (isMissing(error)) {
      try {
        await lstat(layout.workspaceRoot);
      } catch (workspaceError) {
        if (isMissing(workspaceError)) return [];
        throw workspaceError;
      }
      return [{
        layout,
        replaceMissingManifest: true,
        recoveryFailure: `Workspace shard '${layout.workspaceRoot}' has no workspace manifest.`,
      }];
    }
    throw error;
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    return [{
      failure: {
        workspaceKey: layout.workspaceKey,
        message: `Workspace manifest '${layout.manifestPath}' is not a regular file.`,
      },
    }];
  }
  try {
    for (const path of [
      layout.home,
      join(layout.home, "workspaces"),
      layout.workspaceRoot,
    ]) {
      await assertOwnedDirectory(path, "Runtime-owned directory");
    }
    const manifest = parseManifest(JSON.parse(await readFile(layout.manifestPath, "utf8")) as unknown);
    const validated = validateWorkspaceManifest(manifest, layout);
    if (validated.isOk()) return [{ layout }];
    if (validated.error.type === "manifest-mismatch"
      && validated.error.field === "filesystemIdentity") {
      return [{
        layout,
        replaceFilesystemIdentity: true,
        recoveryFailure: validated.error.message,
      }];
    }
    return [{ failure: { workspaceKey: layout.workspaceKey, message: validated.error.message } }];
  } catch (error) {
    return [{
      failure: {
        workspaceKey: layout.workspaceKey,
        message: error instanceof Error ? error.message : String(error),
      },
    }];
  }
}

async function recoverPartialGeneration(
  layout: RuntimeLayout,
  dryRun: boolean,
  lock: Awaited<ReturnType<typeof acquireRuntimeExclusiveLock>> | undefined,
): Promise<void> {
  try {
    await inspectRuntimeGeneration(layout);
  } catch (error) {
    if (!(error instanceof PartialRuntimeGenerationError) || dryRun) throw error;
    await archiveRuntimeGeneration(layout, await runtimeArchiveVersion(layout), lock);
    await recreateRuntimeGeneration(layout);
  }
}

async function recoverGenerationWithoutManifest(
  layout: RuntimeLayout,
  lock: Awaited<ReturnType<typeof acquireRuntimeExclusiveLock>> | undefined,
): Promise<boolean> {
  let state;
  try {
    state = await inspectRuntimeGeneration(layout);
  } catch (error) {
    if (!(error instanceof PartialRuntimeGenerationError)) throw error;
    await archiveRuntimeGeneration(layout, await runtimeArchiveVersion(layout), lock);
    return true;
  }
  if (state === "complete") {
    await archiveRuntimeGeneration(layout, await readRuntimeStorageVersion(layout), lock);
    return true;
  }
  return false;
}

async function discoverWorkspaceLayouts(
  home: string,
): Promise<PruneTargetResult[]> {
  const root = join(home, "workspaces");
  let entries;
  try {
    await assertOwnedDirectory(home, "Acpus home");
    entries = await readOwnedDirectory(root, "Workspace shards root");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const layouts: PruneTargetResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      layouts.push({
        failure: {
          workspaceKey: entry.name,
          message: `Workspace shard '${join(root, entry.name)}' is a symbolic link.`,
        },
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const workspaceRoot = join(root, entry.name);
    try {
      const { layout, manifest } = await readLayout(home, workspaceRoot);
      if (basename(workspaceRoot) !== layout.workspaceKey) {
        throw new Error(`Workspace shard '${workspaceRoot}' does not match manifest key '${layout.workspaceKey}'.`);
      }
      layouts.push(await discoveredWorkspaceTarget(layout, manifest));
    } catch (error) {
      layouts.push({
        failure: {
          workspaceKey: entry.name,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return layouts;
}

async function readLayout(
  home: string,
  workspaceRoot: string,
): Promise<{ layout: RuntimeLayout; manifest: WorkspaceManifest }> {
  const manifestPath = join(workspaceRoot, "workspace.json");
  const info = await lstat(manifestPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Workspace manifest '${manifestPath}' is not a regular file.`);
  }
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const layout = runtimeLayoutFromManifest(home, workspaceRoot, manifest);
  const validated = validateWorkspaceManifest(manifest, layout);
  if (validated.isErr()) throw new Error(validated.error.message);
  return { layout, manifest };
}

async function discoveredWorkspaceTarget(
  layout: RuntimeLayout,
  manifest: WorkspaceManifest,
): Promise<PruneTargetResult> {
  if (manifest.platform !== process.platform) return { layout };
  let current: RuntimeLayout;
  try {
    current = resolveRuntimeLayout(manifest.canonicalPath);
  } catch (error) {
    if (isMissing(error)) return { layout };
    throw error;
  }
  if (current.canonicalPath !== manifest.canonicalPath || current.workspaceKey !== manifest.workspaceKey) {
    return { layout };
  }
  const { filesystemIdentity: _storedIdentity, ...layoutWithoutIdentity } = layout;
  const validation = validateWorkspaceManifest(manifest, {
    ...layoutWithoutIdentity,
    ...(current.filesystemIdentity === undefined ? {} : { filesystemIdentity: current.filesystemIdentity }),
  });
  if (validation.isOk()) return { layout };
  if (validation.error.type === "manifest-mismatch"
    && validation.error.field === "filesystemIdentity") {
    return {
      layout,
      replaceFilesystemIdentity: true,
      recoveryFailure: validation.error.message,
    };
  }
  return {
    failure: {
      workspaceKey: layout.workspaceKey,
      message: validation.error.message,
    },
  };
}

function parseManifest(value: unknown): WorkspaceManifest {
  if (!isRecord(value)
    || value.manifestVersion !== 1
    || typeof value.workspaceKey !== "string"
    || !/^[a-f0-9]{32}$/.test(value.workspaceKey)
    || typeof value.canonicalPath !== "string"
    || !isNodePlatform(value.platform)
    || typeof value.createdAt !== "string"
    || (value.filesystemIdentity !== undefined && typeof value.filesystemIdentity !== "string")) {
    throw new Error("Workspace manifest does not match version 1.");
  }
  return value as WorkspaceManifest;
}

async function readArchiveInventory(root: string): Promise<Array<{ name: string; path: string }>> {
  const entries = await readOwnedDirectory(root, "Archives root");
  const archives: Array<{ name: string; path: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Archive '${path}' is not a regular directory.`);
    }
    archives.push({ name: entry.name, path });
  }
  return archives;
}

async function pruneUnreferencedSources(
  layout: RuntimeLayout,
  sources: WorkflowSourceRef[],
  onDelete: (bytes: number) => void,
): Promise<void> {
  const referenced = new Set(sources.flatMap(source => source.kind === "snapshot"
    ? [source.digest.slice("sha256:".length)]
    : []));
  const root = join(layout.sourcesRoot, "snapshots");
  const snapshots = await readOwnedDirectory(root, "Runtime workflow snapshots");
  for (const snapshot of snapshots) {
    const path = join(root, snapshot.name);
    if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
      throw new Error(`Workflow snapshot '${path}' is not a regular directory.`);
    }
    if (!/^[a-f0-9]{64}$/.test(snapshot.name)
      && !/^\.staging-[a-f0-9]{64}-[0-9a-f-]+$/.test(snapshot.name)) {
      throw new Error(`Workflow snapshot '${path}' has an invalid name.`);
    }
    if (referenced.has(snapshot.name)) continue;
    const size = await treeSize(path);
    await rm(path, { recursive: true });
    onDelete(size);
  }
  if ((await readOwnedDirectory(root, "Runtime workflow snapshots")).length === 0) {
    await rm(root, { recursive: true, force: true });
  }
}

async function shardIsEmpty(layout: RuntimeLayout): Promise<boolean> {
  const store = await openExistingRuntimeStoreAtLayout(layout, true);
  try {
    if (store && store.listRuns().length > 0) return false;
  } finally {
    store?.close();
  }
  if (await childCount(layout.archivesRoot) > 0) return false;
  await assertEmptyOwnedDirectory(layout.runsRoot, "Runtime runs root");
  await assertEmptyOwnedDirectory(layout.trashRoot, "Runtime trash");
  await assertEmptySourcesRoot(layout.sourcesRoot);
  await assertEmptyOwnedDirectory(layout.acpWorkersRoot, "ACP ownership directory");
  await assertEmptyRuntimeGenerationShape(layout);
  await assertEmptyWorkspaceShape(layout);
  return true;
}

async function childCount(root: string): Promise<number> {
  try {
    return (await readOwnedDirectory(root, "Runtime-owned directory")).length;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function treeSize(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Prune candidate '${path}' is a symbolic link.`);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await treeSize(join(path, name));
  return bytes;
}

export function planPruneSelection(input: PruneSelectionInput): PruneSelection {
  const cutoffMs = input.cutoff === undefined ? undefined : Date.parse(input.cutoff);
  return {
    runIds: input.runs
      .filter(run => (run.status === "completed" || run.status === "failed" || run.status === "canceled")
        && (input.cutoff === undefined || run.updatedAt < input.cutoff))
      .map(run => run.id),
    archiveNames: input.archives
      .filter(archive => {
        const createdAt = archiveCreatedAt(archive.name);
        return cutoffMs === undefined || createdAt < cutoffMs;
      })
      .map(archive => archive.name),
  };
}

function sum(items: Array<{ bytes: number }>, key: "bytes"): number {
  return items.reduce((total, item) => total + item[key], 0);
}

function mergeShardReport(report: PruneReport, shard: ShardSummary): void {
  if (shard.selected.runs + shard.selected.archives > 0) report.selected.workspaces += 1;
  report.selected.runs += shard.selected.runs;
  report.selected.archives += shard.selected.archives;
  report.selected.bytes += shard.selected.bytes;
  if (shard.deleted.runs + shard.deleted.archives + shard.deleted.sources > 0) report.deleted.workspaces += 1;
  report.deleted.runs += shard.deleted.runs;
  report.deleted.archives += shard.deleted.archives;
  report.deleted.sources += shard.deleted.sources;
  report.deleted.bytes += shard.deleted.bytes;
  if (shard.removedWorkspace) report.removedWorkspaces += 1;
}

function archiveCreatedAt(name: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z-v\d+$/.exec(name);
  if (!match) throw new Error(`Archive '${name}' does not have a valid UTC creation timestamp.`);
  const parts = match.slice(1).map(Number);
  const timestamp = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!, parts[6]!);
  const expected = new Date(timestamp).toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "");
  if (`${expected}-v${name.split("-v").at(-1)}` !== name) {
    throw new Error(`Archive '${name}' does not have a valid UTC creation timestamp.`);
  }
  return timestamp;
}

async function assertEmptyOwnedDirectory(root: string, label: string): Promise<void> {
  const entries = await readOwnedDirectory(root, label);
  if (entries.length > 0) {
    throw new Error(`${label} '${root}' contains unresolved runtime state.`);
  }
}

async function assertEmptySourcesRoot(root: string): Promise<void> {
  const entries = await readOwnedDirectory(root, "Runtime sources root");
  for (const entry of entries) {
    if (entry.name !== "snapshots" || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Runtime sources root '${root}' contains unexpected entry '${entry.name}'.`);
    }
    await assertEmptyOwnedDirectory(join(root, entry.name), "Runtime workflow snapshots");
  }
}

async function assertEmptyRuntimeGenerationShape(layout: RuntimeLayout): Promise<void> {
  const allowed = new Set([
    "runtime.db",
    "runtime.db-shm",
    "runtime.db-wal",
    "runs",
    "sources",
    "trash",
    "acp",
  ]);
  for (const entry of await readOwnedDirectory(layout.runtimeRoot, "Runtime generation")) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Runtime generation '${layout.runtimeRoot}' contains unexpected entry '${entry.name}'.`);
    }
    const path = join(layout.runtimeRoot, entry.name);
    const directory = entry.name === "runs" || entry.name === "sources" || entry.name === "trash" || entry.name === "acp";
    if (directory ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`Runtime generation entry '${path}' has an unexpected file type.`);
    }
  }
}

async function assertEmptyWorkspaceShape(layout: RuntimeLayout): Promise<void> {
  const allowed = new Set(["workspace.json", "daemon.sock", "runtime", "archives"]);
  for (const entry of await readOwnedDirectory(layout.workspaceRoot, "Workspace shard")) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Workspace shard '${layout.workspaceRoot}' contains unexpected entry '${entry.name}'.`);
    }
    const path = join(layout.workspaceRoot, entry.name);
    if ((entry.name === "runtime" || entry.name === "archives") && !entry.isDirectory()) {
      throw new Error(`Workspace shard entry '${path}' is not a regular directory.`);
    }
    if (entry.name === "workspace.json" && !entry.isFile()) {
      throw new Error(`Workspace shard manifest '${path}' is not a regular file.`);
    }
    if (entry.name === "daemon.sock"
      && (layout.daemonEndpoint !== layout.daemonSocketPath || !entry.isSocket())) {
      throw new Error(`Workspace daemon socket '${path}' is not a Unix socket for this layout.`);
    }
  }
}

async function readOwnedDirectory(root: string, label: string) {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${root}' is not a regular directory.`);
  }
  return readdir(root, { withFileTypes: true });
}

async function assertOwnedDirectory(root: string, label: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${root}' is not a regular directory.`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === "string" && [
    "aix",
    "android",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
    "win32",
    "cygwin",
  ].includes(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
