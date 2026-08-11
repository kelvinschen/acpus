import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256DigestHex } from "@acpus/core/content-identity";
import type { WorkflowSourceRef } from "../admission/prepared-workflow.js";
import { inspectRuntimeStoreInternal } from "../runtime-store-lifecycle.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout, runtimeLayoutForGeneration, type RuntimeLayout } from "../runtime-layout.js";
import { acquireRuntimeExclusiveLock } from "../runtime-lock.js";
import { hasNoPendingRuntimeDatabaseWal } from "../storage/database.js";
import { openExistingRuntimeStoreAtLayout } from "../store/store.js";
import { discoverWorkspaceShards, resolveAvailableWorkspaceLayout } from "../workspace-discovery.js";

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

type ShardSummary = {
  selected: { runs: number; archives: number; bytes: number };
  deleted: { runs: number; archives: number; sources: number; bytes: number };
  removedWorkspace: boolean;
};

type PruneTarget = RuntimeLayout | { failure: PruneReport["failures"][number] };

class PruneShardFailure extends Error {
  constructor(readonly summary: ShardSummary, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PruneShardFailure";
  }
}

export type PruneSelectionInput = {
  cutoff?: string;
  runs: Array<{ id: string; status: string; updatedAt: string }>;
  generations: Array<{ id: string; sealedAt?: string; createdAt: string }>;
};

export type PruneSelection = {
  runIds: string[];
  generationIds: string[];
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
  const current = resolveRuntimeWorkspaceLayout(cwd);
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
  const targets = options.allWorkspaces
    ? await discoverTargets(current.home)
    : [{ ...current }];
  for (const target of targets) {
    if ("failure" in target) {
      report.failures.push(target.failure);
      continue;
    }
    try {
      mergeShardSummary(report, await pruneShard(target, cutoff, options.dryRun));
    } catch (error) {
      if (error instanceof PruneShardFailure) mergeShardSummary(report, error.summary);
      report.failures.push({
        workspaceKey: target.workspaceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

export function planPruneSelection(input: PruneSelectionInput): PruneSelection {
  return {
    runIds: input.runs
      .filter(run => runEligibleForPrune(run, input.cutoff))
      .map(run => run.id),
    generationIds: input.generations
      .filter(generation => input.cutoff === undefined
        || (generation.sealedAt ?? generation.createdAt) < input.cutoff)
      .map(generation => generation.id),
  };
}

async function pruneShard(
  initialLayout: RuntimeLayout,
  cutoff: string | undefined,
  dryRun: boolean,
): Promise<ShardSummary> {
  const assessment = await inspectRuntimeStoreInternal(initialLayout.canonicalPath);
  if (assessment.isErr()) throw new Error(assessment.error.message);
  if (assessment.value.current.state === "unsupported") {
    throw new Error(
      "RUNTIME_STORE_UNSUPPORTED: workspace store format is not supported by this Acpus version.",
    );
  }
  if (assessment.value.current.state !== "ready") {
    throw new Error(
      "RUNTIME_STORE_REPAIR_REQUIRED: workspace store is not ready; run 'acpus doctor --fix' first.",
    );
  }
  const selection = planPruneSelection({
    ...(cutoff === undefined ? {} : { cutoff }),
    runs: await activeRuns(initialLayout, dryRun),
    generations: assessment.value.generations
      .filter(generation => generation.state === "sealed")
      .map(generation => ({
        id: generation.id,
        createdAt: generation.createdAt,
        ...(generation.archivedAt === undefined ? {} : { sealedAt: generation.archivedAt }),
      })),
  });
  const selectedGenerationIds = new Set(selection.generationIds);
  const activeGenerationId = assessment.value.current.generationId;
  if (selectedGenerationIds.has(activeGenerationId)) {
    throw new Error("The current Runtime store cannot be pruned.");
  }
  const current = resolveRuntimeLayout(initialLayout.canonicalPath);
  const generationCandidates = await Promise.all(assessment.value.generations
    .filter(generation => selectedGenerationIds.has(generation.id))
    .map(async generation => {
      const layout = runtimeLayoutForGeneration(current, generation.id);
      if (!layout.generationRoot) throw new Error("A Runtime archive path is unavailable.");
      return { id: generation.id, path: layout.generationRoot, bytes: await treeSize(layout.generationRoot) };
    }));

  let store = await openExistingRuntimeStoreAtLayout(current, true, {
    immutable: dryRun,
    lock: false,
  });
  const selectedRunIds = new Set(selection.runIds);
  const runCandidates = store
    ? await Promise.all(store.listRuns()
      .filter(run => selectedRunIds.has(run.id))
      .map(async run => {
        const path = store!.getRunDir(run.id);
        if (!path) throw new Error(`Run '${run.id}' has no runtime directory.`);
        return { id: run.id, bytes: await treeSize(path) };
      }))
    : [];
  store?.close();
  store = undefined;

  const summary: ShardSummary = {
    selected: {
      runs: runCandidates.length,
      archives: generationCandidates.length,
      bytes: sumBytes(runCandidates) + sumBytes(generationCandidates),
    },
    deleted: { runs: 0, archives: 0, sources: 0, bytes: 0 },
    removedWorkspace: false,
  };
  if (dryRun) return summary;

  let lock: Awaited<ReturnType<typeof acquireRuntimeExclusiveLock>> | undefined;
  let failure: unknown;
  try {
    lock = await acquireRuntimeExclusiveLock(current);
    const lockedAssessment = await inspectRuntimeStoreInternal(initialLayout.canonicalPath);
    if (lockedAssessment.isOk() && lockedAssessment.value.current.state === "unsupported") {
      throw new Error("RUNTIME_STORE_UNSUPPORTED: workspace store changed to an unsupported format before pruning.");
    }
    if (lockedAssessment.isErr() || lockedAssessment.value.current.state !== "ready") {
      throw new Error("RUNTIME_STORE_REPAIR_REQUIRED: workspace store changed before pruning; run 'acpus doctor --fix'.");
    }
    if (lockedAssessment.value.current.generationId !== activeGenerationId) {
      throw new Error("Runtime store changed after prune selection; run prune again.");
    }
    store = await openExistingRuntimeStoreAtLayout(current, false, { lock: false });
    if (!store) throw new Error("Active runtime store was not found.");
    const lockedRuns = new Map(store.listRuns().map(run => [run.id, run]));
    for (const run of runCandidates) {
      const lockedRun = lockedRuns.get(run.id);
      if (!lockedRun || !runEligibleForPrune(lockedRun, cutoff)) continue;
      const deleted = await store.deleteRun(run.id);
      if (deleted.isErr()) throw new Error(deleted.error.message);
      if (!deleted.value) throw new Error(`Run '${run.id}' disappeared during pruning.`);
      summary.deleted.runs += 1;
      summary.deleted.bytes += run.bytes;
    }
    for (const generation of generationCandidates) {
      await assertOwnedGeneration(generation.path);
      await rm(generation.path, { recursive: true });
      summary.deleted.archives += 1;
      summary.deleted.bytes += generation.bytes;
    }
    await pruneUnreferencedSources(current, store.listWorkflowSources(), bytes => {
      summary.deleted.sources += 1;
      summary.deleted.bytes += bytes;
    });
    if (store.listRuns().length === 0
      && lockedAssessment.value.generations.every(generation => generation.state === "active"
        || selectedGenerationIds.has(generation.id))) {
      store.close();
      store = undefined;
      await assertEmptyShard(current);
      await rm(current.workspaceRoot, { recursive: true });
      summary.removedWorkspace = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      store?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await lock?.release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw new PruneShardFailure(summary, failure);
  return summary;
}

async function activeRuns(
  layout: RuntimeLayout,
  immutable: boolean,
): Promise<Array<{ id: string; status: string; updatedAt: string }>> {
  const current = resolveRuntimeLayout(layout.canonicalPath);
  if (immutable && !await hasNoPendingRuntimeDatabaseWal(current.databasePath)) {
    throw new Error("Runtime store has an uncheckpointed write-ahead log; dry-run cannot inspect it without mutation.");
  }
  const store = await openExistingRuntimeStoreAtLayout(current, true, { immutable, lock: false });
  try {
    return store?.listRuns().map(run => ({
      id: run.id,
      status: run.status,
      updatedAt: run.updatedAt,
    })) ?? [];
  } finally {
    store?.close();
  }
}

function runEligibleForPrune(
  run: { status: string; updatedAt: string },
  cutoff: string | undefined,
): boolean {
  return ["completed", "failed", "canceled"].includes(run.status)
    && (cutoff === undefined || run.updatedAt < cutoff);
}

async function discoverTargets(home: string): Promise<PruneTarget[]> {
  const targets: PruneTarget[] = [];
  for (const discovery of await discoverWorkspaceShards(home)) {
    if ("failure" in discovery) {
      targets.push(discovery);
      continue;
    }
    try {
      targets.push(await resolveAvailableWorkspaceLayout(discovery));
    } catch (error) {
      targets.push({
        failure: {
          workspaceKey: discovery.layout.workspaceKey,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return targets;
}

async function pruneUnreferencedSources(
  layout: RuntimeLayout,
  sources: WorkflowSourceRef[],
  onDelete: (bytes: number) => void,
): Promise<void> {
  const referenced = new Set(sources.flatMap(source => source.kind === "snapshot"
    ? [sha256DigestHex(source.digest)]
    : []));
  const root = join(layout.sourcesRoot, "snapshots");
  for (const snapshot of await readOwnedDirectory(root, "Runtime workflow snapshots")) {
    const path = join(root, snapshot.name);
    if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
      throw new Error(`Workflow snapshot '${path}' is not a regular directory.`);
    }
    if (!/^[a-f0-9]{64}$/.test(snapshot.name)
      && !/^\.staging-[a-f0-9]{64}-[0-9a-f-]+$/.test(snapshot.name)) {
      throw new Error(`Workflow snapshot '${path}' has an invalid name.`);
    }
    if (referenced.has(snapshot.name)) continue;
    const bytes = await treeSize(path);
    await rm(path, { recursive: true });
    onDelete(bytes);
  }
  if ((await readOwnedDirectory(root, "Runtime workflow snapshots")).length === 0) {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertOwnedGeneration(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("A selected Runtime archive is not a regular directory.");
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

function mergeShardSummary(report: PruneReport, shard: ShardSummary): void {
  if (shard.selected.runs + shard.selected.archives > 0) report.selected.workspaces += 1;
  report.selected.runs += shard.selected.runs;
  report.selected.archives += shard.selected.archives;
  report.selected.bytes += shard.selected.bytes;
  if (shard.deleted.runs + shard.deleted.archives + shard.deleted.sources > 0 || shard.removedWorkspace) {
    report.deleted.workspaces += 1;
  }
  report.deleted.runs += shard.deleted.runs;
  report.deleted.archives += shard.deleted.archives;
  report.deleted.sources += shard.deleted.sources;
  report.deleted.bytes += shard.deleted.bytes;
  if (shard.removedWorkspace) report.removedWorkspaces += 1;
}

async function assertEmptyShard(layout: RuntimeLayout): Promise<void> {
  await assertEmptyDirectory(layout.runsRoot, "Runtime runs root");
  await assertEmptyDirectory(layout.trashRoot, "Runtime trash root");
  await assertEmptyDirectory(layout.acpWorkersRoot, "ACP ownership root");
  const acpEntries = await readOwnedDirectory(layout.acpRoot, "Runtime ACP root");
  if (acpEntries.length !== 1
    || acpEntries[0]!.name !== "workers"
    || acpEntries[0]!.isSymbolicLink()
    || !acpEntries[0]!.isDirectory()) {
    throw new Error(`Runtime ACP root '${layout.acpRoot}' contains unresolved state.`);
  }
  const sourceEntries = await readOwnedDirectory(layout.sourcesRoot, "Runtime sources root");
  if (sourceEntries.length > 0) {
    throw new Error(`Runtime sources root '${layout.sourcesRoot}' contains unresolved state.`);
  }
  const generationEntries = await readOwnedDirectory(layout.generationsRoot, "Runtime generations root");
  if (generationEntries.length !== 1
    || generationEntries[0]!.name !== layout.generationId
    || generationEntries[0]!.isSymbolicLink()
    || !generationEntries[0]!.isDirectory()) {
    throw new Error("Runtime archive storage contains unresolved history.");
  }
  if (!layout.generationRoot) throw new Error("The current Runtime store path is unavailable.");
  const activeEntries = await readOwnedDirectory(layout.generationRoot, "Current Runtime store");
  if (activeEntries.some(entry => !["generation.json", "store"].includes(entry.name) || entry.isSymbolicLink())) {
    throw new Error("The current Runtime store contains unexpected state.");
  }
  const allowedStoreEntries = new Set([
    "runtime.db",
    "runtime.db-shm",
    "runtime.db-wal",
    "runs",
    "sources",
    "trash",
    "acp",
  ]);
  for (const entry of await readOwnedDirectory(layout.runtimeRoot, "Active Runtime store")) {
    if (!allowedStoreEntries.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Active Runtime store '${layout.runtimeRoot}' contains unexpected entry '${entry.name}'.`);
    }
  }
  const allowedWorkspaceEntries = new Set([
    "workspace.json",
    "generations",
    "archives",
    "daemon.sock",
  ]);
  for (const entry of await readOwnedDirectory(layout.workspaceRoot, "Runtime workspace shard")) {
    const path = join(layout.workspaceRoot, entry.name);
    if (!allowedWorkspaceEntries.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Runtime workspace shard '${layout.workspaceRoot}' contains unexpected entry '${entry.name}'.`);
    }
    if (entry.name === "archives"
      && (!entry.isDirectory() || (await readOwnedDirectory(path, "Legacy Runtime archives root")).length > 0)) {
      throw new Error(`Legacy Runtime archives root '${path}' contains unresolved history.`);
    }
    if (entry.name === "daemon.sock"
      && (layout.daemonEndpoint !== layout.daemonSocketPath || !entry.isSocket())) {
      throw new Error(`Workspace daemon socket '${path}' is not a Unix socket for this layout.`);
    }
  }
}

async function assertEmptyDirectory(path: string, label: string): Promise<void> {
  if ((await readOwnedDirectory(path, label)).length > 0) {
    throw new Error(`${label} '${path}' contains unresolved state.`);
  }
}

function sumBytes(items: Array<{ bytes: number }>): number {
  return items.reduce((total, item) => total + item.bytes, 0);
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
