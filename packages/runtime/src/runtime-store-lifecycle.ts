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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  requestDaemonShutdownAtEndpointResult,
  requestDaemonStatusAtEndpointResult,
  requestDaemonStatusProbeAtEndpointResult,
  requestPredecessorDaemonShutdownAtEndpointResult,
} from "./daemon/client.js";
import { probeProcessIdentity } from "./process-liveness.js";
import {
  RUNTIME_LAYOUT_VERSION,
  ensureRuntimeLayoutAtWorkspaceValue,
  isGenerationId,
  isWorkspaceManifest,
  resolveRuntimeLayoutAtWorkspace,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
  validateRuntimeLayoutBoundary,
  validateWorkspaceManifest,
  type RuntimeLayout,
  type RuntimeLayoutOptions,
  type WorkspaceManifest,
} from "./runtime-layout.js";
import {
  listRuntimeGenerationsAtLayout,
  type RuntimeGenerationSummary,
} from "./runtime-history.js";
import { acquireRuntimeExclusiveLock, RuntimeLockTimeoutError } from "./runtime-lock.js";
import { initializeRuntimeStoreAdapterAtLayout } from "./store/store.js";
import {
  hasNoPendingRuntimeDatabaseWal,
  openRuntimeDatabase,
  readRuntimeDatabaseFormat,
  RUNTIME_APPLICATION_ID,
  RuntimeDatabaseProbeChangedError,
  RUNTIME_STORAGE_VERSION,
  UnrecognizedRuntimeDatabaseError,
} from "./storage/database.js";
import {
  inspectRuntimeGeneration,
  PartialRuntimeGenerationError,
  type RuntimeGenerationState,
} from "./storage/generation.js";
import {
  H1_RUN_INDEX_STORAGE_VERSION,
  readGenerationMetadataForRecovery,
  writeGenerationMetadata,
  writeRunIndex,
  type ArchivedRunSummary,
} from "./storage/generation-metadata.js";
import { writePrivateJsonAtomically } from "./storage/private-json.js";

const transitionSchemaVersion = 1;
const runtimeOfflineWaitMs = 30_000;

type RuntimeStoreTarget = Readonly<{
  workspace: RuntimeLayout;
  options: RuntimeLayoutOptions;
}>;

type RuntimeStoreBlocker = {
  type: "runtime-authority" | "run-lease" | "acp-ownership" | "activity-unproven";
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
  reason: "busy" | "unreadable" | "failed";
  message: string;
};

export type RuntimeStoreStatus =
  | { state: "ready" }
  | { state: "repairable"; message: string }
  | { state: "unsupported"; message: string };

export type RuntimeStoreFailure = {
  type: "busy" | "unsupported" | "unreadable" | "failed";
  message: string;
};

export type RuntimeStoreOfflineFailure = {
  type: "busy" | "unavailable";
  message: string;
};

class RuntimeGenerationActiveError extends Error {
  constructor(
    readonly path: string,
    readonly blocker: "run lease" | "runtime authority" | "ACP ownership",
  ) {
    super(`Runtime generation '${path}' has an active ${blocker} and cannot be sealed.`);
    this.name = "RuntimeGenerationActiveError";
  }
}

class RuntimeStoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeStoreUnreadableError";
  }
}

function resolveRuntimeStoreTarget(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): RuntimeStoreTarget {
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  return {
    workspace,
    options: { ...options, runtimeHome: workspace.home },
  };
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
      WHERE type = 'table' AND name IN ('runtime_authority', 'run_leases')
    `).all() as Array<{ name: string }>).map(row => row.name));
    if (tables.has("run_leases")) {
      const active = database.prepare(`
        SELECT COUNT(*) AS count
        FROM run_leases
        WHERE released_at IS NULL AND lease_expires_at > ?
      `).get(new Date().toISOString()) as { count: number };
      if (active.count > 0) throw new RuntimeGenerationActiveError(layout.runtimeRoot, "run lease");
    }
    if (tables.has("runtime_authority")) {
      const authority = database.prepare(`
        SELECT pid, process_start_token
        FROM runtime_authority
        WHERE released_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `).get() as { pid: number | null; process_start_token: string | null } | undefined;
      if (authority?.pid && probeProcessIdentity({
        pid: authority.pid,
        ...(authority.process_start_token === null ? {} : { startToken: authority.process_start_token }),
      }) !== "dead") {
        throw new RuntimeGenerationActiveError(layout.runtimeRoot, "runtime authority");
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
): Effect.Effect<RuntimeStoreStatus, RuntimeStoreFailure> {
  return Effect.gen(function* () {
    const inspected = yield* inspectRuntimeStoreInternal(cwd);
    if (Result.isFailure(inspected)) return yield* Effect.fail({
      type: inspected.failure.reason,
      message: inspected.failure.reason === "busy" || inspected.failure.reason === "unreadable"
        ? inspected.failure.message
        : "The Runtime store could not be inspected.",
    });
    const current = inspected.success.current;
    if (current.state === "absent" || current.state === "ready") return { state: "ready" as const };
    if (current.state === "unsupported") return {
      state: "unsupported" as const,
      message: current.detail,
    };
    return {
      state: "repairable" as const,
      message: "The Runtime store needs repair for this version of Acpus.",
    };
  });
}

export function repairRuntimeStore(
  cwd: string,
): Effect.Effect<{ changed: boolean }, RuntimeStoreFailure> {
  return repairRuntimeStoreInternal(cwd).pipe(Effect.flatMap(Effect.fromResult));
}

export function repairRuntimeStoreInternal(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Effect.Effect<Result.Result<{ changed: boolean }, RuntimeStoreFailure>> {
  return Effect.result(repairRuntimeStoreValue(cwd, options)).pipe(Effect.map(result => Result.mapError(result, error => ({
      type: error instanceof RuntimeStoreBusyError || error instanceof RuntimeDatabaseProbeChangedError ? "busy"
        : error instanceof RuntimeStoreUnreadableError ? "unreadable"
          : error instanceof RuntimeStoreUnsupportedError ? "unsupported"
            : "failed",
      message: error instanceof RuntimeDatabaseProbeChangedError
        ? error.message
        : error instanceof RuntimeStoreUnreadableError
          ? error.message
          : error instanceof RuntimeStoreBusyError
            ? "The Runtime store is busy. Stop active runs and try again."
            : error instanceof RuntimeStoreUnsupportedError
              ? error.message
              : "The Runtime store could not be repaired.",
    }))));
}

export function inspectRuntimeStoreInternal(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Effect.Effect<Result.Result<RuntimeStoreAssessment, RuntimeStoreInspectFailure>> {
  return Effect.result(inspectRuntimeStoreValue(cwd, options)).pipe(Effect.map(result => Result.mapError(result, error => ({
      type: "inspect-failed",
      reason: error instanceof RuntimeDatabaseProbeChangedError ? "busy"
        : error instanceof RuntimeStoreUnreadableError ? "unreadable"
          : "failed",
      message: errorMessage(error),
    }))));
}

export function initializeRuntimeStoreIfAbsent(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Effect.Effect<void, unknown> {
  const target = resolveRuntimeStoreTarget(cwd, options);
  const workspace = target.workspace;
  return Effect.scoped(Effect.gen(function*() {
    yield* promise(() => ensurePrivateDirectory(workspace.home, workspace.platform));
    yield* acquireRuntimeExclusiveLock(workspace);
    const assessment = yield* inspectRuntimeStoreAtTarget(target);
    if (assessment.current.state === "absent") yield* initializeCurrentStore(target);
  }));
}

export function awaitRuntimeStoreOffline(
  cwd: string,
): Effect.Effect<void, RuntimeStoreOfflineFailure> {
  return awaitRuntimeStoreOfflineValue(cwd).pipe(Effect.mapError(error => ({
      type: error instanceof RuntimeStoreBusyError || error instanceof RuntimeLockTimeoutError
        ? "busy"
        : "unavailable",
      message: errorMessage(error),
    })));
}

function awaitRuntimeStoreOfflineValue(cwd: string): Effect.Effect<void, unknown> {
  const target = resolveRuntimeStoreTarget(cwd);
  const workspace = target.workspace;
  return Effect.gen(function*() {
    const status = yield* requestDaemonStatusAtEndpointResult(target.workspace.daemonEndpoint);
    if (Result.isSuccess(status)) {
      return yield* Effect.fail(new RuntimeStoreBusyError("Runtime store has a live Runtime authority."));
    }
    if (status.failure.type !== "transport"
      || status.failure.reason !== "not-found" && status.failure.reason !== "refused") {
      return yield* Effect.fail(new Error(`Runtime daemon activity cannot be proven offline: ${status.failure.message}`));
    }
    yield* Effect.scoped(Effect.gen(function*() {
      yield* acquireOfflineExclusiveLock(workspace);
      yield* promise(async () => {
        let layout: RuntimeLayout;
        try {
          layout = resolveRuntimeLayoutAtWorkspace(workspace);
        } catch (error) {
          if (!await pathExists(workspace.workspaceRoot)) return;
          throw error;
        }
        if (!await pathExists(layout.runtimeRoot)) return;
        try {
          await assertRuntimeGenerationSealSafe(layout);
        } catch (error) {
          if (error instanceof RuntimeGenerationActiveError) throw new RuntimeStoreBusyError(error.message);
          throw error;
        }
      });
    }));
  });
}

function acquireOfflineExclusiveLock(layout: RuntimeLayout) {
  return Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + runtimeOfflineWaitMs;
    while (true) {
      const acquired = yield* Effect.result(acquireRuntimeExclusiveLock(layout));
      if (Result.isSuccess(acquired)) return acquired.success;
      const error = acquired.failure;
      if (!(error instanceof RuntimeLockTimeoutError)) return yield* Effect.fail(error);
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.fail(new RuntimeStoreBusyError(error.message));
      }
      yield* Effect.sleep(100);
    }
  });
}

function repairRuntimeStoreValue(
  cwd: string,
  options: RuntimeLayoutOptions,
): Effect.Effect<{ changed: boolean }, unknown> {
  return Effect.scoped(Effect.gen(function*() {
    const target = resolveRuntimeStoreTarget(cwd, options);
    let first: RuntimeStoreAssessment | undefined;
    const inspected = yield* Effect.result(inspectRuntimeStoreAtTarget(target));
    if (Result.isSuccess(inspected)) first = inspected.success;
    // An online WAL probe is only a no-op/unsupported preflight. If it races a
    // writer, retire the daemon and make the authoritative decision offline.
    else if (!(inspected.failure instanceof RuntimeDatabaseProbeChangedError)) {
      return yield* Effect.fail(inspected.failure);
    }
    if (first?.current.state === "absent" || first?.current.state === "ready") return { changed: false };
    if (first?.current.state === "unsupported") {
      return yield* Effect.fail(new RuntimeStoreUnsupportedError(first.current.detail));
    }
    yield* stopDaemonGracefully(target.workspace);
    const workspace = target.workspace;
    const acquired = yield* Effect.result(acquireRuntimeExclusiveLock(workspace));
    if (Result.isFailure(acquired)) {
      const error = acquired.failure;
      if (error instanceof RuntimeLockTimeoutError) {
        const latest = yield* Effect.result(inspectRuntimeStoreAtTarget(target));
        if (Result.isSuccess(latest)) {
          const current = latest.success.current;
          if (current.state === "absent" || current.state === "ready") return { changed: false };
          if (current.state === "unsupported") {
            return yield* Effect.fail(new RuntimeStoreUnsupportedError(current.detail));
          }
        }
        return yield* Effect.fail(new RuntimeStoreBusyError(error.message));
      }
      return yield* Effect.fail(error);
    }
    const checked = yield* inspectRuntimeStoreAtTarget(target);
    if (checked.current.state === "absent" || checked.current.state === "ready") return { changed: false };
    if (checked.current.state === "unsupported") {
      return yield* Effect.fail(new RuntimeStoreUnsupportedError(checked.current.detail));
    }
    const resolved = yield* promise(() => resolveWalUnderLock(workspace, checked));
    if (resolved.blockers.length > 0) {
      return yield* Effect.fail(
        new RuntimeStoreBusyError(resolved.blockers.map(blocker => blocker.message).join(" ")),
      );
    }
    const assessment = resolved.assessment;
    if (assessment.current.state === "unsupported") {
      return yield* Effect.fail(new RuntimeStoreUnsupportedError(assessment.current.detail));
    }
    yield* promise(async () => {
      for (const directory of [workspace.home, join(workspace.home, "workspaces"), workspace.workspaceRoot]) {
        await ensurePrivateDirectory(directory, workspace.platform);
      }
    });
    const existingJournal = yield* promise(() => readTransitionJournal(workspace.transitionJournalPath));
    if (existingJournal) return yield* promise(() => resumeTransition(target, existingJournal));
    if (assessment.transition.type === "initialize" && assessment.current.state !== "absent") {
      return yield* initializeCurrentStore(target);
    }
    if (assessment.transition.type === "none") {
      return yield* Effect.fail(new Error("Runtime store does not need repair."));
    }
    const journal = yield* promise(() => createTransitionJournal(workspace, assessment));
    yield* promise(() => writePrivateJsonAtomically(workspace.transitionJournalPath, journal));
    return yield* promise(() => resumeTransition(target, journal));
  }));
}

class RuntimeStoreBusyError extends Error {}
class RuntimeStoreUnsupportedError extends Error {}

async function resolveWalUnderLock(
  workspace: RuntimeLayout,
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
          type: error.blocker === "run lease"
            ? "run-lease"
            : error.blocker === "runtime authority" ? "runtime-authority" : "acp-ownership",
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

function inspectRuntimeStoreValue(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Effect.Effect<RuntimeStoreAssessment, unknown> {
  return inspectRuntimeStoreAtTarget(resolveRuntimeStoreTarget(cwd, options));
}

function inspectRuntimeStoreAtTarget(
  target: RuntimeStoreTarget,
): Effect.Effect<RuntimeStoreAssessment, unknown> {
  return Effect.gen(function*() {
    const workspace = target.workspace;
    yield* promise(() => validateRuntimeLayoutBoundary(workspace));
    const journal = yield* promise(() => readTransitionJournal(workspace.transitionJournalPath));
    let generations: RuntimeGenerationSummary[] = [];
    let generationFailure: string | undefined;
    const listed = yield* Effect.result(promise(() => listRuntimeGenerationsAtLayout(workspace)));
    if (Result.isSuccess(listed)) generations = listed.success;
    else generationFailure = errorMessage(listed.failure);
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
    const manifestRead = yield* promise(() => readManifest(workspace.manifestPath));
    if (!manifestRead) {
      const stateExists = yield* promise(() => anyPathExists([
        workspace.legacyRuntimeRoot,
        workspace.legacyArchivesRoot,
        workspace.generationsRoot,
      ]));
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
      if (Result.isFailure(validation)) {
        current = {
          state: "recovery-required",
          layoutVersion: manifestRead.value.manifestVersion,
          detail: validation.failure.message,
        };
        transition = { type: "recover" };
      } else if (validation.success.manifestVersion === 1) {
        ({ current, transition } = yield* promise(() => inspectLegacyStore(workspace)));
      } else {
        ({ current, transition } = yield* promise(() => inspectGenerationStore(workspace)));
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
    const incompatible = yield* promise(() => inspectJournalSourceCompatibility(workspace, journal));
    if (incompatible) ({ current, transition } = incompatible);
  } else if (current.state === "recovery-required") {
    const incompatible = yield* promise(() => inspectRecoverySourceCompatibility(workspace, generations));
    if (incompatible) ({ current, transition } = incompatible);
  }
  if (transition.type !== "none" && current.state !== "absent") {
    blockers = yield* inspectActivityBlockers(activityLayout(workspace, current));
    for (const generation of generations.filter(candidate => candidate.state === "partial"
      && candidate.id !== current.generationId)) {
      blockers.push(...(yield* inspectActivityBlockers(runtimeLayoutForGeneration(workspace, generation.id))));
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
  });
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
  } catch (error) {
    if (error instanceof UnrecognizedRuntimeDatabaseError) return unrecognizedStore(1);
    throw error;
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
  workspace: RuntimeLayout,
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition }> {
  let layout: RuntimeLayout;
  try {
    layout = resolveRuntimeLayoutAtWorkspace(workspace);
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
  } catch (error) {
    if (error instanceof UnrecognizedRuntimeDatabaseError) return unrecognizedStore(2, layout.generationId);
    throw error;
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
  workspace: RuntimeLayout,
  generations: RuntimeGenerationSummary[],
): Promise<{ current: RuntimeStoreCurrent; transition: RuntimeStoreTransition } | undefined> {
  const generationIds = new Set<string>();
  try {
    const published = resolveRuntimeLayoutAtWorkspace(workspace).generationId;
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
  target: RuntimeStoreTarget,
  journal: RuntimeStoreTransitionJournal,
): Promise<{ changed: boolean }> {
  const workspace = target.workspace;
  await ensurePrivateDirectory(workspace.generationsRoot, workspace.platform);
  for (const source of journal.sources) {
    await sealTransitionSource(workspace, journal, source);
  }

  const next = runtimeLayoutForGeneration(workspace, journal.nextGenerationId);
  await ensureGenerationDirectories(next);
  const nextMetadataExists = await pathExists(next.generationMetadataPath);
  const nextMetadata = await readGenerationMetadataForRecovery(next.generationMetadataPath);
  if (nextMetadataExists) {
    if (nextMetadata?.id !== journal.nextGenerationId
      || nextMetadata.storageVersion !== RUNTIME_STORAGE_VERSION
      || nextMetadata.createdAt !== journal.startedAt
      || nextMetadata.archivedAt !== undefined) {
      throw new RuntimeStoreUnreadableError(
        `New generation '${journal.nextGenerationId}' changed identity during transition.`,
      );
    }
  } else {
    await writeGenerationMetadata(next.generationMetadataPath, {
      schemaVersion: 1,
      id: journal.nextGenerationId,
      storageVersion: RUNTIME_STORAGE_VERSION,
      createdAt: journal.startedAt,
    });
  }
  await initializeRuntimeStoreAdapterAtLayout(next, {
    lock: false,
    prevalidated: true,
    unpublished: true,
  });
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
  await validatePublishedRuntimeGeneration(workspace, journal.nextGenerationId);
  await rm(workspace.transitionJournalPath);
  return { changed: true };
}

async function validatePublishedRuntimeGeneration(
  workspace: RuntimeLayout,
  expectedGenerationId: string,
): Promise<void> {
  const published = await inspectGenerationStore(workspace);
  if (published.current.state !== "ready"
    || published.current.generationId !== expectedGenerationId
    || published.transition.type !== "none") {
    throw new Error(`Published runtime generation '${expectedGenerationId}' did not become ready.`);
  }
}

async function sealTransitionSource(
  workspace: RuntimeLayout,
  journal: RuntimeStoreTransitionJournal,
  source: TransitionSource,
): Promise<void> {
  const destination = runtimeLayoutForGeneration(workspace, source.generationId);
  if (!destination.generationRoot) throw new Error("Runtime generation root is unavailable.");
  const original = source.kind === "legacy-runtime"
    ? workspace.legacyRuntimeRoot
    : source.kind === "legacy-archive"
      ? join(workspace.legacyArchivesRoot, source.legacyName!)
      : undefined;
  const originalExists = original === undefined ? false : await pathExists(original);
  const destinationExists = await pathExists(destination.runtimeRoot);
  if (source.kind === "generation" && !await pathExists(destination.generationRoot)) {
    throw new RuntimeStoreUnreadableError(`Generation '${source.generationId}' disappeared during transition.`);
  }
  if (original !== undefined && originalExists === destinationExists) {
    throw new RuntimeStoreUnreadableError(originalExists
      ? `Both transition source '${original}' and generation '${source.generationId}' exist.`
      : `Transition source for generation '${source.generationId}' is missing.`);
  }
  await ensurePrivateDirectory(destination.generationRoot, destination.platform);
  if (source.kind === "generation" && !destinationExists) {
    if (source.storageVersion !== null || await pathExists(destination.generationMetadataPath)) {
      throw new RuntimeStoreUnreadableError(`Generation '${source.generationId}' changed identity during transition.`);
    }
    await writeGenerationMetadata(destination.generationMetadataPath, {
      schemaVersion: 1,
      id: source.generationId,
      storageVersion: source.storageVersion,
      createdAt: source.createdAt,
      archivedAt: journal.startedAt,
    });
    return;
  }
  if (original !== undefined && originalExists) {
    await assertRegularDirectory(original, "Runtime transition source");
    await rename(original, destination.runtimeRoot);
  }
  await assertRegularDirectory(destination.runtimeRoot, "Runtime generation");

  const generationState = await safeGenerationState(destination);
  const runs = source.storageVersion === H1_RUN_INDEX_STORAGE_VERSION && generationState === "complete"
    ? await extractPortableRunIndex(destination)
    : undefined;
  const metadataExists = await pathExists(destination.generationMetadataPath);
  const readExisting = await readGenerationMetadataForRecovery(destination.generationMetadataPath);
  if (metadataExists
    && (!readExisting
      || readExisting.id !== source.generationId
      || readExisting.storageVersion !== source.storageVersion
      || readExisting.createdAt !== source.createdAt
      || readExisting.archivedAt !== undefined && readExisting.archivedAt !== journal.startedAt)) {
    throw new RuntimeStoreUnreadableError(
      `Generation '${source.generationId}' changed identity during transition.`,
    );
  }
  await writeGenerationMetadata(destination.generationMetadataPath, {
    schemaVersion: 1,
    id: source.generationId,
    storageVersion: source.storageVersion,
    createdAt: source.createdAt,
    archivedAt: journal.startedAt,
  });
  if (runs !== undefined) await writeRunIndex(destination.runIndexPath, runs);
}

function initializeCurrentStore(
  target: RuntimeStoreTarget,
): Effect.Effect<{ changed: boolean }, unknown> {
  return Effect.gen(function*() {
    const ensured = yield* promise(() => ensureRuntimeLayoutAtWorkspaceValue(target.workspace, target.options));
    yield* promise(() => initializeRuntimeStoreAdapterAtLayout(ensured, { lock: false, prevalidated: true }));
    const after = yield* inspectRuntimeStoreAtTarget(target);
    if (after.current.state !== "ready") {
      return yield* Effect.fail(new Error("Initialized runtime generation did not become ready."));
    }
    return { changed: true };
  });
}

function inspectActivityBlockers(layout: RuntimeLayout): Effect.Effect<RuntimeStoreBlocker[], unknown> {
  return Effect.gen(function*() {
    const daemonStatus = yield* requestDaemonStatusAtEndpointResult(layout.daemonEndpoint);
    return yield* promise(async (): Promise<RuntimeStoreBlocker[]> => {
      const blockers: RuntimeStoreBlocker[] = [];
      try {
    if (Result.isSuccess(daemonStatus)) {
      blockers.push({
        type: "runtime-authority",
        message: "Runtime store has a live Runtime authority.",
      });
    } else if (daemonStatus.failure.type !== "transport"
      || daemonStatus.failure.reason !== "not-found" && daemonStatus.failure.reason !== "refused") {
      blockers.push({
        type: "activity-unproven",
        message: `Runtime daemon activity cannot be proven safe: ${daemonStatus.failure.message}`,
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
        WHERE type = 'table' AND name IN ('runtime_authority', 'run_leases')
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
      if (tables.has("runtime_authority")) {
        const authority = database.prepare(`
          SELECT pid, process_start_token FROM runtime_authority
          WHERE released_at IS NULL
          ORDER BY updated_at DESC LIMIT 1
        `).get() as { pid: unknown; process_start_token: unknown } | undefined;
        const pid = Number(authority?.pid);
        if (!blockers.some(blocker => blocker.type === "runtime-authority")
          && Number.isSafeInteger(pid) && pid > 0 && probeProcessIdentity({
            pid,
            ...(typeof authority?.process_start_token === "string"
              ? { startToken: authority.process_start_token }
              : {}),
          }) !== "dead") {
          blockers.push({
            type: "runtime-authority",
            message: "Runtime store has an active Runtime authority.",
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
    });
  });
}

function stopDaemonGracefully(
  workspace: RuntimeLayout,
): Effect.Effect<void, unknown> {
  return Effect.gen(function*() {
    const endpoint = workspace.daemonEndpoint;
    const status = yield* requestDaemonStatusProbeAtEndpointResult(endpoint);
    if (Result.isFailure(status)) {
      if (status.failure.type === "transport"
        && (status.failure.reason === "not-found" || status.failure.reason === "refused")) return;
      return yield* Effect.fail(new RuntimeStoreBusyError(status.failure.message));
    }
    if (status.success.kind === "unknown") {
      return yield* Effect.fail(
        new RuntimeStoreBusyError("The live daemon is not compatible with this version of Acpus and was left unchanged."),
      );
    }
    const shutdown = yield* (status.success.kind === "predecessor"
      ? requestPredecessorDaemonShutdownAtEndpointResult(endpoint)
      : requestDaemonShutdownAtEndpointResult(endpoint));
    if (Result.isFailure(shutdown)) {
      return yield* Effect.fail(new RuntimeStoreBusyError(shutdown.failure.message));
    }
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const polled = yield* requestDaemonStatusProbeAtEndpointResult(endpoint);
      if (Result.isFailure(polled) && polled.failure.type === "transport"
        && (polled.failure.reason === "not-found" || polled.failure.reason === "refused")) return;
      yield* Effect.sleep(100);
    }
    return yield* Effect.fail(new RuntimeStoreBusyError("The daemon did not stop within 30 seconds."));
  });
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
      || Number(version.user_version) !== H1_RUN_INDEX_STORAGE_VERSION) return undefined;
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
    throw new RuntimeStoreUnreadableError(`Runtime transition journal '${path}' is not a regular file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new RuntimeStoreUnreadableError(`Runtime transition journal '${path}' is not valid JSON.`);
  }
  if (!isTransitionJournal(value)) {
    throw new RuntimeStoreUnreadableError(
      `Runtime transition journal '${path}' does not match schema version ${transitionSchemaVersion}.`,
    );
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

function promise<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: error => error });
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
