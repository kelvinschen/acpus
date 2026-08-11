import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import { requestDaemonShutdown, requestDaemonStatus } from "./daemon/socket.js";
import { probeProcessLiveness } from "./process-liveness.js";
import {
  RUNTIME_LAYOUT_VERSION,
  ensureRuntimeLayout,
  isGenerationId,
  isWorkspaceManifest,
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
  validateRuntimeLayoutBoundary,
  validateWorkspaceManifest,
  type RuntimeLayout,
  type WorkspaceManifest,
} from "./runtime-layout.js";
import {
  listRuntimeGenerations,
  type RuntimeGenerationSummary,
} from "./runtime-history.js";
import { acquireRuntimeExclusiveLock, RuntimeLockTimeoutError } from "./runtime-lock.js";
import { openRuntimeStoreAtLayout } from "./store/store.js";
import {
  hasNoPendingRuntimeDatabaseWal,
  openRuntimeDatabase,
  readRuntimeDatabaseFormat,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  UnrecognizedRuntimeDatabaseError,
} from "./storage/database.js";
import {
  inspectRuntimeGeneration,
  PartialRuntimeGenerationError,
  type RuntimeGenerationState,
} from "./storage/generation.js";
import {
  readGenerationMetadataForRecovery,
  writeGenerationMetadata,
  writeRunIndex,
  type ArchivedRunSummary,
} from "./storage/generation-metadata.js";
import { writePrivateJsonAtomically } from "./storage/private-json.js";

const transitionSchemaVersion = 1;

type RuntimeStoreBlocker = {
  type: "daemon" | "run-lease" | "acp-ownership" | "activity-unproven";
  message: string;
};

type RuntimeStoreCurrent =
  | { state: "absent" }
  | {
      state: "ready";
      layoutVersion: 2;
      storageVersion: typeof RUNTIME_STORAGE_VERSION;
      generationId: string;
    }
  | {
      state: "update-required";
      layoutVersion: 1 | 2;
      storageVersion: number | null;
      generationId?: string;
    }
  | {
      state: "recovery-required";
      layoutVersion?: 1 | 2;
      generationId?: string;
      detail: string;
    }
  | {
      state: "unsupported";
      layoutVersion?: number;
      storageVersion: number | null;
      generationId?: string;
      detail: string;
    };

type RuntimeStoreTransition = {
  type: "none" | "initialize" | "rollover" | "recover";
};

export type RuntimeStoreAssessment = {
  current: RuntimeStoreCurrent;
  transition: RuntimeStoreTransition;
  blockers: RuntimeStoreBlocker[];
  generations: RuntimeGenerationSummary[];
};

type RuntimeStoreInspectFailure = {
  type: "inspect-failed";
  message: string;
};

export type RuntimeStoreStatus =
  | { state: "ready" }
  | { state: "repairable"; message: string }
  | { state: "unsupported"; message: string };

export type RuntimeStoreFailure = {
  type: "busy" | "unsupported" | "failed";
  message: string;
};

class RuntimeGenerationActiveError extends Error {
  constructor(
    readonly path: string,
    readonly blocker: "run lease" | "daemon" | "ACP ownership",
  ) {
    super(`Runtime generation '${path}' has an active ${blocker} and cannot be sealed.`);
    this.name = "RuntimeGenerationActiveError";
  }
}

async function assertRuntimeGenerationSealSafe(layout: RuntimeLayout): Promise<void> {
  await assertAcpOwnershipClear(layout);
  let info;
  try {
    info = await lstat(layout.databasePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Runtime database '${layout.databasePath}' is not a regular file.`);
  }
  const database = await openRuntimeDatabase(layout.databasePath, { readOnly: true });
  try {
    const tables = new Set((database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN ('daemon_lease', 'run_leases')
    `).all() as Array<{ name: string }>).map(row => row.name));
    if (tables.has("run_leases")) {
      const active = database.prepare(`
        SELECT COUNT(*) AS count
        FROM run_leases
        WHERE released_at IS NULL AND lease_expires_at > ?
      `).get(new Date().toISOString()) as { count: number };
      if (active.count > 0) throw new RuntimeGenerationActiveError(layout.runtimeRoot, "run lease");
    }
    if (tables.has("daemon_lease")) {
      const daemon = database.prepare(`
        SELECT pid
        FROM daemon_lease
        ORDER BY updated_at DESC
        LIMIT 1
      `).get() as { pid: number | null } | undefined;
      if (daemon?.pid && probeProcessLiveness(daemon.pid) !== "dead") {
        throw new RuntimeGenerationActiveError(layout.runtimeRoot, "daemon");
      }
    }
  } catch (error) {
    if (error instanceof RuntimeGenerationActiveError) throw error;
    throw new Error(`Runtime generation '${layout.runtimeRoot}' cannot be proven inactive: ${errorMessage(error)}.`);
  } finally {
    database.close();
  }
}

async function assertAcpOwnershipClear(layout: RuntimeLayout): Promise<void> {
  let info;
  try {
    info = await lstat(layout.acpWorkersRoot);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`ACP ownership directory '${layout.acpWorkersRoot}' is not a regular directory.`);
  }
  if ((await readdir(layout.acpWorkersRoot)).length > 0) {
    throw new RuntimeGenerationActiveError(layout.runtimeRoot, "ACP ownership");
  }
}

export function inspectRuntimeStore(
  cwd: string,
): ResultAsync<RuntimeStoreStatus, RuntimeStoreFailure> {
  return new ResultAsync((async () => {
    const inspected = await inspectRuntimeStoreInternal(cwd);
    if (inspected.isErr()) return err({
      type: "failed" as const,
      message: "The Runtime store could not be inspected.",
    });
    const current = inspected.value.current;
    if (current.state === "absent" || current.state === "ready") return ok({ state: "ready" as const });
    if (current.state === "unsupported") return ok({
      state: "unsupported" as const,
      message: current.detail,
    });
    return ok({
      state: "repairable" as const,
      message: "The Runtime store needs repair for this version of Acpus.",
    });
  })());
}

export function repairRuntimeStore(
  cwd: string,
): ResultAsync<{ changed: boolean }, RuntimeStoreFailure> {
  return ResultAsync.fromPromise(repairRuntimeStoreValue(cwd), error => ({
    type: error instanceof RuntimeStoreBusyError ? "busy"
      : error instanceof RuntimeStoreUnsupportedError ? "unsupported"
        : "failed",
    message: error instanceof RuntimeStoreBusyError
      ? "The Runtime store is busy. Stop active runs and try again."
      : error instanceof RuntimeStoreUnsupportedError
        ? error.message
        : "The Runtime store could not be repaired.",
  }));
}

export function inspectRuntimeStoreInternal(
  cwd: string,
): ResultAsync<RuntimeStoreAssessment, RuntimeStoreInspectFailure> {
  return ResultAsync.fromPromise(
    inspectRuntimeStoreValue(cwd),
    error => ({ type: "inspect-failed", message: errorMessage(error) }),
  );
}

export async function initializeRuntimeStoreIfAbsent(cwd: string): Promise<void> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd);
  const lock = await acquireRuntimeExclusiveLock(workspace);
  try {
    const assessment = await inspectRuntimeStoreValue(cwd);
    if (assessment.current.state === "absent") await initializeCurrentStore(cwd);
  } finally {
    await lock.release();
  }
}

async function repairRuntimeStoreValue(cwd: string): Promise<{ changed: boolean }> {
  const first = await inspectRuntimeStoreValue(cwd);
  if (first.current.state === "absent" || first.current.state === "ready") return { changed: false };
  if (first.current.state === "unsupported") throw new RuntimeStoreUnsupportedError(first.current.detail);
  await stopDaemonGracefully(cwd);
  const workspace = resolveRuntimeWorkspaceLayout(cwd);
  let lock;
  try {
    lock = await acquireRuntimeExclusiveLock(workspace);
  } catch (error) {
    if (error instanceof RuntimeLockTimeoutError) throw new RuntimeStoreBusyError(error.message);
    throw error;
  }

  try {
    const checked = await inspectRuntimeStoreValue(cwd);
    if (checked.current.state === "absent" || checked.current.state === "ready") return { changed: false };
    if (checked.current.state === "unsupported") throw new RuntimeStoreUnsupportedError(checked.current.detail);
    const resolved = await resolveWalUnderLock(cwd, checked);
    if (resolved.blockers.length > 0) {
      throw new RuntimeStoreBusyError(resolved.blockers.map(blocker => blocker.message).join(" "));
    }
    const assessment = resolved.assessment;
    if (assessment.current.state === "unsupported") throw new RuntimeStoreUnsupportedError(assessment.current.detail);

    for (const path of [workspace.home, join(workspace.home, "workspaces"), workspace.workspaceRoot]) {
      await ensurePrivateDirectory(path, workspace.platform);
    }
    const existingJournal = await readTransitionJournal(workspace.transitionJournalPath);
    if (existingJournal) return await resumeTransition(cwd, workspace, existingJournal);
    if (assessment.transition.type === "initialize" && assessment.current.state !== "absent") {
      return await initializeCurrentStore(cwd);
    }
    if (assessment.transition.type === "none") throw new Error("Runtime store does not need repair.");
    const journal = await createTransitionJournal(workspace, assessment);
    await writePrivateJsonAtomically(workspace.transitionJournalPath, journal);
    return await resumeTransition(cwd, workspace, journal);
  } finally {
    await lock.release();
  }
}

class RuntimeStoreBusyError extends Error {}
class RuntimeStoreUnsupportedError extends Error {}

async function resolveWalUnderLock(
  cwd: string,
  assessment: RuntimeStoreAssessment,
): Promise<{ assessment: RuntimeStoreAssessment; blockers: RuntimeStoreBlocker[] }> {
  const wal = assessment.blockers.filter(blocker => blocker.type === "activity-unproven"
    && blocker.message.includes("write-ahead log"));
  if (wal.length === 0) return { assessment, blockers: assessment.blockers };
  const other = assessment.blockers.filter(blocker => !wal.includes(blocker));
  if (other.length > 0 || assessment.current.state === "absent") {
    return { assessment, blockers: assessment.blockers };
  }
  try {
    const workspace = resolveRuntimeWorkspaceLayout(cwd);
    const layout = activityLayout(workspace, assessment.current);
    await assertRuntimeGenerationSealSafe(layout);
    if (!canReassessCrashWal(assessment)) return { assessment, blockers: [] };
    return {
      assessment: {
        ...assessment,
        blockers: [],
      },
      blockers: [],
    };
  } catch (error) {
    if (error instanceof RuntimeGenerationActiveError) {
      return {
        assessment,
        blockers: [{
          type: error.blocker === "run lease" ? "run-lease" : error.blocker === "daemon" ? "daemon" : "acp-ownership",
          message: error.message,
        }],
      };
    }
    return { assessment, blockers: assessment.blockers };
  }
}

function canReassessCrashWal(assessment: RuntimeStoreAssessment): boolean {
  return assessment.current.state === "update-required"
    && assessment.current.layoutVersion === 1
    && assessment.current.storageVersion === RUNTIME_STORAGE_VERSION
    && assessment.transition.type === "rollover"
    && assessment.blockers.some(blocker => blocker.type === "activity-unproven"
      && blocker.message.includes("write-ahead log"));
}

async function inspectRuntimeStoreValue(cwd: string): Promise<RuntimeStoreAssessment> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd);
  await validateRuntimeLayoutBoundary(workspace);
  const journal = await readTransitionJournal(workspace.transitionJournalPath);
  let generations: RuntimeGenerationSummary[] = [];
  let generationFailure: string | undefined;
  try {
    generations = await listRuntimeGenerations(cwd);
  } catch (error) {
    generationFailure = errorMessage(error);
  }
  let current: RuntimeStoreCurrent;
  let transition: RuntimeStoreTransition;
  let blockers: RuntimeStoreBlocker[] = [];

  if (journal) {
    current = {
      state: "recovery-required",
      layoutVersion: journal.observedLayoutVersion,
      detail: "A Runtime store repair is incomplete.",
    };
    transition = { type: "recover" };
  } else {
    const manifestRead = await readManifest(workspace.manifestPath);
    if (!manifestRead) {
      const stateExists = await anyPathExists([
        workspace.legacyRuntimeRoot,
        workspace.legacyArchivesRoot,
        workspace.generationsRoot,
      ]);
      if (stateExists) {
        current = {
          state: "recovery-required",
          detail: "The runtime workspace contains state but has no workspace manifest.",
        };
        transition = { type: "recover" };
      } else {
        current = { state: "absent" };
        transition = { type: "initialize" };
      }
    } else if (!hasSupportedManifestHeader(manifestRead.value)) {
      const observedLayoutVersion = isRecord(manifestRead.value)
        && Number.isSafeInteger(manifestRead.value.manifestVersion)
        && Number(manifestRead.value.manifestVersion) > RUNTIME_LAYOUT_VERSION
        ? Number(manifestRead.value.manifestVersion)
        : undefined;
      if (observedLayoutVersion !== undefined) {
        current = {
          state: "unsupported",
          layoutVersion: observedLayoutVersion,
          storageVersion: null,
          detail: `Runtime workspace uses newer layout v${observedLayoutVersion}; this Runtime targets layout v${RUNTIME_LAYOUT_VERSION}.`,
        };
        transition = { type: "none" };
      } else {
        current = { state: "recovery-required", detail: "The workspace manifest is malformed." };
        transition = { type: "recover" };
      }
    } else {
      const validation = validateWorkspaceManifest(manifestRead.value, workspace);
      if (validation.isErr()) {
        current = {
          state: "recovery-required",
          layoutVersion: manifestRead.value.manifestVersion,
          detail: validation.error.message,
        };
        transition = { type: "recover" };
      } else if (validation.value.manifestVersion === 1) {
        ({ current, transition } = await inspectLegacyStore(workspace));
      } else {
        ({ current, transition } = await inspectGenerationStore(cwd));
      }
    }
  }

  const partialGeneration = generations.find(generation => generation.state === "partial");
  if (!journal
    && (partialGeneration || generationFailure)
    && current.state !== "unsupported"
    && current.state !== "recovery-required") {
    current = {
      state: "recovery-required",
      layoutVersion: 2,
      ...(current.state === "absent" || current.generationId === undefined
        ? {}
        : { generationId: current.generationId }),
      detail: partialGeneration
        ? `Runtime generation '${partialGeneration.id}' is partial and requires recovery.`
        : generationFailure!,
    };
    transition = { type: "recover" };
  }
  if (journal) {
    const incompatible = await inspectJournalSourceCompatibility(workspace, journal);
    if (incompatible) ({ current, transition } = incompatible);
  } else if (current.state === "recovery-required") {
    const incompatible = await inspectRecoverySourceCompatibility(cwd, workspace, generations);
    if (incompatible) ({ current, transition } = incompatible);
  }
  if (transition.type !== "none" && current.state !== "absent") {
    blockers = await inspectActivityBlockers(activityLayout(workspace, current));
    for (const generation of generations.filter(candidate => candidate.state === "partial"
      && candidate.id !== current.generationId)) {
      blockers.push(...await inspectActivityBlockers(runtimeLayoutForGeneration(workspace, generation.id)));
    }
  }
  if (generationFailure) blockers.push({ type: "activity-unproven", message: generationFailure });
  blockers = blockers.filter((blocker, index) => blockers.findIndex(candidate => candidate.type === blocker.type
    && candidate.message === blocker.message) === index);
  return {
    current,
    transition,
    blockers,
    generations,
  };
}

async function inspectLegacyStore(
  layout: RuntimeLayout,
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition }> {
  let state: RuntimeGenerationState;
  try {
    state = await inspectRuntimeGeneration(layout);
  } catch (error) {
    if (error instanceof PartialRuntimeGenerationError) {
      return {
        current: { state: "recovery-required", layoutVersion: 1, detail: error.message },
        transition: { type: "recover" },
      };
    }
    throw error;
  }
  if (state === "absent" || state === "empty") {
    return {
      current: {
        state: "update-required",
        layoutVersion: 1,
        storageVersion: null,
      },
      transition: { type: "rollover" },
    };
  }
  let format;
  try {
    format = await readRuntimeDatabaseFormat(layout.databasePath);
  } catch {
    return unrecognizedStore(1);
  }
  if (!format) {
    return {
      current: { state: "recovery-required", layoutVersion: 1, detail: "The legacy runtime database is missing." },
      transition: { type: "recover" },
    };
  }
  if (format.applicationId !== RUNTIME_APPLICATION_ID) {
    return unsupportedStore(1, format);
  }
  if (format.userVersion > RUNTIME_STORAGE_VERSION) {
    return unsupportedStore(1, format);
  }
  if (format.userVersion <= 0) return unsupportedStore(1, format);
  return {
    current: {
      state: "update-required",
      layoutVersion: 1,
      storageVersion: format.userVersion,
    },
    transition: { type: "rollover" },
  };
}

async function inspectGenerationStore(
  cwd: string,
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition }> {
  let layout: RuntimeLayout;
  try {
    layout = resolveRuntimeLayout(cwd);
  } catch (error) {
    return {
      current: { state: "recovery-required", layoutVersion: 2, detail: errorMessage(error) },
      transition: { type: "recover" },
    };
  }
  if (!layout.generationId) {
    return {
      current: { state: "recovery-required", layoutVersion: 2, detail: "The active generation pointer is missing." },
      transition: { type: "recover" },
    };
  }
  let state: RuntimeGenerationState;
  try {
    state = await inspectRuntimeGeneration(layout);
  } catch (error) {
    if (error instanceof PartialRuntimeGenerationError) {
      return {
        current: {
          state: "recovery-required",
          layoutVersion: 2,
          generationId: layout.generationId,
          detail: error.message,
        },
        transition: { type: "recover" },
      };
    }
    throw error;
  }
  const metadata = await readGenerationMetadataForRecovery(layout.generationMetadataPath);
  if (!metadata || metadata.id !== layout.generationId) {
    return {
      current: {
        state: "recovery-required",
        layoutVersion: 2,
        generationId: layout.generationId,
        detail: `Active generation '${layout.generationId}' has invalid or missing metadata.`,
      },
      transition: { type: "recover" },
    };
  }
  if (metadata.archivedAt !== undefined) {
    return {
      current: {
        state: "recovery-required",
        layoutVersion: 2,
        generationId: layout.generationId,
        detail: `Active generation '${layout.generationId}' is marked as sealed.`,
      },
      transition: { type: "recover" },
    };
  }
  if (state === "empty") {
    return {
      current: {
        state: "update-required",
        layoutVersion: 2,
        storageVersion: null,
        generationId: layout.generationId,
      },
      transition: { type: "initialize" },
    };
  }
  if (state === "absent") {
    return {
      current: {
        state: "recovery-required",
        layoutVersion: 2,
        generationId: layout.generationId,
        detail: `Active generation '${layout.generationId}' is missing.`,
      },
      transition: { type: "recover" },
    };
  }
  let format;
  try {
    format = await readRuntimeDatabaseFormat(layout.databasePath);
  } catch {
    return unrecognizedStore(2, layout.generationId);
  }
  if (!format) {
    return {
      current: {
        state: "recovery-required",
        layoutVersion: 2,
        generationId: layout.generationId,
        detail: "The active runtime database is missing.",
      },
      transition: { type: "recover" },
    };
  }
  if (format.applicationId !== RUNTIME_APPLICATION_ID) {
    return unsupportedStore(2, format, layout.generationId);
  }
  if (format.userVersion > RUNTIME_STORAGE_VERSION) {
    return unsupportedStore(2, format, layout.generationId);
  }
  if (format.userVersion <= 0) return unsupportedStore(2, format, layout.generationId);
  if (format.userVersion === RUNTIME_STORAGE_VERSION) {
    return {
      current: {
        state: "ready",
        layoutVersion: 2,
        storageVersion: RUNTIME_STORAGE_VERSION,
        generationId: layout.generationId,
      },
      transition: { type: "none" },
    };
  }
  return {
    current: {
      state: "update-required",
      layoutVersion: 2,
      storageVersion: format.userVersion,
      generationId: layout.generationId,
    },
    transition: { type: "rollover" },
  };
}

async function inspectRecoverySourceCompatibility(
  cwd: string,
  workspace: RuntimeLayout,
  generations: RuntimeGenerationSummary[],
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } | undefined> {
  const generationIds = new Set<string>();
  try {
    const published = resolveRuntimeLayout(cwd).generationId;
    if (published) generationIds.add(published);
  } catch {
    // An invalid pointer is represented by the partial generation catalog below.
  }
  for (const generation of generations) {
    if (generation.state === "active" || generation.state === "partial") generationIds.add(generation.id);
  }
  if (await pathExists(workspace.legacyRuntimeRoot)) {
    const incompatible = await inspectSourceCompatibility(workspace, undefined, 1);
    if (incompatible) return incompatible;
  }
  for (const generationId of generationIds) {
    const layout = runtimeLayoutForGeneration(workspace, generationId);
    const incompatible = await inspectSourceCompatibility(layout, generationId, 2);
    if (incompatible) return incompatible;
  }
  return undefined;
}

async function inspectJournalSourceCompatibility(
  workspace: RuntimeLayout,
  journal: RuntimeStoreTransitionJournal,
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } | undefined> {
  for (const source of journal.sources) {
    if (source.kind === "legacy-archive") continue;
    for (const layout of journalSourceLayouts(workspace, source)) {
      if (!await pathExists(layout.runtimeRoot)) continue;
      const incompatible = await inspectSourceCompatibility(
        layout,
        source.generationId,
        journal.observedLayoutVersion,
      );
      if (incompatible) return incompatible;
    }
  }
  return undefined;
}

function journalSourceLayouts(workspace: RuntimeLayout, source: TransitionSource): RuntimeLayout[] {
  const destination = runtimeLayoutForGeneration(workspace, source.generationId);
  if (source.kind === "generation") return [destination];
  return [
    layoutAtRoot(workspace, source.kind === "legacy-runtime"
      ? workspace.legacyRuntimeRoot
      : join(workspace.legacyArchivesRoot, source.legacyName!)),
    destination,
  ];
}

async function inspectSourceCompatibility(
  layout: RuntimeLayout,
  generationId: string | undefined,
  layoutVersion: 1 | 2,
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } | undefined> {
  try {
    await assertRegularDirectory(layout.runtimeRoot, "Runtime generation");
    if (!await assertOptionalRegularFile(layout.databasePath, "Runtime database")) return undefined;
    await assertOptionalRegularFile(`${layout.databasePath}-wal`, "Runtime database WAL");
    await assertOptionalRegularFile(`${layout.databasePath}-shm`, "Runtime database shared memory");
  } catch {
    return undefined;
  }
  let format;
  try {
    format = await readRuntimeDatabaseFormat(layout.databasePath);
  } catch (error) {
    if (error instanceof UnrecognizedRuntimeDatabaseError) {
      return unrecognizedStore(layoutVersion, generationId);
    }
    throw error;
  }
  if (!format) return undefined;
  if (format.applicationId !== RUNTIME_APPLICATION_ID) {
    return unsupportedStore(layoutVersion, format, generationId);
  }
  if (format.userVersion > RUNTIME_STORAGE_VERSION) {
    return unsupportedStore(layoutVersion, format, generationId);
  }
  return format.userVersion <= 0
    ? unsupportedStore(layoutVersion, format, generationId)
    : undefined;
}

function unsupportedStore(
  layoutVersion: 1 | 2,
  format: { applicationId: number; userVersion: number },
  generationId?: string,
): { current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } {
  return {
    current: {
      state: "unsupported",
      layoutVersion,
      storageVersion: format.userVersion,
      detail: `Runtime database uses application_id ${format.applicationId} and storage v${format.userVersion}.`,
      ...(generationId === undefined ? {} : { generationId }),
    },
    transition: { type: "none" },
  };
}

function unrecognizedStore(
  layoutVersion: 1 | 2,
  generationId?: string,
): { current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } {
  return {
    current: {
      state: "unsupported",
      layoutVersion,
      storageVersion: null,
      detail: "Runtime store format is not supported by this version of Acpus.",
      ...(generationId === undefined ? {} : { generationId }),
    },
    transition: { type: "none" },
  };
}

type TransitionSource = {
  kind: "legacy-runtime" | "legacy-archive" | "generation";
  generationId: string;
  legacyName?: string;
  storageVersion: number | null;
  createdAt: string;
};

type RuntimeStoreTransitionJournal = {
  schemaVersion: typeof transitionSchemaVersion;
  startedAt: string;
  observedLayoutVersion: 1 | 2;
  nextGenerationId: string;
  sources: TransitionSource[];
};

async function createTransitionJournal(
  workspace: RuntimeLayout,
  assessment: RuntimeStoreAssessment,
): Promise<RuntimeStoreTransitionJournal> {
  const startedAt = new Date().toISOString();
  const sources: TransitionSource[] = [];
  for (const generation of assessment.generations.filter(candidate => candidate.state === "partial")) {
    const layout = runtimeLayoutForGeneration(workspace, generation.id);
    const format = await safeDatabaseFormat(layout);
    sources.push({
      kind: "generation",
      generationId: generation.id,
      storageVersion: format?.applicationId === RUNTIME_APPLICATION_ID ? format.userVersion : generation.storageVersion,
      createdAt: generation.createdAt,
    });
  }
  for (const archive of await legacyArchiveEntries(workspace)) {
    sources.push({
      kind: "legacy-archive",
      generationId: `gen_${randomUUID()}`,
      legacyName: archive.name,
      storageVersion: archive.storageVersion,
      createdAt: archive.createdAt,
    });
  }
  const publishedGenerationId = assessment.current.state === "absent"
    ? undefined
    : assessment.current.generationId
      ?? assessment.generations.find(generation => generation.state === "active")?.id;
  const observedLayoutVersion = assessment.current.state === "absent"
    ? 1
    : assessment.current.layoutVersion ?? (publishedGenerationId === undefined ? 1 : 2);
  if (observedLayoutVersion !== 1 && observedLayoutVersion !== 2) {
    throw new Error(`Cannot create a transition journal for layout v${observedLayoutVersion}.`);
  }
  const currentLayout = observedLayoutVersion === 1
    ? workspace
    : publishedGenerationId !== undefined
      ? runtimeLayoutForGeneration(workspace, publishedGenerationId)
      : undefined;
  if (currentLayout !== undefined && await pathExists(currentLayout.runtimeRoot)) {
    const format = await safeDatabaseFormat(currentLayout);
    const currentGeneration = assessment.generations.find(generation => generation.id === currentLayout.generationId);
    if (!sources.some(source => source.generationId === currentLayout.generationId)) sources.push({
      kind: observedLayoutVersion === 1 ? "legacy-runtime" : "generation",
      generationId: currentLayout.generationId ?? `gen_${randomUUID()}`,
      storageVersion: format?.userVersion ?? null,
      createdAt: currentGeneration?.createdAt ?? startedAt,
    });
  }
  return {
    schemaVersion: transitionSchemaVersion,
    startedAt,
    observedLayoutVersion,
    nextGenerationId: `gen_${randomUUID()}`,
    sources,
  };
}

async function resumeTransition(
  cwd: string,
  workspace: RuntimeLayout,
  journal: RuntimeStoreTransitionJournal,
): Promise<{ changed: boolean }> {
  await ensurePrivateDirectory(workspace.generationsRoot, workspace.platform);
  for (const source of journal.sources) {
    await sealTransitionSource(workspace, journal, source);
  }

  const next = runtimeLayoutForGeneration(workspace, journal.nextGenerationId);
  await ensureGenerationDirectories(next);
  const nextMetadata = await readGenerationMetadataForRecovery(next.generationMetadataPath);
  if (nextMetadata?.id !== journal.nextGenerationId) {
    await writeGenerationMetadata(next.generationMetadataPath, {
      schemaVersion: 1,
      id: journal.nextGenerationId,
      storageVersion: RUNTIME_STORAGE_VERSION,
      createdAt: journal.startedAt,
    });
  }
  const store = await openRuntimeStoreAtLayout(next, {
    lock: false,
    prevalidated: true,
    unpublished: true,
  });
  store.close();
  const nextFormat = await readRuntimeDatabaseFormat(next.databasePath);
  if (nextFormat?.applicationId !== RUNTIME_APPLICATION_ID
    || nextFormat.userVersion !== RUNTIME_STORAGE_VERSION) {
    throw new Error(`New generation '${next.generationId}' did not verify at storage v${RUNTIME_STORAGE_VERSION}.`);
  }

  const previousManifest = await readManifest(workspace.manifestPath);
  const manifest: WorkspaceManifest = {
    manifestVersion: 2,
    workspaceKey: workspace.workspaceKey,
    canonicalPath: workspace.canonicalPath,
    platform: workspace.platform,
    createdAt: isWorkspaceManifest(previousManifest?.value)
      ? previousManifest.value.createdAt
      : journal.startedAt,
    activeGenerationId: journal.nextGenerationId,
  };
  await writePrivateJsonAtomically(workspace.manifestPath, manifest);
  await rm(workspace.transitionJournalPath);

  const after = await inspectRuntimeStoreValue(cwd);
  if (after.current.state !== "ready") {
    throw new Error("Published runtime generation did not become ready.");
  }
  return { changed: true };
}

async function sealTransitionSource(
  workspace: RuntimeLayout,
  journal: RuntimeStoreTransitionJournal,
  source: TransitionSource,
): Promise<void> {
  const destination = runtimeLayoutForGeneration(workspace, source.generationId);
  if (!destination.generationRoot) throw new Error("Runtime generation root is unavailable.");
  await ensurePrivateDirectory(destination.generationRoot, destination.platform);
  if (source.kind === "generation" && !await pathExists(destination.runtimeRoot)) {
    await writeGenerationMetadata(destination.generationMetadataPath, {
      schemaVersion: 1,
      id: source.generationId,
      storageVersion: source.storageVersion,
      createdAt: source.createdAt,
      archivedAt: journal.startedAt,
    });
    return;
  }
  if (source.kind !== "generation") {
    const original = source.kind === "legacy-runtime"
      ? workspace.legacyRuntimeRoot
      : join(workspace.legacyArchivesRoot, source.legacyName!);
    const originalExists = await pathExists(original);
    const destinationExists = await pathExists(destination.runtimeRoot);
    if (originalExists && destinationExists) {
      throw new Error(`Both transition source '${original}' and generation '${source.generationId}' exist.`);
    }
    if (originalExists) {
      await assertRegularDirectory(original, "Runtime transition source");
      await rename(original, destination.runtimeRoot);
    }
    else if (!destinationExists) throw new Error(`Transition source for generation '${source.generationId}' is missing.`);
  } else if (!await pathExists(destination.runtimeRoot)) {
    throw new Error(`Generation '${source.generationId}' disappeared during transition.`);
  }
  await assertRegularDirectory(destination.runtimeRoot, "Runtime generation");

  const generationState = await safeGenerationState(destination);
  const runs = source.storageVersion === RUNTIME_STORAGE_VERSION && generationState === "complete"
    ? await extractPortableRunIndex(destination)
    : undefined;
  const readExisting = await readGenerationMetadataForRecovery(destination.generationMetadataPath);
  const existing = readExisting?.id === source.generationId ? readExisting : undefined;
  await writeGenerationMetadata(destination.generationMetadataPath, {
    schemaVersion: 1,
    id: source.generationId,
    storageVersion: source.storageVersion,
    createdAt: existing?.createdAt ?? source.createdAt,
    archivedAt: existing?.archivedAt ?? journal.startedAt,
  });
  if (runs !== undefined) await writeRunIndex(destination.runIndexPath, runs);
}

async function initializeCurrentStore(
  cwd: string,
): Promise<{ changed: boolean }> {
  const ensured = await ensureRuntimeLayout(cwd);
  if (ensured.isErr()) throw new Error(ensured.error.message);
  const store = await openRuntimeStoreAtLayout(ensured.value, { lock: false, prevalidated: true });
  store.close();
  const after = await inspectRuntimeStoreValue(cwd);
  if (after.current.state !== "ready") throw new Error("Initialized runtime generation did not become ready.");
  return { changed: true };
}

async function inspectActivityBlockers(layout: RuntimeLayout): Promise<RuntimeStoreBlocker[]> {
  const blockers: RuntimeStoreBlocker[] = [];
  try {
    const daemonStatus = await requestDaemonStatus(layout.canonicalPath);
    if (daemonStatus.isOk()) {
      blockers.push({
        type: "daemon",
        message: "Runtime store has a live daemon.",
      });
    } else if (daemonStatus.error.type !== "transport"
      || daemonStatus.error.reason !== "not-found" && daemonStatus.error.reason !== "refused") {
      blockers.push({
        type: "activity-unproven",
        message: `Runtime daemon activity cannot be proven safe: ${daemonStatus.error.message}`,
      });
    }
    if (!await pathExists(layout.runtimeRoot)) return blockers;
    await assertRegularDirectory(layout.runtimeRoot, "Runtime generation");
    let workers;
    try {
      workers = await lstat(layout.acpWorkersRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (workers) {
      if (workers.isSymbolicLink() || !workers.isDirectory()) {
        throw new Error(`ACP ownership directory '${layout.acpWorkersRoot}' is not a regular directory.`);
      }
      if ((await readdir(layout.acpWorkersRoot)).length > 0) {
        blockers.push({
          type: "acp-ownership",
          message: "Runtime store has active ACP ownership.",
        });
      }
    }
    if (!await assertOptionalRegularFile(layout.databasePath, "Runtime database")) return blockers;
    await assertOptionalRegularFile(`${layout.databasePath}-wal`, "Runtime database WAL");
    await assertOptionalRegularFile(`${layout.databasePath}-shm`, "Runtime database shared memory");
    if (!await hasNoPendingRuntimeDatabaseWal(layout.databasePath)) {
      blockers.push({
        type: "activity-unproven",
        message: "Runtime store has an uncheckpointed write-ahead log.",
      });
      return blockers;
    }
    const database = await openRuntimeDatabase(layout.databasePath, {
      readOnly: true,
      immutable: true,
    });
    try {
      const tables = new Set((database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('daemon_lease', 'run_leases')
      `).all() as Array<{ name: unknown }>).map(row => String(row.name)));
      if (tables.has("run_leases")) {
        const active = database.prepare(`
          SELECT COUNT(*) AS count
          FROM run_leases
          WHERE released_at IS NULL AND lease_expires_at > ?
        `).get(new Date().toISOString()) as { count: unknown };
        if (Number(active.count) > 0) blockers.push({
          type: "run-lease",
          message: "Runtime store has an active run lease.",
        });
      }
      if (tables.has("daemon_lease")) {
        const daemon = database.prepare(`
          SELECT pid FROM daemon_lease ORDER BY updated_at DESC LIMIT 1
        `).get() as { pid: unknown } | undefined;
        const pid = Number(daemon?.pid);
        if (!blockers.some(blocker => blocker.type === "daemon")
          && Number.isSafeInteger(pid) && pid > 0 && probeProcessLiveness(pid) !== "dead") {
          blockers.push({
            type: "daemon",
            message: "Runtime store has an active daemon.",
          });
        }
      }
    } finally {
      database.close();
    }
    return blockers;
  } catch (error) {
    return [...blockers, {
      type: "activity-unproven",
      message: `Runtime store activity cannot be proven safe: ${errorMessage(error)}`,
    }];
  }
}

async function stopDaemonGracefully(
  cwd: string,
): Promise<void> {
  const status = await requestDaemonStatus(cwd);
  if (status.isErr()) {
    if (status.error.type === "transport"
      && (status.error.reason === "not-found" || status.error.reason === "refused")) return;
    throw new RuntimeStoreBusyError(status.error.message);
  }
  const shutdown = await requestDaemonShutdown(cwd);
  if (shutdown.isErr()) throw new RuntimeStoreBusyError(shutdown.error.message);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const polled = await requestDaemonStatus(cwd);
    if (polled.isErr() && polled.error.type === "transport"
      && (polled.error.reason === "not-found" || polled.error.reason === "refused")) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new RuntimeStoreBusyError("The daemon did not stop within 30 seconds.");
}

async function extractPortableRunIndex(
  layout: RuntimeLayout,
  immutableInspection = false,
): Promise<ArchivedRunSummary[] | undefined> {
  let info;
  try {
    info = await lstat(layout.databasePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Runtime database '${layout.databasePath}' is not a regular file.`);
  }
  if (immutableInspection && !await hasNoPendingRuntimeDatabaseWal(layout.databasePath)) return undefined;
  const database = await openRuntimeDatabase(layout.databasePath, {
    readOnly: true,
    immutable: immutableInspection,
  });
  try {
    const application = database.prepare("PRAGMA application_id").get() as { application_id: unknown };
    const version = database.prepare("PRAGMA user_version").get() as { user_version: unknown };
    if (Number(application.application_id) !== RUNTIME_APPLICATION_ID
      || Number(version.user_version) !== RUNTIME_STORAGE_VERSION) return undefined;
    const columns = new Set((database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: unknown }>)
      .map(column => String(column.name)));
    if (!["id", "name", "status", "created_at", "updated_at"].every(column => columns.has(column))) return undefined;
    const rows = database.prepare(`
      SELECT id, name, status, created_at, updated_at
      FROM runs
      ORDER BY updated_at DESC, created_at DESC, id ASC
    `).all() as Array<Record<string, unknown>>;
    const runs = rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    if (!runs.every(isPortableRun)) return undefined;
    return runs;
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

async function legacyArchiveEntries(
  layout: RuntimeLayout,
): Promise<Array<{
  name: string;
  storageVersion: number | null;
  createdAt: string;
}>> {
  let entries;
  try {
    const root = await lstat(layout.legacyArchivesRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      throw new Error(`Legacy runtime archives root '${layout.legacyArchivesRoot}' is not a regular directory.`);
    }
    entries = await readdir(layout.legacyArchivesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const archives: Array<{
    name: string;
    storageVersion: number | null;
    createdAt: string;
  }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(layout.legacyArchivesRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Legacy runtime archive '${path}' is not a regular directory.`);
    }
    const archived = layoutAtRoot(layout, path);
    const format = await safeDatabaseFormat(archived);
    const stat = await lstat(path);
    archives.push({
      name: entry.name,
      storageVersion: format?.applicationId === RUNTIME_APPLICATION_ID
        ? format.userVersion
        : archiveVersion(entry.name),
      createdAt: archiveTime(entry.name) ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    });
  }
  return archives;
}

function layoutAtRoot(layout: RuntimeLayout, runtimeRoot: string): RuntimeLayout {
  return {
    ...layout,
    runtimeRoot,
    databasePath: join(runtimeRoot, "runtime.db"),
    runsRoot: join(runtimeRoot, "runs"),
    sourcesRoot: join(runtimeRoot, "sources"),
    trashRoot: join(runtimeRoot, "trash"),
    acpRoot: join(runtimeRoot, "acp"),
    acpWorkersRoot: join(runtimeRoot, "acp", "workers"),
    generationMetadataPath: join(runtimeRoot, "generation.json"),
    runIndexPath: join(runtimeRoot, "run-index.json"),
  };
}

async function ensureGenerationDirectories(layout: RuntimeLayout): Promise<void> {
  for (const path of [layout.generationRoot, layout.runtimeRoot, layout.runsRoot, layout.sourcesRoot, layout.trashRoot, layout.acpRoot, layout.acpWorkersRoot]) {
    if (path === undefined) continue;
    await ensurePrivateDirectory(path, layout.platform);
  }
}

async function ensurePrivateDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Runtime-owned path '${path}' is not a regular directory.`);
  }
  if (platform !== "win32") await chmod(path, 0o700);
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${path}' is not a regular directory.`);
  }
}

async function assertOptionalRegularFile(path: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} '${path}' is not a regular file.`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readManifest(path: string): Promise<{ value: unknown } | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Workspace manifest '${path}' is not a regular file.`);
  }
  const raw = await readFile(path, "utf8");
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { value: undefined };
  }
}

async function readTransitionJournal(path: string): Promise<RuntimeStoreTransitionJournal | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Runtime transition journal '${path}' is not a regular file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Runtime transition journal '${path}' is not valid JSON.`);
  }
  if (!isTransitionJournal(value)) {
    throw new Error(`Runtime transition journal '${path}' does not match schema version ${transitionSchemaVersion}.`);
  }
  return value;
}

function activityLayout(workspace: RuntimeLayout, current: RuntimeStoreCurrent): RuntimeLayout {
  if (current.state !== "absent" && current.layoutVersion === 2 && current.generationId) {
    return runtimeLayoutForGeneration(workspace, current.generationId);
  }
  return workspace;
}

function hasSupportedManifestHeader(value: unknown): value is WorkspaceManifest {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && ((value as Record<string, unknown>).manifestVersion === 1 || (value as Record<string, unknown>).manifestVersion === 2)
    && isCanonicalTimestamp((value as Record<string, unknown>).createdAt);
}

function isTransitionJournal(value: unknown): value is RuntimeStoreTransitionJournal {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "startedAt",
      "observedLayoutVersion",
      "nextGenerationId",
      "sources",
    ])
    || value.schemaVersion !== transitionSchemaVersion
    || !isCanonicalTimestamp(value.startedAt)
    || (value.observedLayoutVersion !== 1 && value.observedLayoutVersion !== 2)
    || typeof value.nextGenerationId !== "string"
    || !isGenerationId(value.nextGenerationId)
    || !Array.isArray(value.sources)) return false;
  const sources = value.sources as unknown[];
  if (new Set(sources.flatMap(source => isRecord(source) && typeof source.generationId === "string"
    ? [source.generationId]
    : [])).size !== sources.length
    || sources.some(source => isRecord(source) && source.generationId === value.nextGenerationId)) return false;
  return sources.every(source => isRecord(source)
    && hasExactKeys(source, ["kind", "generationId", "storageVersion", "createdAt"], ["legacyName"])
    && ["legacy-runtime", "legacy-archive", "generation"].includes(String(source.kind))
    && typeof source.generationId === "string"
    && isGenerationId(source.generationId)
    && (source.storageVersion === null || Number.isSafeInteger(source.storageVersion) && Number(source.storageVersion) >= 0)
    && isCanonicalTimestamp(source.createdAt)
    && (source.kind === "legacy-archive"
      ? isSafeLegacyArchiveName(source.legacyName)
      : source.legacyName === undefined));
}

function isSafeLegacyArchiveName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !/[\\/]/.test(value);
}

function isPortableRun(value: unknown): value is ArchivedRunSummary {
  return isRecord(value)
    && hasExactKeys(value, ["id", "name", "status", "createdAt", "updatedAt"])
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && typeof value.status === "string"
    && isCanonicalTimestamp(value.createdAt)
    && isCanonicalTimestamp(value.updatedAt);
}

async function safeGenerationState(layout: RuntimeLayout): Promise<RuntimeGenerationState | undefined> {
  try {
    return await inspectRuntimeGeneration(layout);
  } catch {
    return undefined;
  }
}

async function safeDatabaseFormat(layout: RuntimeLayout): Promise<{ applicationId: number; userVersion: number } | undefined> {
  try {
    return await readRuntimeDatabaseFormat(layout.databasePath);
  } catch {
    return undefined;
  }
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const path of paths) if (await pathExists(path)) return true;
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function archiveVersion(name: string): number | null {
  const match = /-v(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function archiveTime(name: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z-v\d+$/.exec(name);
  if (!match) return undefined;
  const values = match.slice(1).map(Number);
  const date = new Date(Date.UTC(values[0]!, values[1]! - 1, values[2]!, values[3]!, values[4]!, values[5]!, values[6]!));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
