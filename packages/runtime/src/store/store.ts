import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { walkNodes, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { staticExprShape, type JsonValue, type StaticExprShape } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveArtifactRegistrationPath } from "../artifacts/registration-path.js";
import { parseArtifactUri } from "../artifacts/reference.js";
import type { ArtifactRecord, RegisterArtifactInput } from "../artifacts/types.js";
import { rewriteArtifactValue, type ArtifactRewriteFailure } from "../artifacts/rewrite.js";
import {
  normalizeAgentOverrides,
  parseAgentOverrideMap,
  tryParseAgentOverrideMap,
  tryValidateAgentOverrides,
  withAgentOverrides,
  type AgentOverrideMap,
  type AgentOverrideValidationFailure,
} from "../control/agent-overrides.js";
import { requirePersistedDeadline } from "../deadline.js";
import { AgentObservationLog } from "../observations/log.js";
import type { HookJournalEntry } from "../hooks/journal.js";
import { probeProcessLiveness } from "../process-liveness.js";
import { stableJsonLine } from "../stable-json.js";
import { selectNextAdmission } from "../scheduler/admission.js";
import { resolveOccurrenceRef } from "../scheduler/occurrence-ref.js";
import { createSchedulerProjection } from "../scheduler/transitions.js";
import { ancestorGroupMembersForNode } from "../scheduler/membership.js";
import { planForkReplay } from "../scheduler/fork-replay-plan.js";
import { SchedulerStoreException, schedulerStoreResult, throwSchedulerStoreResult, type SchedulerStorePort, type SchedulerStoreResult } from "../scheduler/store-port.js";
import type { SchedulerProjection, SchedulerRunStatus } from "../scheduler/types.js";
import { nextFrozenRunTransitionEvents } from "../scheduler/settle.js";
import { decodeSchedulerPayload } from "../scheduler/event-codec.js";
import { decodeCommittedRuntimeEventRow, type CommittedRuntimeEventRow } from "./committed-event.js";
import { PathEscapeError, readContainedFileSync } from "./contained-path.js";
import {
  SqliteRuntimeInspectionReadModel,
  type RunDynamicDetails,
  type RunExecutionMetadata,
  type RunNodeProgress,
} from "./inspection-read-model.js";
import type { ForkReplayFact } from "./replay-model.js";
import { requireActiveOwnerEpoch, SqliteSchedulerStorePort, throwSchedulerStoreError } from "./scheduler-store.js";
import { tryNormalizeWorkflowInput, type SchemaNormalizationFailure } from "../admission/input.js";
import { sha256Digest, type Sha256Digest } from "../content-digest.js";
import { isContainedPath } from "../path-containment.js";
import {
  createWorkflowSourceSnapshotManifest,
  isRunWorkflowLockArtifact,
  isWorkflowSourceSnapshotManifest,
  parseWorkflowSource,
  tryValidatePreparedRunWorkflow,
  workflowSourceGraphDigestFromManifest,
  type PreparedRunValidationFailure,
  type PreparedRunWorkflow,
  type RunWorkflowLockArtifact,
  type WorkflowSourceRef,
} from "../admission/prepared-workflow.js";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  validateRuntimeLayoutBoundary,
  validateWorkspaceManifest,
  type RuntimeLayout,
} from "../runtime-layout.js";
import { acquireRuntimeSharedLock, type RuntimeSharedLock } from "../runtime-lock.js";
import { inspectRuntimeGeneration } from "../storage/generation.js";
import {
  hasNoPendingRuntimeDatabaseWal,
  openRuntimeDatabase,
  rollbackDatabaseTransaction,
  validateRuntimeDatabasePaths,
} from "../storage/database.js";
import {
  captureDirectoryIdentity,
  DirectoryFence,
  isRuntimeRunId,
  OpenedRuntimeGeneration,
  verifyDirectoryIdentity,
  type DirectoryIdentity,
  type RunDirectoryFence,
  type RunDirectoryToken,
} from "./path-fence.js";
import {
  assertRunFileIdentity,
  verifyRunFile,
} from "./run-file.js";
import { initializeRuntimeDatabase, initializeRuntimeSchema, validateRuntimeDatabase } from "./schema.js";

export type RunStatus = SchedulerRunStatus;

export type AdmitRunFailure = PreparedRunValidationFailure
  | SchemaNormalizationFailure
  | AgentOverrideValidationFailure;

export type ForkRunFailure = PreparedRunValidationFailure
  | AgentOverrideValidationFailure
  | SchemaNormalizationFailure
  | ForkReplayFailure
  | ArtifactRewriteFailure
  | ForkSourceVersionMismatch
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "fork-request-conflict"; requestId: string; message: string };

type ForkReplayFailure =
  | { type: "target-resolution-failure"; target: string; message: string }
  | { type: "dynamic-target-ambiguity"; target: string; message: string };

type ForkSourceVersionMismatch = {
  type: "fork-source-version-mismatch";
  runId: string;
  expectedVersion: number;
  actualVersion: number;
  message: string;
};

class ForkSourceVersionMismatchError extends Error {
  constructor(readonly failure: ForkSourceVersionMismatch) {
    super(failure.message);
  }
}

export type RunDeleteFailure = {
  type: "run-delete-active";
  runId: string;
  message: string;
};

const RUNNABLE_RUNS_WHERE = "status = 'pending'";

const RECOVERABLE_RUNNING_RUNS_WHERE = `
  status = 'running'
  AND NOT EXISTS (
    SELECT 1
    FROM signal_waits
    WHERE signal_waits.run_id = runs.id
      AND signal_waits.status = 'awaiting'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM run_leases
    WHERE run_leases.run_id = runs.id
      AND run_leases.released_at IS NULL
      AND run_leases.lease_expires_at > ?
  )
`;

const TIMED_SIGNAL_WAIT_WHERE = `
  status NOT IN ('paused', 'failed', 'completed', 'canceled')
  AND EXISTS (
    SELECT 1
    FROM signal_waits
    WHERE signal_waits.run_id = runs.id
      AND signal_waits.status = 'awaiting'
      AND signal_waits.deadline_at IS NOT NULL
  )
`;

const DUE_SIGNAL_WAIT_WHERE = `
  ${TIMED_SIGNAL_WAIT_WHERE}
  AND EXISTS (
    SELECT 1
    FROM signal_waits
    WHERE signal_waits.run_id = runs.id
      AND signal_waits.status = 'awaiting'
      AND signal_waits.deadline_at IS NOT NULL
      AND signal_waits.deadline_at <= ?
  )
`;

export type RunStoreSummary = {
  runCount: number;
  lastRunUpdatedAt?: string;
};

export type RuntimeStore = {
  scheduler: SchedulerStorePort;
  observationLog: AgentObservationLog;
  close(): void;
  admitRun(input: AdmitRunInput): ResultAsync<RunRecord, AdmitRunFailure>;
  getFrozenRun(runId: string): FrozenRun | undefined;
  claimDaemon(input: ClaimDaemonInput): DaemonLease;
  heartbeatDaemon(input: HeartbeatDaemonInput): boolean;
  setDaemonIdleState(input: DaemonIdleStateInput): boolean;
  releaseDaemon(input: HeartbeatDaemonInput): boolean;
  listDaemonWork(now?: Date): DaemonWork;
  forkRun(runId: string, options?: ControlOptions): ResultAsync<ForkRunRecord, ForkRunFailure>;
  cleanupStagedRunDirectories(): Promise<void>;
  deleteRun(runId: string): ResultAsync<RunRecord | undefined, RunDeleteFailure>;
  writeHookJournal(entry: HookJournalEntry): void;
  getHookJournal(runId: string): HookJournalEntry[];
  pruneHookJournal(cutoff: Date): number;
  getHookDispatchCursor(runId: string): number;
  compareAndSetHookDispatchCursor(runId: string, expectedSequence: number, nextSequence: number): boolean;
  getLastRunEventSequence(runId: string): number;
  getRunEventVersion(runId: string): number | undefined;
  readHookDispatchEvents(runId: string, afterSequence: number): HookDispatchEventRead;
  getCommittedRuntimeEventsAfter(runId: string, sequence: number): CommittedRuntimeEventRow[];
  getInspectionTimelineEvents(runId: string, nodeKeys: readonly string[], limit: number): CommittedRuntimeEventRow[];
  readRunInspectionToken(runId: string): RunInspectionToken | undefined;
  readRunInspection(runId: string, afterEventSequence?: number): RunInspectionStoreRead;
  getRunDir(runId: string): string | undefined;
  getRunDirectoryToken(runId: string): RunDirectoryToken | undefined;
  registerArtifact(input: RegisterArtifactInput): SchedulerStoreResult<void>;
  getArtifact(runId: string, artifactId: string): ArtifactRecord | undefined;
  listArtifacts(runId: string): ArtifactRecord[];
  writeExecutionMetadata(input: WriteExecutionMetadataInput): void;
  getExecutionMetadata(runId: string): RunExecutionMetadata[];
  writeNodeProgress(input: WriteNodeProgressInput): void;
  getRun(runId: string): RunDetails | undefined;
  listRuns(): RunRecord[];
  getRunStoreSummary(): RunStoreSummary;
  listWorkflowSources(): WorkflowSourceRef[];
  getRuntimeDiagnostics(): RuntimeDiagnostics;
};

export type RunInspectionStoreRead = {
  run?: RunDetails;
  frozen?: FrozenRun;
  artifacts: ArtifactRecord[];
  cursor: {
    eventSequence: number;
    progressVersion: number;
    observationVersion: number;
  };
  events: CommittedRuntimeEventRow[];
};

/**
 * The observer's cheap wake token.  It intentionally excludes wall-clock
 * context and any frozen/artifact data so an unchanged poll has no projection
 * work to do.
 */
type RunInspectionToken = {
  eventSequence: number;
  progressVersion: number;
  observationVersion: number;
};

type HookDispatchEventRead = {
  lastSequence: number;
  events: CommittedRuntimeEventRow[];
};

type DaemonWork = {
  startableRuns: RunRecord[];
  hookDispatchRunIds: string[];
  idleBlockers: number;
};

type AdmitRunInput = {
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  cwd: string;
  agentOverrides?: AgentOverrideMap;
};

export type RunRecord = {
  id: string;
  name: string;
  status: RunStatus;
  workflowEntry: string;
  sourceGraphDigest: string;
  createdAt: string;
  updatedAt: string;
  progressVersion: number;
  progressUpdatedAt?: string;
};

type ForkRunRecord = RunRecord & {
  forkCreated: boolean;
};

export type RunDetails = RunRecord & {
  input: JsonValue;
  output?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  fork?: RunForkInfo;
  hooks: HookJournalEntry[];
  eventCount: number;
  nodeCount: number;
  execution: RunExecutionState;
  dynamic?: RunDynamicDetails;
};

export type RunForkInfo = {
  sourceRunId: string;
  target?: string;
};

type RunExecutionState = {
  state: "active" | "inactive" | "stale" | "terminal" | "unknown";
  lastStatus: RunStatus;
  reason?: "terminal" | "daemon_heartbeat_expired" | "daemon_pid_dead" | "run_lease_expired" | "run_lease_active" | "daemon_alive" | "no_liveness_evidence";
  daemonHeartbeatAt?: string;
  ownerId?: string;
  leaseExpiresAt?: string;
};

export type RuntimeDiagnostics = {
  daemon?: DaemonDiagnostics;
  runs: {
    total: number;
    pending: number;
    running: number;
    awaiting: number;
    paused: number;
    failed: number;
    completed: number;
    canceled: number;
    runnable: number;
  };
  leases: {
    stale: number;
  };
};

export type DaemonDiagnostics = {
  workspaceRealpath: string;
  generation: number;
  pid?: number;
  heartbeatAt?: string;
  idleSinceAt?: string;
  idleStopMs?: number;
  protocolVersion: number;
  packageVersion: string;
  nodeVersion: string;
  execPath: string;
  updatedAt: string;
};

export type FrozenRun = {
  ir: WorkflowIR;
  input: JsonValue;
  agentOverrides: AgentOverrideMap;
  sourceRoot?: string;
  meta: Record<string, string>;
};

type ClaimDaemonInput = {
  workspaceRealpath: string;
  pid: number;
  protocolVersion: number;
  packageVersion: string;
  nodeVersion: string;
  execPath: string;
  idleStopMs: number;
};

type HeartbeatDaemonInput = {
  workspaceRealpath: string;
  generation: number;
};

type DaemonIdleStateInput = HeartbeatDaemonInput & {
  idleSinceAt?: string;
  idleStopMs: number;
};

type DaemonLease = {
  workspaceRealpath: string;
  generation: number;
  pid: number;
  heartbeatAt: string;
};

type ControlOptions = {
  requestId?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  target?: string;
};

type WriteExecutionMetadataInput = {
  runId: string;
  attemptId?: string;
  kind: string;
  metadata: JsonValue;
};
export type WriteNodeProgressInput = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo?: number;
  ownerEpoch: number;
  kind: string;
  status: string;
  message?: string;
  output?: RunNodeProgress["output"];
  context?: JsonValue;
  tokenUsage?: JsonValue;
  tools?: JsonValue;
  intent?: JsonValue;
  acpActivityAt?: string;
};

type RunRow = {
  id: string;
  name: string;
  status: RunStatus;
  workflow_entry: string;
  source_graph_digest: string;
  created_at: string;
  updated_at: string;
};

type RunInputRow = {
  workflow_ir_path: string;
  workflow_ir_digest: string;
  input_json: string;
  agent_overrides_json: string;
  lock_path: string;
  lock_digest: string;
  output_json: string | null;
  package_lock_digest: string | null;
  source_json: string;
};

type FrozenSourceRow =
  & Pick<RunInputRow, "workflow_ir_path" | "workflow_ir_digest" | "lock_path" | "lock_digest" | "source_json">
  & Pick<RunRow, "id" | "name" | "workflow_entry" | "source_graph_digest">;
type FrozenWorkflowRow = FrozenSourceRow & Pick<RunInputRow, "input_json" | "agent_overrides_json">;
type RunDetailsInputRow = Pick<RunInputRow, "input_json" | "agent_overrides_json" | "output_json">;

type CountRow = {
  count: number;
};

type ArtifactRow = {
  run_id: unknown;
  id: unknown;
  node_key: unknown;
  attempt: unknown;
  media_type: unknown;
  digest: unknown;
  size: unknown;
  relative_path: unknown;
};

export async function openRuntimeStore(cwd: string): Promise<RuntimeStore> {
  let layout = resolveRuntimeLayout(cwd);
  await validateRuntimeLayoutBoundary(layout);
  const generation = await inspectRuntimeGeneration(layout);
  if (generation === "complete") {
    await validateExistingLayout(layout);
    await validateDatabaseFileIfPresent(layout.databasePath);
  } else {
    layout = await requireRuntimeLayout(cwd);
  }
  return openRuntimeStoreAtLayout(layout, { prevalidated: true });
}

export async function openRuntimeStoreAtLayout(
  layout: RuntimeLayout,
  options: { lock?: boolean | RuntimeSharedLock; prevalidated?: boolean; unpublished?: boolean } = {},
): Promise<RuntimeStore> {
  if (!options.prevalidated) {
    await inspectRuntimeGeneration(layout);
    await validateDatabaseFileIfPresent(layout.databasePath);
  }
  const lock = options.lock === false
    ? undefined
    : typeof options.lock === "object"
      ? options.lock
      : await acquireRuntimeSharedLock(layout);
  let db: DatabaseSync | undefined;
  try {
    await inspectRuntimeGeneration(layout);
    if (!options.unpublished) await validateExistingLayout(layout);
    db = await openRuntimeDatabase(layout.databasePath);
    await setPrivateFileMode(layout.databasePath, layout.platform);
    initializeRuntimeDatabase(db, layout.databasePath);
    const store = new SqliteRuntimeStore(db, layout, lock);
    await reconcileTrash(store, db);
    return store;
  } catch (error) {
    db?.close();
    lock?.release();
    throw error;
  }
}

export async function openExistingRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, true);
}

export async function openExistingWritableRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, false);
}

async function openExistingStore(cwd: string, readOnly: boolean): Promise<RuntimeStore | undefined> {
  return openExistingRuntimeStoreAtLayout(resolveRuntimeLayout(cwd), readOnly);
}

export async function openExistingRuntimeStoreAtLayout(
  layout: RuntimeLayout,
  readOnly: boolean,
  options: { lock?: boolean; immutable?: boolean } = {},
): Promise<RuntimeStore | undefined> {
  if (!await validateRuntimeDatabasePaths(layout.databasePath)) return undefined;
  await validateExistingLayout(layout);
  await validateDatabaseFileIfPresent(layout.databasePath);
  if (readOnly) {
    const immutable = options.immutable === true
      && await hasNoPendingRuntimeDatabaseWal(layout.databasePath);
    const db = await openRuntimeDatabase(layout.databasePath, { readOnly: true, immutable });
    return new SqliteRuntimeStore(db, layout);
  }
  const lock = options.lock === false ? undefined : await acquireRuntimeSharedLock(layout);
  let db: DatabaseSync | undefined;
  try {
    await inspectRuntimeGeneration(layout);
    await validateExistingLayout(layout);
    db = await openRuntimeDatabase(layout.databasePath);
    validateRuntimeDatabase(db, layout.databasePath);
    initializeRuntimeSchema(db);
  } catch (error) {
    db?.close();
    lock?.release();
    throw error;
  }
  try {
    if (!db) throw new Error(`Runtime database '${layout.databasePath}' could not be opened.`);
    const store = new SqliteRuntimeStore(db, layout, lock);
    await reconcileTrash(store, db);
    return store;
  } catch (error) {
    db?.close();
    lock?.release();
    throw error;
  }
}

async function requireRuntimeLayout(cwd: string): Promise<RuntimeLayout> {
  const layout = await ensureRuntimeLayout(cwd);
  if (layout.isErr()) throw new Error(layout.error.message);
  return layout.value;
}

async function validateExistingLayout(layout: RuntimeLayout): Promise<void> {
  for (const [path, label] of [
    [layout.home, "Acpus home"],
    [join(layout.home, "workspaces"), "Runtime workspaces root"],
    [layout.workspaceRoot, "Runtime workspace shard"],
    [layout.runtimeRoot, "Runtime generation"],
    [layout.runsRoot, "Runtime runs root"],
    [layout.sourcesRoot, "Runtime sources root"],
    [layout.trashRoot, "Runtime trash root"],
    [layout.layoutVersion === 1 ? layout.legacyArchivesRoot : layout.generationsRoot, "Runtime generations root"],
  ] as const) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new Error(`${label} '${path}' could not be read: ${causeMessage(error)}.`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} '${path}' is not a regular directory.`);
    }
  }
  let manifestInfo;
  try {
    manifestInfo = await lstat(layout.manifestPath);
  } catch (error) {
    throw new Error(`Runtime workspace manifest '${layout.manifestPath}' could not be read: ${causeMessage(error)}.`);
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error(`Runtime workspace manifest '${layout.manifestPath}' is not a regular file.`);
  }
  let raw: string;
  try {
    raw = await readFile(layout.manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Runtime workspace manifest '${layout.manifestPath}' could not be read: ${causeMessage(error)}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Runtime workspace manifest '${layout.manifestPath}' is not valid JSON.`);
  }
  const manifest = validateWorkspaceManifest(value, layout);
  if (manifest.isErr()) throw new Error(manifest.error.message);
}

async function setPrivateFileMode(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== "win32") await chmod(path, 0o600);
}

async function validateDatabaseFileIfPresent(path: string): Promise<void> {
  if (!await validateRuntimeDatabasePaths(path)) return;
  const db = await openRuntimeDatabase(path, {
    readOnly: true,
    immutable: await hasNoPendingRuntimeDatabaseWal(path),
  });
  try {
    validateRuntimeDatabase(db, path);
  } finally {
    db.close();
  }
}

async function reconcileTrash(store: SqliteRuntimeStore, db: DatabaseSync): Promise<void> {
  const generation = store.pathGeneration();
  const runsRoot = generation.runsRoot.verify();
  const trashRoot = generation.trashRoot.verify();
  let entries: string[];
  try {
    entries = await readdir(trashRoot);
    generation.trashRoot.verify();
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (entries.length === 0) return;
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    for (const entry of entries) {
      const runId = entry.slice(0, 34);
      const trashPath = join(trashRoot, entry);
      generation.trashRoot.verify();
      const trashed = captureDirectoryIdentity(trashPath, `Runtime trash entry '${trashPath}'`);
      if (!isRuntimeRunId(runId)) {
        throw new Error(`Runtime trash entry '${trashPath}' has no valid run identity.`);
      }
      const runPath = join(runsRoot, runId);
      if (!store.getRun(runId)) {
        generation.runsRoot.verify();
        generation.trashRoot.verify();
        verifyDirectoryIdentity(trashed, `Runtime trash entry '${trashPath}'`);
        if (await pathExists(runPath)) {
          throw new Error(`Runtime trash entry '${trashPath}' collides with orphan run directory '${runPath}'.`);
        }
        generation.runsRoot.verify();
        await removeOwnedDirectory(generation.trashRoot, trashed);
        continue;
      }
      generation.runsRoot.verify();
      generation.trashRoot.verify();
      verifyDirectoryIdentity(trashed, `Runtime trash entry '${trashPath}'`);
      if (await pathExists(runPath)) {
        throw new Error(`Runtime trash entry '${trashPath}' cannot be restored because run directory '${runPath}' already exists.`);
      }
      generation.runsRoot.verify();
      generation.trashRoot.verify();
      verifyDirectoryIdentity(trashed, `Runtime trash entry '${trashPath}'`);
      await rename(trashPath, runPath);
      generation.runsRoot.verify();
      generation.trashRoot.verify();
      const restored = captureDirectoryIdentity(runPath, `Restored run directory '${runId}'`);
      assertSameDirectory(trashed, restored, `Runtime trash entry '${trashPath}' changed during restoration.`);
      generation.forgetRun(runId);
      generation.run(runId);
    }
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    throw rollbackDatabaseTransaction(db, transactionStarted, error);
  }
}

class SqliteRuntimeStore implements RuntimeStore {
  private schedulerPort?: SqliteSchedulerStorePort;
  private observationLogInstance?: AgentObservationLog;
  private readonly inspectionReadModel: SqliteRuntimeInspectionReadModel;
  private readonly cwd: string;
  private readonly generation: OpenedRuntimeGeneration;

  constructor(
    private readonly db: DatabaseSync,
    private readonly layout: RuntimeLayout,
    private readonly runtimeLock?: RuntimeSharedLock,
  ) {
    this.cwd = layout.canonicalPath;
    this.generation = new OpenedRuntimeGeneration(layout);
    this.inspectionReadModel = new SqliteRuntimeInspectionReadModel(db, this.schedulerStore());
  }

  get scheduler(): SchedulerStorePort {
    return this.schedulerStore();
  }

  get observationLog(): AgentObservationLog {
    this.observationLogInstance ??= new AgentObservationLog(this.db);
    return this.observationLogInstance;
  }

  async withInspectionSnapshot<T>(read: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await read();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private schedulerStore(): SqliteSchedulerStorePort {
    this.schedulerPort ??= new SqliteSchedulerStorePort(
      this.db,
      runId => this.generation.run(runId).verify(),
      runId => {
        const frozen = this.loadFrozenRun(runId, true);
        if (!frozen) throw new Error(`Run '${runId}' has no frozen workflow.`);
        return frozen;
      },
    );
    return this.schedulerPort;
  }

  private runRecordColumns(): string {
    return "id, name, status, workflow_entry, source_graph_digest, created_at, updated_at, progress_version, progress_updated_at";
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.runtimeLock?.release();
    }
  }

  admitRun(input: AdmitRunInput): ResultAsync<RunRecord, AdmitRunFailure> {
    return new ResultAsync(this.admitRunResult(input));
  }

  private async admitRunResult(input: AdmitRunInput): Promise<Result<RunRecord, AdmitRunFailure>> {
    const prepared = tryValidatePreparedRunWorkflow(this.cwd, input.prepared);
    if (prepared.isErr()) return err(prepared.error);
    const normalizedInput = tryNormalizeWorkflowInput(prepared.value.ir, input.input);
    if (normalizedInput.isErr()) return err(normalizedInput.error);
    const agentOverrides = tryValidateAgentOverrides(prepared.value.ir, input.agentOverrides);
    if (agentOverrides.isErr()) return err(agentOverrides.error);
    if (realpathSync(resolve(input.cwd)) !== realpathSync(resolve(this.cwd))) {
      throw new Error("Admission workspace does not match the runtime store workspace.");
    }
    await publishWorkflowSource(prepared.value, this.layout, this.generation.sourcesRoot);
    const runId = newRunId();
    const now = new Date().toISOString();
    const workflowEntry = prepared.value.source.entry;
    const lockJson = stableJsonLine(prepared.value.lock);
    const eventPayload = {
      workflow: summarizeWorkflowForEvent(prepared.value.ir),
      input: normalizedInput.value,
      ...(Object.keys(agentOverrides.value).length > 0 ? { agentOverrides: agentOverrides.value } : {}),
    };
    const publishedRun = await publishRunDirectory({
      runsRoot: this.generation.runsRoot,
      runId,
      platform: this.layout.platform,
      populate: async (runDir, assertCurrent) => {
        await writeFrozenRunFiles(runDir, prepared.value.irJson, lockJson, assertCurrent);
      },
    });
    const run = this.generation.run(runId);
    assertSameDirectory(publishedRun, run.token().runDirectory, `Run directory '${runId}' changed after publication.`);
    let transactionStarted = false;
    try {
      run.verify();
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.db.prepare(`
        INSERT INTO runs (id, name, status, workflow_entry, source_graph_digest, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?)
      `).run(runId, prepared.value.ir.name, workflowEntry, prepared.value.sourceGraphDigest, now, now);
      this.db.prepare(`
        INSERT INTO run_inputs (
          run_id, workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, lock_path, lock_digest, package_lock_digest, source_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        "workflow.ir.json",
        sha256Digest(Buffer.from(prepared.value.irJson)),
        stableJsonLine(normalizedInput.value),
        stableJsonLine(agentOverrides.value),
        "lock.json",
        sha256Digest(Buffer.from(lockJson)),
        prepared.value.packageLockDigest ?? null,
        stableJsonLine(prepared.value.source),
      );
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, 1, 'run.admitted', NULL, ?, ?, ?)
      `).run(runId, stableJsonLine(eventPayload), now, `admit:${runId}`);
      this.db.prepare(`
        INSERT INTO scheduler_projection_checkpoints (run_id, event_sequence, projection_json, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(runId, stableJsonLine(createSchedulerProjection(runId) as unknown as JsonValue), now);
      this.db.prepare("INSERT INTO hook_dispatch_cursors (run_id, event_sequence) VALUES (?, 0)").run(runId);
      for (const nodeId of collectNodeIds(prepared.value.ir.root)) {
        this.db.prepare(`
          INSERT INTO node_states (run_id, node_key, node_id, status)
          VALUES (?, ?, ?, 'pending')
        `).run(runId, nodeId, nodeId);
      }
      run.verify();
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      this.generation.forgetRun(runId);
      await removeOwnedDirectoryAfterFailure(
        this.generation.runsRoot,
        publishedRun,
        rollbackDatabaseTransaction(this.db, transactionStarted, error),
      );
    }

    const record = this.getRunRecord(runId);
    if (!record) throw new Error(`Admitted run ${runId} was not persisted.`);
    return ok(record);
  }

  getFrozenRun(runId: string): FrozenRun | undefined {
    return this.readFrozenRun(runId, true);
  }

  private readFrozenRun(runId: string, resolveSource: boolean): FrozenRun | undefined {
    const frozen = this.loadFrozenRun(runId, resolveSource);
    if (!frozen && this.getRunRecord(runId)) throw new Error(`Run '${runId}' has no frozen input.`);
    return frozen;
  }

  private loadFrozenRun(runId: string, resolveSource: boolean): FrozenRun | undefined {
    const row = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, runs.source_graph_digest,
        run_inputs.workflow_ir_path, run_inputs.workflow_ir_digest, run_inputs.input_json,
        run_inputs.agent_overrides_json, run_inputs.lock_path, run_inputs.lock_digest, run_inputs.source_json
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
      WHERE run_inputs.run_id = ?
    `).get(runId) as FrozenWorkflowRow | undefined;
    if (!row) return undefined;
    return decodeFrozenRun(
      row,
      this.generation.run(row.id).verify(),
      this.cwd,
      resolveSource
        ? source => resolveFrozenSourceRoot(this.layout, source, this.generation.sourcesRoot)
        : undefined,
    );
  }

  claimDaemon(input: ClaimDaemonInput): DaemonLease {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`
      SELECT generation
      FROM daemon_lease
      WHERE workspace_realpath = ?
    `).get(input.workspaceRealpath) as { generation: number } | undefined;
    const generation = (existing?.generation ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO daemon_lease (
        workspace_realpath, generation, pid, heartbeat_at,
        idle_since_at, idle_stop_ms, protocol_version, package_version, node_version, exec_path, updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_realpath) DO UPDATE SET
        generation = excluded.generation,
        pid = excluded.pid,
        heartbeat_at = excluded.heartbeat_at,
        idle_since_at = excluded.idle_since_at,
        idle_stop_ms = excluded.idle_stop_ms,
        protocol_version = excluded.protocol_version,
        package_version = excluded.package_version,
        node_version = excluded.node_version,
        exec_path = excluded.exec_path,
        updated_at = excluded.updated_at
    `).run(
      input.workspaceRealpath,
      generation,
      input.pid,
      now,
      input.idleStopMs,
      input.protocolVersion,
      input.packageVersion,
      input.nodeVersion,
      input.execPath,
      now,
    );
    return { workspaceRealpath: input.workspaceRealpath, generation, pid: input.pid, heartbeatAt: now };
  }

  heartbeatDaemon(input: HeartbeatDaemonInput): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE daemon_lease
      SET heartbeat_at = ?, updated_at = ?
      WHERE workspace_realpath = ? AND generation = ?
    `).run(now, now, input.workspaceRealpath, input.generation);
    return result.changes === 1;
  }

  setDaemonIdleState(input: DaemonIdleStateInput): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE daemon_lease
      SET idle_since_at = ?, idle_stop_ms = ?, updated_at = ?
      WHERE workspace_realpath = ? AND generation = ?
    `).run(input.idleSinceAt ?? null, input.idleStopMs, now, input.workspaceRealpath, input.generation);
    return result.changes === 1;
  }

  releaseDaemon(input: HeartbeatDaemonInput): boolean {
    const result = this.db.prepare(`
      DELETE FROM daemon_lease
      WHERE workspace_realpath = ? AND generation = ?
    `).run(input.workspaceRealpath, input.generation);
    return result.changes === 1;
  }

  listDaemonWork(now: Date = new Date()): DaemonWork {
    const nowIso = now.toISOString();
    const timedWaits = this.db.prepare("SELECT run_id, node_key, deadline_at FROM signal_waits WHERE status = 'awaiting' AND deadline_at IS NOT NULL")
      .all() as Array<{ run_id: string; node_key: string; deadline_at: string }>;
    for (const wait of timedWaits) requirePersistedDeadline(wait.deadline_at, `Signal wait '${wait.run_id}:${wait.node_key}'`);
    const ordinaryStartableRuns = this.db.prepare(`
      SELECT ${this.runRecordColumns()}
      FROM runs
      WHERE (${RUNNABLE_RUNS_WHERE}) OR (${DUE_SIGNAL_WAIT_WHERE}) OR (${RECOVERABLE_RUNNING_RUNS_WHERE})
      ORDER BY created_at ASC
    `).all(nowIso, nowIso).map(toRunRecord);
    const reconciliationRuns = this.db.prepare(`
      SELECT ${this.runRecordColumns()}
      FROM runs
      WHERE status IN ('running', 'awaiting')
        AND (
          EXISTS (
            SELECT 1
            FROM group_members
            WHERE group_members.run_id = runs.id
              AND group_members.status IN ('completed', 'failed', 'cancelled')
          )
          OR EXISTS (
            SELECT 1
            FROM node_instances
            WHERE node_instances.run_id = runs.id
              AND node_instances.status IN ('completed', 'failed', 'cancelled')
          )
          OR EXISTS (
            SELECT 1
            FROM scheduler_frames
            WHERE scheduler_frames.run_id = runs.id
              AND scheduler_frames.status IN ('completed', 'failed', 'cancelled')
          )
          OR EXISTS (
            SELECT 1
            FROM node_attempts
            WHERE node_attempts.run_id = runs.id
              AND node_attempts.status = 'started'
          )
          OR EXISTS (
            SELECT 1
            FROM node_instances
            WHERE node_instances.run_id = runs.id
              AND node_instances.status = 'ready'
          )
          OR EXISTS (
            SELECT 1
            FROM scheduler_frames
            WHERE scheduler_frames.run_id = runs.id
              AND scheduler_frames.status = 'running'
              AND scheduler_frames.strategy IN ('all', 'race', 'quorum')
              AND NOT EXISTS (
                SELECT 1
                FROM group_members
                WHERE group_members.run_id = scheduler_frames.run_id
                  AND group_members.group_key = scheduler_frames.frame_key
              )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM run_leases
          WHERE run_leases.run_id = runs.id
            AND run_leases.released_at IS NULL
            AND run_leases.lease_expires_at > ?
      )
      ORDER BY created_at ASC
    `).all(nowIso).map(toRunRecord).filter(run => {
      const snapshot = throwSchedulerStoreResult(this.scheduler.tryLoadRunSnapshot(run.id));
      const frozen = this.getFrozenRun(run.id);
      if (!frozen) throw new Error(`Run '${run.id}' has no frozen workflow.`);
      if (nextFrozenRunTransitionEvents(frozen, snapshot.projection, now).length > 0) return true;
      if (Object.values(snapshot.projection.attempts).some(attempt => attempt.status === "started")) return true;
      const signalNodeIds = new Set<string>();
      for (const { node } of walkNodes(frozen.ir.root)) {
        if (node.kind === "signal") signalNodeIds.add(node.id);
      }
      return selectNextAdmission({
        projection: snapshot.projection,
        // Configured run caps are positive; any durable started attempt matched above.
        maxLeafConcurrency: 1,
        ownerLocalUnsettled: 0,
        signalNodeIds,
      }) !== undefined;
    });
    const startableById = new Map(ordinaryStartableRuns.map(run => [run.id, run]));
    for (const run of reconciliationRuns) startableById.set(run.id, run);
    const startableRuns = [...startableById.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const idleBlockerRunIds = new Set((this.db.prepare(`
      SELECT id
      FROM runs
      WHERE (${RUNNABLE_RUNS_WHERE}) OR (${TIMED_SIGNAL_WAIT_WHERE}) OR (${RECOVERABLE_RUNNING_RUNS_WHERE})
    `).all(nowIso) as Array<{ id: string }>).map(row => row.id));
    for (const run of reconciliationRuns) idleBlockerRunIds.add(run.id);
    const hookDispatchRows = this.db.prepare(`
      SELECT runs.id, hook_dispatch_cursors.event_sequence, COALESCE((
        SELECT MAX(run_events.sequence)
        FROM run_events
        WHERE run_events.run_id = runs.id
      ), 0) AS last_sequence
      FROM runs
      JOIN hook_dispatch_cursors ON hook_dispatch_cursors.run_id = runs.id
      ORDER BY runs.created_at ASC
    `).all() as Array<{ id: string; event_sequence: number; last_sequence: number }>;
    const hookDispatchRunIds: string[] = [];
    for (const hook of hookDispatchRows) {
      const cursor = Number(hook.event_sequence);
      const lastSequence = Number(hook.last_sequence);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(lastSequence) || lastSequence < 0) {
        throw new Error(`Run '${hook.id}' has an invalid hook dispatch cursor or event sequence.`);
      }
      if (cursor > lastSequence) {
        throw new Error(`Run '${hook.id}' hook dispatch cursor ${cursor} exceeds committed event sequence ${lastSequence}.`);
      }
      if (cursor < lastSequence) hookDispatchRunIds.push(hook.id);
    }
    return { startableRuns, hookDispatchRunIds, idleBlockers: idleBlockerRunIds.size + hookDispatchRunIds.length };
  }

  private countRunnableRuns(): number {
    const nowIso = new Date().toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs
      WHERE (${RUNNABLE_RUNS_WHERE}) OR (${RECOVERABLE_RUNNING_RUNS_WHERE})
    `).get(nowIso) as CountRow;
    return Number(row.count);
  }

  forkRun(runId: string, options: ControlOptions = {}): ResultAsync<ForkRunRecord, ForkRunFailure> {
    return new ResultAsync(this.forkRunResult(runId, options));
  }

  private async forkRunResult(runId: string, options: ControlOptions): Promise<Result<ForkRunRecord, ForkRunFailure>> {
    if (options.prepared) {
      const prepared = tryValidatePreparedRunWorkflow(this.cwd, options.prepared);
      if (prepared.isErr()) return err(prepared.error);
      options = { ...options, prepared: prepared.value };
    }
    const forkRequestKey = options.requestId === undefined ? undefined : `fork-request:${options.requestId}`;
    const requestFingerprint = forkRequestFingerprint(runId, options);
    if (forkRequestKey) {
      const existing = this.db.prepare(`
        SELECT run_id, payload_json
        FROM run_events
        WHERE idempotency_key = ? AND type = 'run.forked'
      `).get(forkRequestKey) as { run_id: string; payload_json: string } | undefined;
      if (existing) {
        const payload = JSON.parse(existing.payload_json) as Record<string, unknown>;
        if (payload.requestFingerprint !== requestFingerprint) {
          return err({
            type: "fork-request-conflict",
            requestId: options.requestId!,
            message: `Fork request '${options.requestId}' conflicts with a different fork input.`,
          });
        }
        return ok({ ...this.requireRun(existing.run_id), forkCreated: false });
      }
    }
    const matchingFork = (this.db.prepare(`
      SELECT run_id, payload_json
      FROM run_events
      WHERE type = 'run.forked'
    `).all() as Array<{ run_id: string; payload_json: string }>)
      .find(row => (JSON.parse(row.payload_json) as Record<string, unknown>).requestFingerprint === requestFingerprint);
    if (matchingFork) return ok({ ...this.requireRun(matchingFork.run_id), forkCreated: false });
    const sourceSnapshotResult = this.scheduler.tryLoadRunSnapshot(runId);
    if (sourceSnapshotResult.isErr()) {
      if (sourceSnapshotResult.error.type === "run-not-found") return err(sourceSnapshotResult.error);
      throw new SchedulerStoreException(sourceSnapshotResult.error);
    }
    const sourceSnapshot = sourceSnapshotResult.value;
    const source = this.getRunRecord(runId);
    if (!source) return err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const input = this.db.prepare(`
      SELECT workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, lock_path, lock_digest, output_json, package_lock_digest, source_json
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input) throw new Error(`Run '${runId}' has no frozen input.`);
    if (options.prepared) {
      await publishWorkflowSource(options.prepared, this.layout, this.generation.sourcesRoot);
    }
    const sourceRun = this.generation.run(runId);
    const sourceRunDir = sourceRun.verify();
    const sourceWorkflowIrJson = frozenWorkflowIrJson(sourceRunDir, input);
    const persisted = verifiedFrozenWorkflowSource(sourceRunDir, {
      ...input,
      id: source.id,
      name: source.name,
      workflow_entry: source.workflowEntry,
      source_graph_digest: source.sourceGraphDigest,
    });
    const sourceLockJson = persisted.lockJson;
    const forkIrJson = options.prepared?.irJson ?? sourceWorkflowIrJson;
    const forkIr = options.prepared?.ir ?? JSON.parse(forkIrJson) as WorkflowIR;
    if (options.agentOverrides !== undefined) {
      const agentOverrides = tryParseAgentOverrideMap(options.agentOverrides, forkIr.agents);
      if (agentOverrides.isErr()) return err(agentOverrides.error);
      options = { ...options, agentOverrides: agentOverrides.value };
    }
    const sourceAgentOverrides = parseAgentOverrides(input.agent_overrides_json);
    const forkAgentOverrides = normalizeAgentOverrides(forkIr, options.agentOverrides, sourceAgentOverrides);
    let forkInput = options.input;
    if (forkInput !== undefined || options.prepared) {
      const normalized = tryNormalizeWorkflowInput(forkIr, forkInput ?? JSON.parse(input.input_json) as JsonValue, "Fork input");
      if (normalized.isErr()) return err(normalized.error);
      forkInput = normalized.value;
    }
    const forkInputJson = forkInput === undefined ? input.input_json : stableJsonLine(forkInput);
    const forkLockJson = options.prepared ? stableJsonLine(options.prepared.lock) : sourceLockJson;
    const forkPackageLockDigest = options.prepared?.packageLockDigest ?? input.package_lock_digest ?? null;
    const forkSource = options.prepared?.source ?? persisted.source;
    const forkName = options.prepared ? forkIr.name : source.name;
    const forkWorkflowEntry = forkSource.entry;
    const forkSourceGraphDigest = options.prepared?.sourceGraphDigest ?? source.sourceGraphDigest;
    const forkId = newRunId();
    const now = new Date().toISOString();
    const checkpoint = resolveForkCheckpoint(this.db, sourceSnapshot.projection, runId, options.target);
    if (checkpoint.isErr()) return err(checkpoint.error);
    const sourceFrozen = this.getFrozenRun(runId);
    if (!sourceFrozen) throw new Error(`Fork source run '${runId}' has no frozen workflow.`);
    const sourceReplayFacts = completedReplayFacts(
      this.db,
      runId,
      sourceSnapshot.projection,
      checkpoint.value.replayBeforeSequence,
    );
    const sourceArtifactIdsByNode = new Map<string, string[]>();
    const candidateArtifactIds = new Set<string>();
    for (const fact of sourceReplayFacts) {
      const ids = new Set<string>();
      if (fact.output !== undefined) collectArtifactIds(fact.output, runId, ids);
      const ordered = [...ids].sort();
      sourceArtifactIdsByNode.set(fact.nodeKey, ordered);
      for (const id of ordered) candidateArtifactIds.add(id);
    }
    const artifactIdMap = Object.fromEntries([...candidateArtifactIds]
      .sort()
      .map(id => [id, `artifact_${randomUUID()}`]));
    const artifactPathMap = Object.fromEntries(Object.entries(artifactIdMap).map(([id, childId]) => [
      id,
      join("artifacts", ".fork-replay", childId),
    ]));
    const candidateArtifacts = (this.db.prepare(`
      SELECT id, node_key, attempt, media_type, digest, size, relative_path
      FROM artifacts
      WHERE run_id = ?
    `).all(runId) as ArtifactRow[]).filter(artifact => candidateArtifactIds.has(String(artifact.id)));
    const artifactById = new Map(candidateArtifacts.map(artifact => [String(artifact.id), artifact]));
    const sourceIdByChildId = new Map(Object.entries(artifactIdMap).map(([sourceId, childId]) => [childId, sourceId]));
    const stagedReplayFacts: ForkReplayFact[] = [];
    for (const fact of sourceReplayFacts) {
      let output: JsonValue | undefined;
      if (fact.output !== undefined) {
        const rewritten = rewriteArtifactValue(fact.output, runId, forkId, artifactIdMap);
        if (rewritten.isErr()) return err(rewritten.error);
        output = rewritten.value;
      }
      stagedReplayFacts.push({
        ...fact,
        ...(output === undefined ? {} : { output }),
      });
    }
    const replayPlan = planForkReplay({
      source: {
        frozen: sourceFrozen,
        projection: sourceSnapshot.projection,
        artifactDigest: uri => {
          const parsed = parseArtifactUri(uri);
          if (parsed.isErr() || parsed.value.runId !== runId) return undefined;
          return this.getArtifact(runId, parsed.value.artifactId)?.digest;
        },
      },
      child: {
        runId: forkId,
        frozen: {
          ir: withAgentOverrides(forkIr, forkAgentOverrides),
          input: JSON.parse(forkInputJson) as JsonValue,
          meta: {
            runId: forkId,
            workflowPath: forkWorkflowEntry,
            workflowName: forkName,
            workspaceDir: resolve(this.cwd),
          },
        },
        artifactDigest: uri => {
          const parsed = parseArtifactUri(uri);
          if (parsed.isErr() || parsed.value.runId !== forkId) return undefined;
          const sourceId = sourceIdByChildId.get(parsed.value.artifactId);
          const artifact = sourceId === undefined ? undefined : artifactById.get(sourceId);
          return artifact === undefined ? undefined : String(artifact.digest);
        },
      },
      facts: stagedReplayFacts,
    });
    const replayFacts = replayPlan.facts;
    const reachableArtifactIds = new Set<string>();
    for (const fact of replayFacts) {
      for (const id of sourceArtifactIdsByNode.get(fact.nodeKey) ?? []) reachableArtifactIds.add(id);
    }
    const missingArtifactId = [...reachableArtifactIds].sort().find(id => !artifactById.has(id));
    if (missingArtifactId !== undefined) {
      return err({
        type: "artifact-rewrite-failure",
        artifactId: missingArtifactId,
        message: `Missing source artifact metadata for '${missingArtifactId}'.`,
      });
    }
    const artifacts = [...reachableArtifactIds].sort().map(id => artifactById.get(id)!);
    const rewrittenFacts: ForkReplayFact[] = [];
    for (const fact of replayFacts) {
      rewrittenFacts.push({
        ...fact,
        artifacts: (sourceArtifactIdsByNode.get(fact.nodeKey) ?? [])
          .map(id => artifactById.get(id)!)
          .map(artifact => ({
            id: requireArtifactId(artifactIdMap, String(artifact.id)),
            ...(artifact.node_key === null ? {} : { nodeKey: String(artifact.node_key) }),
            attempt: Number(artifact.attempt ?? 0),
            ...(artifact.media_type === null ? {} : { mediaType: String(artifact.media_type) }),
            digest: String(artifact.digest),
            size: Number(artifact.size),
            relativePath: requireArtifactPath(artifactPathMap, String(artifact.id)),
          })),
      });
    }
    sourceRun.verify();
    const publishedFork = await publishRunDirectory({
      runsRoot: this.generation.runsRoot,
      runId: forkId,
      platform: this.layout.platform,
      populate: async (runDir, assertCurrent) => {
        sourceRun.verify();
        await writeFrozenRunFiles(runDir, forkIrJson, forkLockJson, assertCurrent);
        await verifyFrozenRunFiles(runDir, forkLockJson, forkIrJson);
        assertCurrent();
        sourceRun.verify();
        await copyVerifiedArtifacts(sourceRun, runDir, artifacts, artifactPathMap, assertCurrent);
        sourceRun.verify();
      },
    });
    const forkRun = this.generation.run(forkId);
    assertSameDirectory(publishedFork, forkRun.token().runDirectory, `Run directory '${forkId}' changed after publication.`);
    let transactionStarted = false;
    try {
      sourceRun.verify();
      forkRun.verify();
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const currentSourceSnapshot = throwSchedulerStoreResult(this.scheduler.tryLoadRunSnapshot(runId));
      if (currentSourceSnapshot.version !== sourceSnapshot.version) {
        throw new ForkSourceVersionMismatchError({
          type: "fork-source-version-mismatch",
          runId,
          expectedVersion: sourceSnapshot.version,
          actualVersion: currentSourceSnapshot.version,
          message: `Fork source run '${runId}' changed while the fork was preparing.`,
        });
      }
      const currentCheckpoint = resolveForkCheckpoint(this.db, currentSourceSnapshot.projection, runId, options.target);
      if (currentCheckpoint.isErr()
        || stableJsonLine(currentCheckpoint.value) !== stableJsonLine(checkpoint.value)) {
        throw new Error(`Fork source target '${options.target}' changed without a scheduler version change.`);
      }
      this.db.prepare(`
        INSERT INTO runs (id, name, status, workflow_entry, source_graph_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(forkId, forkName, "pending", forkWorkflowEntry, forkSourceGraphDigest, now, now);
      this.db.prepare(`
        INSERT INTO run_inputs (
          run_id, workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, output_json, lock_path, lock_digest, package_lock_digest, source_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        forkId,
        "workflow.ir.json",
        sha256Digest(Buffer.from(forkIrJson)),
        forkInputJson,
        stableJsonLine(forkAgentOverrides),
        null,
        "lock.json",
        sha256Digest(Buffer.from(forkLockJson)),
        forkPackageLockDigest,
        stableJsonLine(forkSource),
      );
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, 1, 'run.forked', NULL, ?, ?, ?)
      `).run(forkId, stableJsonLine({
        sourceRunId: runId,
        requestFingerprint,
        ...(options.target === undefined ? {} : {
          target: options.target,
          replayBeforeSequence: checkpoint.value.replayBeforeSequence,
        }),
        ...(Object.keys(forkAgentOverrides).length > 0 ? { agentOverrides: forkAgentOverrides } : {}),
      }), now, forkRequestKey ?? `fork:${forkId}:${runId}`);
      this.db.prepare(`
        INSERT INTO scheduler_projection_checkpoints (run_id, event_sequence, projection_json, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(forkId, stableJsonLine(createSchedulerProjection(forkId) as unknown as JsonValue), now);
      this.db.prepare("INSERT INTO hook_dispatch_cursors (run_id, event_sequence) VALUES (?, 0)").run(forkId);
      for (const nodeId of collectNodeIds(forkIr.root)) {
        this.db.prepare(`
          INSERT INTO node_states (run_id, node_key, node_id, status)
          VALUES (?, ?, ?, 'pending')
        `).run(forkId, nodeId, nodeId);
      }
      for (const group of replayPlan.sessionGroups) {
        this.db.prepare(`
          INSERT INTO fork_replay_session_groups (
            run_id, session_group_digest, member_count, replayed_count
          )
          VALUES (?, ?, ?, 0)
        `).run(forkId, group.sessionGroupDigest, group.memberCount);
      }
      for (const fact of rewrittenFacts) {
        this.db.prepare(`
          INSERT INTO fork_replay_facts (
            run_id, node_key, source_run_id, source_sequence,
            operation_digest, input_digest, session_group_digest, output_json, artifacts_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          forkId,
          fact.nodeKey,
          runId,
          fact.sourceSequence,
          fact.operationDigest,
          fact.inputDigest,
          fact.sessionGroupDigest ?? null,
          fact.output === undefined ? null : stableJsonLine(fact.output),
          stableJsonLine(fact.artifacts),
        );
      }
      sourceRun.verify();
      forkRun.verify();
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      this.generation.forgetRun(forkId);
      try {
        await removeOwnedDirectoryAfterFailure(
          this.generation.runsRoot,
          publishedFork,
          rollbackDatabaseTransaction(this.db, transactionStarted, error),
        );
      } catch (failure) {
        if (failure instanceof ForkSourceVersionMismatchError) return err(failure.failure);
        throw failure;
      }
    }
    return ok({ ...this.requireRun(forkId), forkCreated: true });
  }

  async cleanupStagedRunDirectories(): Promise<void> {
    let runsDir: string;
    try {
      runsDir = this.generation.runsRoot.verify();
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    let entries: string[];
    try {
      entries = await readdir(runsDir);
      this.generation.runsRoot.verify();
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.startsWith(".staging-") && !entry.startsWith(".cleanup-")) continue;
      const absolutePath = join(runsDir, entry);
      this.generation.runsRoot.verify();
      const owned = captureDirectoryIdentity(absolutePath, `Staged run directory '${absolutePath}'`);
      const info = await lstat(absolutePath);
      this.generation.runsRoot.verify();
      verifyDirectoryIdentity(owned, `Staged run directory '${absolutePath}'`);
      if (Date.now() - info.mtimeMs < 60_000) continue;
      if (entry.startsWith(".cleanup-")) {
        await removeOwnedDirectory(this.generation.runsRoot, owned);
        continue;
      }
      const quarantinePath = join(runsDir, `.cleanup-${randomUUID()}`);
      this.generation.runsRoot.verify();
      verifyDirectoryIdentity(owned, `Staged run directory '${absolutePath}'`);
      await rename(absolutePath, quarantinePath);
      this.generation.runsRoot.verify();
      const quarantine = captureDirectoryIdentity(quarantinePath, `Staged run quarantine '${quarantinePath}'`);
      assertSameDirectory(owned, quarantine, `Staged run directory '${absolutePath}' changed during cleanup.`);
      await removeOwnedDirectory(this.generation.runsRoot, quarantine);
    }
    for (const entry of entries) {
      if (!isRuntimeRunId(entry) || this.getRunRecord(entry)) continue;
      const absolutePath = join(runsDir, entry);
      this.generation.runsRoot.verify();
      const orphan = captureDirectoryIdentity(absolutePath, `Orphan run directory '${entry}'`);
      this.generation.runsRoot.verify();
      verifyDirectoryIdentity(orphan, `Orphan run directory '${entry}'`);
      if (this.getRunRecord(entry)) continue;
      throw new Error(`Orphan run directory '${entry}' has no database record and requires operator inspection.`);
    }
  }

  deleteRun(runId: string): ResultAsync<RunRecord | undefined, RunDeleteFailure> {
    return new ResultAsync(this.deleteRunResult(runId));
  }

  private async deleteRunResult(runId: string): Promise<Result<RunRecord | undefined, RunDeleteFailure>> {
    let transactionStarted = false;
    let runDirectory: RunDirectoryFence | undefined;
    let sourceDirectoryIdentity: DirectoryIdentity | undefined;
    let trashedDirectory: DirectoryIdentity | undefined;
    let trashPath: string | undefined;
    let run: RunRecord;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const existing = this.getRunRecord(runId);
      if (!existing) {
        this.db.exec("ROLLBACK");
        transactionStarted = false;
        return ok(undefined);
      }
      if (this.getRunExecutionState(existing).state === "active") {
        this.db.exec("ROLLBACK");
        transactionStarted = false;
        return err({
          type: "run-delete-active",
          runId,
          message: `Run '${runId}' is active and cannot be deleted.`,
        });
      }
      const lease = this.db.prepare(`
        SELECT lease_expires_at
        FROM run_leases
        WHERE run_id = ? AND released_at IS NULL
      `).get(runId) as { lease_expires_at: string } | undefined;
      if (lease && lease.lease_expires_at > new Date().toISOString()) {
        this.db.exec("ROLLBACK");
        transactionStarted = false;
        return err({
          type: "run-delete-active",
          runId,
          message: `Run '${runId}' has an active lease and cannot be deleted.`,
        });
      }
      runDirectory = this.generation.run(runId);
      sourceDirectoryIdentity = runDirectory.token().runDirectory;
      const trashRoot = this.generation.trashRoot.verify();
      trashPath = join(trashRoot, `${runId}-${randomUUID()}`);
      await requireMissingPath(trashPath);
      runDirectory.verify();
      this.generation.trashRoot.verify();
      await rename(sourceDirectoryIdentity.path, trashPath);
      this.generation.runsRoot.verify();
      this.generation.trashRoot.verify();
      trashedDirectory = captureDirectoryIdentity(trashPath, `Runtime trash entry '${trashPath}'`);
      assertSameDirectory(sourceDirectoryIdentity, trashedDirectory, `Run directory '${runId}' changed while it was moved to trash.`);
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      this.generation.runsRoot.verify();
      this.generation.trashRoot.verify();
      verifyDirectoryIdentity(trashedDirectory, `Runtime trash entry '${trashPath}'`);
      this.db.exec("COMMIT");
      transactionStarted = false;
      run = existing;
    } catch (error) {
      let failure = rollbackDatabaseTransaction(this.db, transactionStarted, error);
      if (runDirectory && sourceDirectoryIdentity && trashedDirectory && trashPath) {
        try {
          const originalPath = sourceDirectoryIdentity.path;
          this.generation.runsRoot.verify();
          this.generation.trashRoot.verify();
          verifyDirectoryIdentity(trashedDirectory, `Runtime trash entry '${trashPath}'`);
          await requireMissingPath(originalPath);
          await rename(trashPath, originalPath);
          this.generation.runsRoot.verify();
          this.generation.trashRoot.verify();
          const restored = captureDirectoryIdentity(originalPath, `Run directory '${runId}'`);
          assertSameDirectory(trashedDirectory, restored, `Run directory '${runId}' changed while it was restored from trash.`);
          runDirectory.verify();
        } catch (restoreError) {
          failure = new AggregateError([failure, restoreError], `Run '${runId}' deletion failed and its trash entry could not be restored.`);
        }
      }
      throw failure;
    }
    this.generation.forgetRun(runId);
    if (!trashedDirectory) throw new Error(`Run '${runId}' deletion committed without an owned trash entry.`);
    await removeOwnedDirectory(this.generation.trashRoot, trashedDirectory);
    return ok(run);
  }

  writeHookJournal(entry: HookJournalEntry): void {
    this.db.prepare(`
      INSERT INTO hook_journal (
        run_id, event_sequence, trigger_order, event, source, source_path, handler_id, definition_hash,
        node_key, status, exit_code, stdout, stderr, duration_ms, error, triggered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, event_sequence, definition_hash) DO NOTHING
    `).run(
      entry.runId,
      entry.eventSequence,
      entry.triggerOrder,
      entry.event,
      entry.source,
      entry.sourcePath,
      entry.handlerId,
      entry.definitionHash,
      entry.nodeKey ?? null,
      entry.status,
      entry.exitCode ?? null,
      entry.stdout ?? null,
      entry.stderr ?? null,
      entry.durationMs ?? null,
      entry.error ?? null,
      entry.triggeredAt,
    );
  }

  getHookJournal(runId: string): HookJournalEntry[] {
    return this.inspectionReadModel.getHookJournal(runId);
  }

  pruneHookJournal(cutoff: Date): number {
    return Number(this.db.prepare("DELETE FROM hook_journal WHERE triggered_at < ?").run(cutoff.toISOString()).changes);
  }

  getHookDispatchCursor(runId: string): number {
    const row = this.db.prepare("SELECT event_sequence FROM hook_dispatch_cursors WHERE run_id = ?").get(runId) as { event_sequence: number } | undefined;
    if (!row) {
      if (this.getRunRecord(runId)) throw new Error(`Run '${runId}' has no hook dispatch cursor.`);
      throw new Error(`Run '${runId}' was not found.`);
    }
    const sequence = Number(row.event_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`Run '${runId}' has an invalid hook dispatch cursor.`);
    return sequence;
  }

  compareAndSetHookDispatchCursor(runId: string, expectedSequence: number, nextSequence: number): boolean {
    if (!Number.isSafeInteger(expectedSequence) || !Number.isSafeInteger(nextSequence) || expectedSequence < 0 || nextSequence <= expectedSequence) {
      throw new Error(`Run '${runId}' hook dispatch cursor transition is invalid.`);
    }
    const result = this.db.prepare(`
      UPDATE hook_dispatch_cursors
      SET event_sequence = ?
      WHERE run_id = ? AND event_sequence = ?
    `).run(nextSequence, runId, expectedSequence);
    return result.changes === 1;
  }

  getLastRunEventSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?").get(runId) as { sequence: number } | undefined;
    return Number(row?.sequence ?? 0);
  }

  getRunEventVersion(runId: string): number | undefined {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(run_events.sequence), 0) AS sequence
      FROM runs
      LEFT JOIN run_events ON run_events.run_id = runs.id
      WHERE runs.id = ?
      GROUP BY runs.id
    `).get(runId) as { sequence: number } | undefined;
    if (!row) return undefined;
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`Run '${runId}' has an invalid event sequence.`);
    return sequence;
  }

  readHookDispatchEvents(runId: string, afterSequence: number): HookDispatchEventRead {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN");
      transactionStarted = true;
      const lastSequence = this.getRunEventVersion(runId);
      if (lastSequence === undefined) throw new Error(`Run '${runId}' was not found.`);
      const row = this.db.prepare(`
        SELECT run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
        FROM run_events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT 1
      `).get(runId, afterSequence) as {
        run_id: string;
        sequence: number;
        type: string;
        node_key: string | null;
        payload_json: string;
        created_at: string;
        idempotency_key: string;
      } | undefined;
      const events = row ? [decodeCommittedRuntimeEventRow(row)] : [];
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { lastSequence, events };
    } catch (error) {
      throw rollbackDatabaseTransaction(this.db, transactionStarted, error);
    }
  }

  getCommittedRuntimeEventsAfter(runId: string, sequence: number): CommittedRuntimeEventRow[] {
    const rows = this.db.prepare(`
      SELECT run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
      FROM run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(runId, sequence) as Array<{
      run_id: string;
      sequence: number;
      type: string;
      node_key: string | null;
      payload_json: string;
      created_at: string;
      idempotency_key: string;
    }>;
    return rows.map(decodeCommittedRuntimeEventRow);
  }

  getInspectionTimelineEvents(runId: string, nodeKeys: readonly string[], limit: number): CommittedRuntimeEventRow[] {
    const keys = [...new Set(nodeKeys)].sort();
    const nodeFilter = keys.length > 0 ? `node_key IN (${keys.map(() => "?").join(", ")})` : "0";
    const rows = this.db.prepare(`
      SELECT run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
      FROM run_events
      WHERE run_id = ?
        AND (${nodeFilter}
          OR type IN ('run.completed', 'run.failed', 'run.canceled', 'control.paused', 'control.resumed'))
      ORDER BY sequence DESC
      LIMIT ?
    `).all(runId, ...keys, Math.max(1, Math.min(64, limit))) as Array<{
      run_id: string;
      sequence: number;
      type: string;
      node_key: string | null;
      payload_json: string;
      created_at: string;
      idempotency_key: string;
    }>;
    return rows.reverse().map(decodeCommittedRuntimeEventRow);
  }

  readRunInspectionToken(runId: string): RunInspectionToken | undefined {
    const row = this.db.prepare(`
      SELECT
        runs.progress_version,
        runs.observation_version,
        COALESCE((
          SELECT MAX(sequence)
          FROM run_events
          WHERE run_id = runs.id
        ), 0) AS event_sequence
      FROM runs
      WHERE runs.id = ?
    `).get(runId) as {
      progress_version: number;
      observation_version: number;
      event_sequence: number;
    } | undefined;
    return row === undefined
      ? undefined
      : {
          eventSequence: row.event_sequence,
          progressVersion: row.progress_version,
          observationVersion: row.observation_version,
        };
  }

  readRunInspection(runId: string, afterEventSequence?: number): RunInspectionStoreRead {
    const ownsTransaction = !this.db.isTransaction;
    try {
      if (ownsTransaction) this.db.exec("BEGIN");
      const run = this.getRun(runId);
      const frozen = run ? this.readFrozenRun(runId, false) : undefined;
      const eventSequence = run ? this.getLastRunEventSequence(runId) : 0;
      const observation = run
        ? this.db.prepare("SELECT observation_version FROM runs WHERE id = ?").get(runId) as { observation_version: number }
        : undefined;
      const artifacts = run ? this.listArtifacts(runId) : [];
      const events = run && afterEventSequence !== undefined
        ? this.getCommittedRuntimeEventsAfter(runId, afterEventSequence)
        : [];
      if (ownsTransaction) this.db.exec("COMMIT");
      return {
        ...(run ? { run } : {}),
        ...(frozen ? { frozen } : {}),
        artifacts,
        cursor: {
          eventSequence,
          progressVersion: run?.progressVersion ?? 0,
          observationVersion: observation?.observation_version ?? 0,
        },
        events,
      };
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pathGeneration(): OpenedRuntimeGeneration {
    return this.generation;
  }

  getRunDir(runId: string): string | undefined {
    if (!this.getRunRecord(runId)) return undefined;
    return this.generation.run(runId).verify();
  }

  getRunDirectoryToken(runId: string): RunDirectoryToken | undefined {
    if (!this.getRunRecord(runId)) return undefined;
    return this.generation.run(runId).token();
  }

  registerArtifact(input: RegisterArtifactInput): SchedulerStoreResult<void> {
    return schedulerStoreResult(() => this.insertArtifact(input));
  }

  private insertArtifact(input: RegisterArtifactInput): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.db.prepare(`
        SELECT run_id, node_key, attempt_no, owner_epoch, status
        FROM node_attempts
        WHERE attempt_id = ?
      `).get(input.attemptId) as { run_id: string; node_key: string; attempt_no: number; owner_epoch: number; status: string } | undefined;
      if (!attempt || attempt.run_id !== input.runId || attempt.node_key !== input.nodeKey || attempt.attempt_no !== input.attempt) {
        throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' does not match artifact '${input.id}'.` });
      }
      if (attempt.owner_epoch !== input.ownerEpoch) {
        throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
      }
      requireActiveOwnerEpoch(this.db, input.runId, input.ownerEpoch);
      if (attempt.status !== "started") {
        throwSchedulerStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
      }
      const run = this.generation.run(input.runId);
      const artifactPath = resolveArtifactRegistrationPath({
        runDir: run.verify(),
        nodeKey: input.nodeKey,
        attempt: input.attempt,
        relativePath: input.relativePath,
      });
      if (!artifactPath) {
        throw new Error(`Artifact '${input.id}' path must be inside its attempt artifact directory.`);
      }
      verifyRegisteredArtifact(run, artifactPath, input);
      run.verify();
      this.db.prepare(`
        INSERT INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.runId,
        input.nodeKey,
        input.attempt,
        input.mediaType ?? null,
        input.digest,
        input.size,
        input.relativePath,
        new Date().toISOString(),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getArtifact(runId: string, artifactId: string): ArtifactRecord | undefined {
    const row = this.db.prepare(
      "SELECT id, run_id, node_key, attempt, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? AND id = ?"
    ).get(runId, artifactId) as ArtifactRow | undefined;
    if (!row) return undefined;
    return this.artifactRecord(row, this.artifactRoot(runId));
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    const rows = this.db.prepare(
      "SELECT id, run_id, node_key, attempt, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY created_at ASC, id ASC"
    ).all(runId) as ArtifactRow[];
    if (rows.length === 0) return [];
    const root = this.artifactRoot(runId);
    return rows.map(row => this.artifactRecord(row, root));
  }

  private artifactRoot(runId: string): string {
    const runDir = this.getRunDir(runId);
    if (!runDir) throw new Error(`Run '${runId}' has no run directory.`);
    return runDir;
  }

  private artifactRecord(row: ArtifactRow, root: string): ArtifactRecord {
    const runId = String(row.run_id);
    const relativePath = String(row.relative_path);
    const path = resolve(root, relativePath);
    if (!isContainedPath(root, path)) throw new Error(`Artifact '${String(row.id)}' path escapes run directory.`);
    return {
      id: String(row.id),
      runId,
      nodeKey: String(row.node_key),
      attempt: Number(row.attempt),
      ...(row.media_type === null ? {} : { mediaType: String(row.media_type) }),
      digest: String(row.digest),
      size: Number(row.size),
      path,
    };
  }

  writeExecutionMetadata(input: WriteExecutionMetadataInput): void {
    this.db.prepare(`
      INSERT INTO execution_metadata (run_id, attempt_id, kind, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.attemptId ?? null,
      input.kind,
      stableJsonLine(input.metadata),
      new Date().toISOString(),
    );
  }

  getExecutionMetadata(runId: string): RunExecutionMetadata[] {
    return this.inspectionReadModel.getExecutionMetadata(runId);
  }

  writeNodeProgress(input: WriteNodeProgressInput): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const started = this.db.prepare(`
        SELECT 1
        FROM node_attempts
        JOIN run_leases ON run_leases.run_id = node_attempts.run_id
        WHERE node_attempts.attempt_id = ?
          AND node_attempts.run_id = ?
          AND node_attempts.node_key = ?
          AND node_attempts.node_id = ?
          AND node_attempts.owner_epoch = ?
          AND node_attempts.status = 'started'
          AND (? IS NULL OR node_attempts.attempt_no = ?)
          AND run_leases.owner_epoch = ?
          AND run_leases.released_at IS NULL
          AND run_leases.lease_expires_at > ?
      `).get(
        input.attemptId,
        input.runId,
        input.nodeKey,
        input.nodeId,
        input.ownerEpoch,
        input.attemptNo ?? null,
        input.attemptNo ?? null,
        input.ownerEpoch,
        now,
      );
      if (!started) {
        this.db.exec("COMMIT");
        return;
      }
      const existingTerminal = this.db.prepare(`
        SELECT 1
        FROM node_progress
        WHERE run_id = ? AND node_key = ? AND attempt_id = ?
          AND status IN ('completed', 'failed', 'cancelled', 'timed_out')
      `).get(input.runId, input.nodeKey, input.attemptId);
      if (existingTerminal && !["completed", "failed", "cancelled", "timed_out"].includes(input.status)) {
        this.db.exec("COMMIT");
        return;
      }
      this.db.prepare(`
        INSERT INTO node_progress (
          run_id, node_key, node_id, attempt_id, attempt_no, kind, status, message,
          output_tail, output_total_bytes, output_truncated,
          context_json, token_usage_json, tools_json, intent_json, acp_activity_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          attempt_id = excluded.attempt_id,
          attempt_no = excluded.attempt_no,
          kind = excluded.kind,
          status = excluded.status,
          message = excluded.message,
          output_tail = excluded.output_tail,
          output_total_bytes = excluded.output_total_bytes,
          output_truncated = excluded.output_truncated,
          context_json = excluded.context_json,
          token_usage_json = excluded.token_usage_json,
          tools_json = excluded.tools_json,
          intent_json = excluded.intent_json,
          acp_activity_at = excluded.acp_activity_at,
          updated_at = excluded.updated_at
      `).run(
        input.runId,
        input.nodeKey,
        input.nodeId,
        input.attemptId,
        input.attemptNo ?? null,
        input.kind,
        input.status,
        input.message ?? null,
        input.output?.tail ?? null,
        input.output?.totalBytes ?? null,
        input.output?.truncated === undefined ? null : input.output.truncated ? 1 : 0,
        input.context === undefined ? null : stableJsonLine(input.context),
        input.tokenUsage === undefined ? null : stableJsonLine(input.tokenUsage),
        input.tools === undefined ? null : stableJsonLine(input.tools),
        input.intent === undefined ? null : stableJsonLine(input.intent),
        input.acpActivityAt ?? null,
        now,
      );
      this.db.prepare(`
        UPDATE runs
        SET progress_version = progress_version + 1, progress_updated_at = ?
        WHERE id = ?
      `).run(now, input.runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): RunDetails | undefined {
    const run = this.getRunRecord(runId);
    if (!run) return undefined;
    const input = this.db.prepare(`
      SELECT input_json, agent_overrides_json, output_json
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunDetailsInputRow | undefined;
    if (!input) throw new Error(`Run '${runId}' has no frozen input.`);
    const agentOverrides = parseAgentOverrides(input.agent_overrides_json);
    const eventCount = this.count("run_events", runId);
    const nodeCount = this.count("node_states", runId);
    const dynamic = this.inspectionReadModel.getDynamicDetails(runId);
    const fork = this.getRunFork(runId);
    return {
      ...run,
      input: JSON.parse(input.input_json) as JsonValue,
      ...(input.output_json ? { output: JSON.parse(input.output_json) as JsonValue } : {}),
      ...(Object.keys(agentOverrides).length > 0 ? { agentOverrides } : {}),
      ...(fork ? { fork } : {}),
      hooks: isTerminalRunStatus(run.status) ? this.getHookJournal(runId) : [],
      eventCount,
      nodeCount,
      execution: this.getRunExecutionState(run),
      ...(dynamic ? { dynamic } : {}),
    };
  }

  private getRunFork(runId: string): RunForkInfo | undefined {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM run_events
      WHERE run_id = ? AND type = 'run.forked'
      ORDER BY sequence ASC
      LIMIT 1
    `).get(runId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (typeof payload.sourceRunId !== "string") throw new Error(`Fork event for run '${runId}' is missing sourceRunId.`);
    if (payload.target !== undefined && typeof payload.target !== "string") throw new Error(`Fork event for run '${runId}' has an invalid target.`);
    return {
      sourceRunId: payload.sourceRunId,
      ...(payload.target === undefined ? {} : { target: payload.target }),
    };
  }

  private getRunExecutionState(run: RunRecord): RunExecutionState {
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") return { state: "terminal", lastStatus: run.status, reason: "terminal" };
    const now = Date.now();
    const daemon = this.db.prepare(`
      SELECT pid, heartbeat_at
      FROM daemon_lease
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { pid: number | null; heartbeat_at: string | null } | undefined;
    const lease = this.db.prepare(`
      SELECT owner_id, lease_expires_at
      FROM run_leases
      WHERE run_id = ? AND released_at IS NULL
      ORDER BY claimed_at DESC
      LIMIT 1
    `).get(run.id) as { owner_id: string; lease_expires_at: string } | undefined;
    if (daemon?.heartbeat_at && now - Date.parse(daemon.heartbeat_at) > 5_000) {
      return { state: "stale", lastStatus: run.status, reason: "daemon_heartbeat_expired", daemonHeartbeatAt: daemon.heartbeat_at, ...(lease ? { ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at } : {}) };
    }
    const processLiveness = daemon?.pid === null || daemon?.pid === undefined ? undefined : probeProcessLiveness(daemon.pid);
    if (processLiveness === "dead") {
      return { state: "stale", lastStatus: run.status, reason: "daemon_pid_dead", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ...(lease ? { ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at } : {}) };
    }
    if (lease && Date.parse(lease.lease_expires_at) <= now) {
      return { state: "stale", lastStatus: run.status, reason: "run_lease_expired", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at };
    }
    if (lease) return { state: "active", lastStatus: run.status, reason: "run_lease_active", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at };
    if (daemon?.heartbeat_at || processLiveness === "alive") return { state: "inactive", lastStatus: run.status, reason: "daemon_alive", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}) };
    if (processLiveness === "unknown") return { state: "unknown", lastStatus: run.status };
    return { state: "inactive", lastStatus: run.status, reason: "no_liveness_evidence" };
  }

  listRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT ${this.runRecordColumns()}
      FROM runs
      ORDER BY updated_at DESC, created_at DESC
    `).all().map(toRunRecord);
  }

  getRunStoreSummary(): RunStoreSummary {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS run_count, MAX(updated_at) AS last_run_updated_at
      FROM runs
    `).get() as { run_count: number; last_run_updated_at: string | null };
    if (!Number.isSafeInteger(row.run_count) || row.run_count < 0
      || (row.last_run_updated_at !== null && typeof row.last_run_updated_at !== "string")) {
      throw new Error("Runtime run summary is corrupt.");
    }
    return {
      runCount: row.run_count,
      ...(row.last_run_updated_at === null ? {} : { lastRunUpdatedAt: row.last_run_updated_at }),
    };
  }

  listWorkflowSources(): WorkflowSourceRef[] {
    const rows = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, runs.source_graph_digest,
        run_inputs.workflow_ir_path, run_inputs.workflow_ir_digest,
        run_inputs.lock_path, run_inputs.lock_digest, run_inputs.source_json
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
    `).all() as FrozenSourceRow[];
    return rows.map(row => verifiedFrozenWorkflowSource(
      this.generation.run(row.id).verify(),
      row,
    ).source);
  }

  getRuntimeDiagnostics(): RuntimeDiagnostics {
    const now = new Date().toISOString();
    const daemon = this.db.prepare(`
      SELECT workspace_realpath, generation, pid, heartbeat_at, idle_since_at, idle_stop_ms, protocol_version, package_version, node_version, exec_path, updated_at
      FROM daemon_lease
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as {
      workspace_realpath: string;
      generation: number;
      pid: number | null;
      heartbeat_at: string | null;
      idle_since_at: string | null;
      idle_stop_ms: number | null;
      protocol_version: number;
      package_version: string;
      node_version: string;
      exec_path: string;
      updated_at: string;
    } | undefined;
    const runs = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'awaiting' THEN 1 ELSE 0 END) AS awaiting,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled
      FROM runs
    `).get() as Record<string, number | null>;
    const stale = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM run_leases
      WHERE released_at IS NULL AND lease_expires_at <= ?
    `).get(now) as CountRow;
    return {
      ...(daemon ? {
        daemon: {
          workspaceRealpath: daemon.workspace_realpath,
          generation: daemon.generation,
          ...(daemon.pid === null ? {} : { pid: daemon.pid }),
          ...(daemon.heartbeat_at === null ? {} : { heartbeatAt: daemon.heartbeat_at }),
          ...(daemon.idle_since_at === null ? {} : { idleSinceAt: daemon.idle_since_at }),
          ...(daemon.idle_stop_ms === null ? {} : { idleStopMs: daemon.idle_stop_ms }),
          protocolVersion: daemon.protocol_version,
          packageVersion: daemon.package_version,
          nodeVersion: daemon.node_version,
          execPath: daemon.exec_path,
          updatedAt: daemon.updated_at,
        },
      } : {}),
      runs: {
        total: Number(runs.total ?? 0),
        pending: Number(runs.pending ?? 0),
        running: Number(runs.running ?? 0),
        awaiting: Number(runs.awaiting ?? 0),
        paused: Number(runs.paused ?? 0),
        failed: Number(runs.failed ?? 0),
        completed: Number(runs.completed ?? 0),
        canceled: Number(runs.canceled ?? 0),
        runnable: this.countRunnableRuns(),
      },
      leases: {
        stale: Number(stale.count),
      },
    };
  }

  private getRunRecord(runId: string): RunRecord | undefined {
    const row = this.db.prepare(`
      SELECT ${this.runRecordColumns()}
      FROM runs
      WHERE id = ?
    `).get(runId) as RunRow | undefined;
    return row ? toRunRecord(row) : undefined;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.getRunRecord(runId);
    if (!run) throw new Error(`Run '${runId}' was not found.`);
    return run;
  }

  private count(table: "run_events" | "node_states", runId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId) as CountRow | undefined;
    return row?.count ?? 0;
  }

}

export function withRunInspectionSnapshot<T>(store: RuntimeStore, read: () => Promise<T>): Promise<T> {
  if (!(store instanceof SqliteRuntimeStore)) {
    throw new Error("Run inspection snapshots require the SQLite runtime store.");
  }
  return store.withInspectionSnapshot(read);
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function parseAgentOverrides(json: string): AgentOverrideMap {
  return parseAgentOverrideMap(JSON.parse(json) as unknown);
}


function toRunRecord(row: Record<string, unknown>): RunRecord {
  return withoutUndefined({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as RunStatus,
    workflowEntry: String(row.workflow_entry),
    sourceGraphDigest: String(row.source_graph_digest),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    progressVersion: Number(row.progress_version ?? 0),
    progressUpdatedAt: nullableString(row.progress_updated_at),
  }) as RunRecord;
}

function collectNodeIds(scope: ScopeIR): string[] {
  return Array.from(walkNodes(scope), ({ node }) => node.id);
}

function requireArtifactId(map: Record<string, string>, sourceId: string): string {
  const id = map[sourceId];
  if (!id) throw new Error(`Missing fork artifact id for '${sourceId}'.`);
  return id;
}

function requireArtifactPath(map: Record<string, string>, sourceId: string): string {
  const path = map[sourceId];
  if (!path) throw new Error(`Missing fork artifact path for '${sourceId}'.`);
  return path;
}

function collectArtifactIds(value: JsonValue, runId: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, runId, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const uri = (value as { uri?: unknown }).uri;
  const prefix = `artifact://${runId}/`;
  if (typeof uri === "string" && uri.startsWith(prefix)) out.add(uri.slice(prefix.length));
  for (const item of Object.values(value)) collectArtifactIds(item as JsonValue, runId, out);
}

async function publishWorkflowSource(
  prepared: PreparedRunWorkflow,
  layout: RuntimeLayout,
  sourcesRoot: DirectoryFence,
): Promise<void> {
  if (prepared.source.kind === "workspace") return;
  const sourceBundle = prepared.sourceBundle!;
  const root = sourcesRoot.verify();
  const snapshots = await ensureFencedChildDirectory(
    sourcesRoot,
    "snapshots",
    "Runtime workflow snapshots",
    layout.platform,
  );
  const target = snapshotRootForSource(layout, prepared.source);
  if (!isContainedPath(root, target)) {
    throw new Error(`Frozen workflow snapshot '${target}' escapes runtime sources root.`);
  }
  if (await ownedDirectoryExists(target)) {
    sourcesRoot.verify();
    snapshots.verify();
    verifyPublishedWorkflowSource(target, prepared.source, layout.platform);
    sourcesRoot.verify();
    snapshots.verify();
    return;
  }
  const digestHex = digestHexForPath(prepared.source.digest);
  const parent = snapshots.verify();
  const staging = join(parent, `.staging-${digestHex}-${randomUUID()}`);
  snapshots.verify();
  await mkdir(staging, { mode: 0o700 });
  snapshots.verify();
  const staged = captureDirectoryIdentity(staging, `Frozen workflow snapshot staging '${staging}'`);
  let published: DirectoryIdentity | undefined;
  const assertStaged = (): void => {
    sourcesRoot.verify();
    snapshots.verify();
    verifyDirectoryIdentity(staged, `Frozen workflow snapshot staging '${staging}'`);
  };
  try {
    assertStaged();
    const filesRoot = join(staging, "files");
    await mkdir(filesRoot, { mode: 0o700 });
    for (const file of sourceBundle.files) {
      assertStaged();
      const path = resolve(filesRoot, file.path);
      if (!isContainedPath(filesRoot, path)) {
        throw new Error(`Workflow source file '${file.path}' escapes its snapshot.`);
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      assertStaged();
      await writeFile(path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    const manifest = createWorkflowSourceSnapshotManifest(prepared.source, sourceBundle.files);
    assertStaged();
    await writeFile(join(staging, "manifest.json"), stableJsonLine(manifest), { encoding: "utf8", flag: "wx", mode: 0o600 });
    assertStaged();
    await makeTreePrivate(staging, layout.platform, assertStaged);
    assertStaged();
    verifyPublishedWorkflowSource(staging, prepared.source, layout.platform);
    await requireMissingPath(target);
    assertStaged();
    try {
      await rename(staging, target);
      sourcesRoot.verify();
      snapshots.verify();
      published = captureDirectoryIdentity(target, `Frozen workflow snapshot '${target}'`);
      assertSameDirectory(staged, published, `Frozen workflow snapshot '${target}' changed during publication.`);
      verifyPublishedWorkflowSource(target, prepared.source, layout.platform);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
      sourcesRoot.verify();
      snapshots.verify();
      verifyPublishedWorkflowSource(target, prepared.source, layout.platform);
      await removeOwnedDirectory(sourcesRoot, staged);
    }
  } catch (error) {
    await removeOwnedDirectoriesAfterFailure(
      sourcesRoot,
      [published, staged].filter((directory): directory is DirectoryIdentity => directory !== undefined),
      error,
    );
  }
}

function sourceRootForRun(layout: RuntimeLayout, source: WorkflowSourceRef): string {
  return source.kind === "workspace"
    ? layout.canonicalPath
    : join(snapshotRootForSource(layout, source), "files");
}

function snapshotRootForSource(
  layout: RuntimeLayout,
  source: Extract<WorkflowSourceRef, { kind: "snapshot" }>,
): string {
  return join(layout.sourcesRoot, "snapshots", digestHexForPath(source.digest));
}

function resolveFrozenSourceRoot(
  layout: RuntimeLayout,
  source: WorkflowSourceRef,
  sourcesRoot: DirectoryFence,
): string {
  if (source.kind === "workspace") return layout.canonicalPath;
  const root = sourcesRoot.verifyIdentity();
  const snapshotRoot = snapshotRootForSource(layout, source);
  const snapshot = captureDirectoryIdentity(
    snapshotRoot,
    `Frozen workflow snapshot '${source.digest}'`,
  );
  if (!isContainedPath(root.realpath, snapshot.realpath)) {
    throw new Error(`Frozen workflow snapshot '${snapshot.path}' escapes runtime sources root.`);
  }
  verifyPublishedWorkflowSource(snapshotRoot, source, layout.platform);
  sourcesRoot.verify();
  const target = captureDirectoryIdentity(
    sourceRootForRun(layout, source),
    `Frozen workflow snapshot files '${source.digest}'`,
  );
  if (!isContainedPath(root.realpath, target.realpath)) {
    throw new Error(`Frozen workflow snapshot files '${target.path}' escape runtime sources root.`);
  }
  sourcesRoot.verify();
  return target.path;
}

async function ownedDirectoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Runtime workflow snapshot '${path}' is not a regular directory.`);
    }
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function verifyPublishedWorkflowSource(
  root: string,
  source: Extract<WorkflowSourceRef, { kind: "snapshot" }>,
  platform: NodeJS.Platform,
): void {
  const snapshot = new DirectoryFence(root, `Frozen workflow snapshot '${source.digest}'`);
  assertPrivateSnapshotMode(snapshot.verify(), 0o700, platform);
  assertPrivateSnapshotMode(dirname(snapshot.verify()), 0o700, platform);
  assertPrivateSnapshotMode(join(snapshot.verify(), "manifest.json"), 0o600, platform);
  const manifestBytes = readContainedFileSync(snapshot.verify(), "manifest.json");
  snapshot.verify();
  let manifest: unknown;
  let manifestJson: string;
  try {
    manifestJson = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    manifest = JSON.parse(manifestJson);
  } catch {
    throw new Error(`Frozen workflow snapshot '${source.digest}' has an invalid manifest.`);
  }
  if (!isWorkflowSourceSnapshotManifest(manifest)
    || !manifestBytes.equals(Buffer.from(stableJsonLine(manifest), "utf8"))
    || manifest.entry !== source.entry
    || manifest.digest !== source.digest
    || workflowSourceGraphDigestFromManifest(manifest) !== source.digest) {
    throw new Error(`Frozen workflow snapshot '${source.digest}' failed manifest verification.`);
  }
  const filesRoot = join(snapshot.verify(), "files");
  const files = new DirectoryFence(filesRoot, `Frozen workflow snapshot files '${source.digest}'`);
  assertPrivateSnapshotMode(files.verify(), 0o700, platform);
  const actualPaths = collectSnapshotFilePaths(files.verify(), "", platform);
  const expectedPaths = manifest.files.map(file => file.path);
  if (stableJsonLine(actualPaths) !== stableJsonLine(expectedPaths)) {
    throw new Error(`Frozen workflow snapshot '${source.digest}' has unexpected files.`);
  }
  for (const file of manifest.files) {
    snapshot.verify();
    files.verify();
    const bytes = readContainedFileSync(filesRoot, file.path);
    if (sha256Digest(bytes) !== file.digest) {
      throw new Error(`Frozen workflow snapshot file '${file.path}' failed digest verification.`);
    }
  }
  snapshot.verify();
  files.verify();
}

function collectSnapshotFilePaths(
  root: string,
  relativeRoot: string,
  platform: NodeJS.Platform,
): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(resolve(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const path = resolve(root, relativePath);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Frozen workflow snapshot path '${relativePath}' is a symbolic link.`);
    }
    if (info.isDirectory()) {
      assertPrivateSnapshotMode(path, 0o700, platform);
      const nested = collectSnapshotFilePaths(root, relativePath, platform);
      if (nested.length === 0) {
        throw new Error(`Frozen workflow snapshot directory '${relativePath}' is empty.`);
      }
      paths.push(...nested);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Frozen workflow snapshot path '${relativePath}' is not a regular file.`);
    }
    assertPrivateSnapshotMode(path, 0o600, platform);
    paths.push(relativePath);
  }
  return paths.sort(compareSourcePaths);
}

function assertPrivateSnapshotMode(
  path: string,
  expected: 0o600 | 0o700,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") return;
  if ((lstatSync(path).mode & 0o777) !== expected) {
    throw new Error(`Frozen workflow snapshot path '${path}' is not private.`);
  }
}

function compareSourcePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestHexForPath(value: Sha256Digest): string {
  return value.slice("sha256:".length);
}

async function ensureFencedChildDirectory(
  parent: DirectoryFence,
  name: string,
  label: string,
  platform: NodeJS.Platform,
): Promise<DirectoryFence> {
  const parentIdentity = parent.verifyIdentity();
  const path = resolve(parentIdentity.path, name);
  if (dirname(path) !== parentIdentity.path || basename(path) !== name) {
    throw new Error(`${label} '${path}' escapes its parent directory.`);
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  parent.verify();
  const child = new DirectoryFence(path, label);
  if (dirname(child.verifyIdentity().realpath) !== parent.verifyIdentity().realpath) {
    throw new Error(`${label} '${path}' escapes its parent directory.`);
  }
  if (platform !== "win32") {
    parent.verify();
    child.verify();
    await chmod(path, 0o700);
    parent.verify();
    child.verify();
  }
  return child;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function makeTreePrivate(
  root: string,
  platform: NodeJS.Platform,
  assertCurrent: () => void = () => {},
): Promise<void> {
  if (platform === "win32") return;
  assertCurrent();
  const item = await lstat(root);
  assertCurrent();
  if (item.isSymbolicLink()) {
    throw new Error(`Runtime-owned path '${root}' is a symbolic link.`);
  }
  if (!item.isDirectory() && !item.isFile()) {
    throw new Error(`Runtime-owned path '${root}' is not a regular file or directory.`);
  }
  await chmod(root, item.isDirectory() ? 0o700 : 0o600);
  assertCurrent();
  if (!item.isDirectory()) return;
  for (const name of await readdir(root)) {
    assertCurrent();
    await makeTreePrivate(join(root, name), platform, assertCurrent);
  }
}

export async function publishRunDirectory(input: {
  runsRoot: DirectoryFence;
  runId: string;
  platform: NodeJS.Platform;
  populate(runDir: string, assertCurrent: () => void): Promise<void>;
}): Promise<DirectoryIdentity> {
  const runsRoot = input.runsRoot.verify();
  if (!isRuntimeRunId(input.runId)) {
    throw new Error(`Run directory '${input.runId}' is outside runtime runs root '${runsRoot}'.`);
  }
  const stagedRunDir = join(runsRoot, `.staging-${input.runId}`);
  const runDir = join(runsRoot, input.runId);
  let staging: DirectoryIdentity | undefined;
  let published: DirectoryIdentity | undefined;
  try {
    input.runsRoot.verify();
    await mkdir(stagedRunDir, { mode: 0o700 });
    input.runsRoot.verify();
    staging = captureDirectoryIdentity(stagedRunDir, `Run staging directory '${input.runId}'`);
    verifyDirectoryIdentity(staging, `Run staging directory '${input.runId}'`);
    await mkdir(runDir, { mode: 0o700 });
    input.runsRoot.verify();
    published = captureDirectoryIdentity(runDir, `Run directory '${input.runId}'`);
    const assertCurrent = (): void => {
      input.runsRoot.verify();
      verifyDirectoryIdentity(staging!, `Run staging directory '${input.runId}'`);
      verifyDirectoryIdentity(published!, `Run directory '${input.runId}'`);
    };
    await input.populate(runDir, assertCurrent);
    assertCurrent();
    await makeTreePrivate(runDir, input.platform, assertCurrent);
    assertCurrent();
    await removeOwnedDirectory(input.runsRoot, staging);
    verifyDirectoryIdentity(published, `Run directory '${input.runId}'`);
    return published;
  } catch (error) {
    return removeOwnedDirectoriesAfterFailure(
      input.runsRoot,
      [published, staging].filter((directory): directory is DirectoryIdentity => directory !== undefined),
      error,
    );
  }
}

async function requireMissingPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Run directory '${path}' already exists.`);
}

async function copyVerifiedArtifacts(
  sourceRun: RunDirectoryFence,
  destinationRunDir: string,
  artifacts: ArtifactRow[],
  destinationPaths: Record<string, string>,
  assertDestination: () => void,
): Promise<void> {
  const sourceRunDir = sourceRun.verify();
  const sourceArtifactRoot = resolve(sourceRunDir, "artifacts");
  if (artifacts.length > 0) {
    const info = await lstat(sourceArtifactRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Fork artifact '${String(artifacts[0]!.id)}' has invalid relative path.`);
    }
  }
  for (const artifact of artifacts) {
    sourceRun.verify();
    assertDestination();
    const relativePath = String(artifact.relative_path);
    const sourcePath = resolve(sourceRunDir, relativePath);
    const destinationArtifactRoot = resolve(destinationRunDir, "artifacts");
    const destination = resolve(destinationRunDir, requireArtifactPath(destinationPaths, String(artifact.id)));
    if (
      isAbsolute(relativePath)
      || sourcePath === sourceArtifactRoot
      || destination === destinationArtifactRoot
      || !isContainedPath(sourceArtifactRoot, sourcePath)
      || !isContainedPath(destinationArtifactRoot, destination)
    ) {
      throw new Error(`Fork artifact '${String(artifact.id)}' has invalid relative path.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readContainedFile(sourceArtifactRoot, relative(sourceArtifactRoot, sourcePath));
    } catch (error) {
      if (error instanceof PathEscapeError) throw new Error(`Fork artifact '${String(artifact.id)}' has invalid relative path.`);
      throw error;
    }
    sourceRun.verify();
    assertDestination();
    const expectedSize = Number(artifact.size);
    const expectedDigest = String(artifact.digest);
    const actualDigest = sha256Digest(bytes);
    if (bytes.byteLength !== expectedSize || actualDigest !== expectedDigest) {
      throw new Error(`Fork artifact '${String(artifact.id)}' failed source verification.`);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    sourceRun.verify();
    assertDestination();
    await writeFile(destination, bytes, { mode: 0o600 });
    sourceRun.verify();
    assertDestination();
  }
}

async function writeFrozenRunFiles(
  runDir: string,
  workflowIrJson: string,
  lockJson: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  assertCurrent();
  await writeFile(join(runDir, "workflow.ir.json"), workflowIrJson, { mode: 0o600 });
  assertCurrent();
  await writeFile(join(runDir, "lock.json"), lockJson, { mode: 0o600 });
  assertCurrent();
}

async function verifyFrozenRunFiles(runDir: string, lockJson: string, workflowIrJson: string): Promise<void> {
  const irBytes = await readContainedFile(runDir, "workflow.ir.json");
  const lock = JSON.parse(lockJson) as RunWorkflowLockArtifact;
  if (sha256Digest(irBytes) !== lock.ir.digest) throw new Error("Fork workflow.ir.json failed copy verification.");
  if (stableJsonLine(JSON.parse(irBytes.toString("utf8"))) !== stableJsonLine(JSON.parse(workflowIrJson))) throw new Error("Fork workflow.ir.json does not match frozen runtime state.");
  const lockBytes = await readContainedFile(runDir, "lock.json");
  if (!lockBytes.equals(Buffer.from(lockJson))) throw new Error("Fork lock.json failed copy verification.");
}

async function readContainedFile(root: string, relativePath: string): Promise<Buffer> {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, relativePath);
  if (!isContainedPath(rootPath, absolutePath)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) throw new PathEscapeError(`Path '${relativePath}' is a symbolic link.`);
  if (!info.isFile()) throw new PathEscapeError(`Path '${relativePath}' is not a file.`);
  const real = await realpath(absolutePath);
  const realRoot = await realpath(rootPath);
  if (!isContainedPath(realRoot, real)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  return readFile(absolutePath);
}

function frozenWorkflowIrJson(
  runDir: string,
  row: Pick<RunInputRow, "workflow_ir_path" | "workflow_ir_digest">,
): string {
  return readFrozenRunFile(runDir, row.workflow_ir_path, row.workflow_ir_digest, "workflow IR");
}

function frozenLockJson(
  runDir: string,
  row: Pick<RunInputRow, "lock_path" | "lock_digest">,
): string {
  return readFrozenRunFile(runDir, row.lock_path, row.lock_digest, "workflow lock");
}

function decodeFrozenRun(
  row: FrozenWorkflowRow,
  runDir: string,
  cwd: string,
  resolveSourceRoot?: (source: WorkflowSourceRef) => string,
): FrozenRun {
  const workflowIrJson = frozenWorkflowIrJson(runDir, row);
  const { source } = verifiedFrozenWorkflowSource(runDir, row);
  const agentOverrides = parseAgentOverrides(row.agent_overrides_json);
  return {
    ir: withAgentOverrides(JSON.parse(workflowIrJson) as WorkflowIR, agentOverrides),
    input: JSON.parse(row.input_json) as JsonValue,
    agentOverrides,
    ...(resolveSourceRoot === undefined ? {} : { sourceRoot: resolveSourceRoot(source) }),
    meta: {
      runId: row.id,
      workflowPath: row.workflow_entry,
      workflowName: row.name,
      workspaceDir: resolve(cwd),
    },
  };
}

function verifiedFrozenWorkflowSource(
  runDir: string,
  row: FrozenSourceRow,
): { source: WorkflowSourceRef; lockJson: string } {
  const source = parseWorkflowSource(row.source_json);
  if (source.entry !== row.workflow_entry) {
    throw new Error("Frozen workflow source entry does not match persisted run metadata.");
  }
  if (source.kind === "snapshot" && source.digest !== row.source_graph_digest) {
    throw new Error("Frozen workflow source graph digest does not match persisted run metadata.");
  }
  const lockJson = frozenLockJson(runDir, row);
  const lock = parseFrozenWorkflowLock(lockJson);
  if (stableJsonLine(lock.workflow.source) !== stableJsonLine(source)) {
    throw new Error("Frozen workflow source does not match its preparation lock.");
  }
  if (lock.sourceGraphDigest !== row.source_graph_digest) {
    throw new Error("Frozen workflow source graph digest does not match its preparation lock.");
  }
  if (lock.ir.path !== row.workflow_ir_path || lock.ir.digest !== row.workflow_ir_digest) {
    throw new Error("Frozen workflow IR metadata does not match its preparation lock.");
  }
  return { source, lockJson };
}

function parseFrozenWorkflowLock(json: string): RunWorkflowLockArtifact {
  const value = JSON.parse(json) as unknown;
  if (!isRunWorkflowLockArtifact(value)) {
    throw new Error("Frozen workflow preparation lock is invalid.");
  }
  return value;
}

function readFrozenRunFile(runDir: string, path: string, expectedDigest: string, label: string): string {
  const bytes = readContainedFileSync(runDir, path);
  if (sha256Digest(bytes) !== expectedDigest) throw new Error(`Frozen ${label} digest mismatch.`);
  return bytes.toString("utf8");
}

function verifyRegisteredArtifact(
  run: RunDirectoryFence,
  artifactPath: string,
  expected: Pick<RegisterArtifactInput, "id" | "digest" | "size" | "file">,
): void {
  if (!Number.isSafeInteger(expected.size)
    || expected.size < 0
    || !/^sha256:[a-f0-9]{64}$/.test(expected.digest)) {
    throw new Error(`Artifact '${expected.id}' has invalid size or digest metadata.`);
  }
  const label = `Artifact '${expected.id}'`;
  const path = verifyRunFile(run.token(), expected.file, label);
  if (path !== artifactPath) {
    throw new Error(`${label} identity does not match its declared relative path.`);
  }
  const info = lstatSync(path, { bigint: true });
  assertRunFileIdentity(expected.file, info, label);
  if (info.size !== BigInt(expected.size)) {
    throw new Error(`Artifact '${expected.id}' does not match its declared size.`);
  }
  verifyRunFile(run.token(), expected.file, label);
  run.verify();
}

function resolveForkCheckpoint(
  db: DatabaseSync,
  projection: SchedulerProjection,
  runId: string,
  target: string | undefined,
): Result<{ nodeKey?: string; replayBeforeSequence: number }, ForkReplayFailure> {
  if (target === undefined) {
    const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as CountRow;
    return ok({ replayBeforeSequence: Number(row.count) });
  }
  let nodeKey: string | undefined;
  if (projection.instances[target]) {
    nodeKey = target;
  } else if (target.startsWith("@")) {
    const occurrence = resolveOccurrenceRef(projection, target, { attempt: "reject" });
    if (occurrence && !occurrence.ok) {
      if (occurrence.error.type === "occurrence-ref-collision") {
        return err({ type: "dynamic-target-ambiguity", target, message: `Fork target '${target}' is ambiguous.` });
      }
      if (occurrence.error.type === "occurrence-ref-attempt-not-allowed") {
        const occurrenceTarget = target.slice(0, target.lastIndexOf("#"));
        return err({
          type: "target-resolution-failure",
          target,
          message: `Fork target '${target}' selects attempt ${occurrence.error.attemptNo}; use occurrence target '${occurrenceTarget}' without the attempt suffix.`,
        });
      }
    }
    if (occurrence?.ok && occurrence.value.kind === "node") nodeKey = occurrence.value.nodeKey;
  } else {
    const matches = Object.values(projection.instances)
      .filter(instance => instance.nodeId === target)
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
    if (matches.length > 1) {
      return err({ type: "dynamic-target-ambiguity", target, message: `Fork target '${target}' matches multiple source occurrences.` });
    }
    nodeKey = matches[0]?.nodeKey;
  }
  if (!nodeKey) {
    return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' is not a materialized source leaf.` });
  }
  const ready = db.prepare(`
    SELECT sequence
    FROM run_events
    WHERE run_id = ? AND node_key = ? AND type = 'instance.ready'
    ORDER BY sequence
    LIMIT 1
  `).get(runId, nodeKey) as { sequence: number } | undefined;
  if (!ready) {
    return err({ type: "target-resolution-failure", target, message: `Fork target '${target}' has no durable ready checkpoint.` });
  }
  return ok({ nodeKey, replayBeforeSequence: Number(ready.sequence) });
}

function completedReplayFacts(
  db: DatabaseSync,
  runId: string,
  projection: SchedulerProjection,
  replayBeforeSequence: number,
): ForkReplayFact[] {
  const rows = db.prepare(`
    SELECT node_key, sequence, type, payload_json
    FROM run_events
    WHERE run_id = ?
      AND type IN (
        'instance.ready', 'instance.started', 'instance.awaiting', 'instance.requeued',
        'instance.retry_requested', 'instance.completed', 'instance.failed', 'instance.cancelled'
      )
      AND sequence < ?
    ORDER BY sequence, node_key
  `).all(runId, replayBeforeSequence) as Array<{ node_key: string; sequence: number; type: string; payload_json: string }>;
  const latestByNode = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latestByNode.set(row.node_key, row);
  const facts: ForkReplayFact[] = [];
  for (const row of latestByNode.values()) {
    if (row.type !== "instance.completed") continue;
    if (!acceptedForkCompletion(projection, row.node_key)) continue;
    const payload = decodeSchedulerPayload(row.payload_json, "instance.completed");
    const identity = payload.replayIdentity;
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) continue;
    const operationDigest = (identity as Record<string, unknown>).operationDigest;
    const inputDigest = (identity as Record<string, unknown>).inputDigest;
    const sessionGroupDigest = (identity as Record<string, unknown>).sessionGroupDigest;
    if (typeof operationDigest !== "string" || typeof inputDigest !== "string") continue;
    if (sessionGroupDigest !== undefined && typeof sessionGroupDigest !== "string") continue;
    facts.push({
      nodeKey: row.node_key,
      sourceSequence: Number(row.sequence),
      operationDigest,
      inputDigest,
      ...(sessionGroupDigest === undefined ? {} : { sessionGroupDigest }),
      ...(Object.prototype.hasOwnProperty.call(payload, "output") ? { output: payload.output as JsonValue } : {}),
      artifacts: [],
    });
  }
  return facts;
}

function acceptedForkCompletion(projection: SchedulerProjection, nodeKey: string): boolean {
  for (const member of ancestorGroupMembersForNode(projection, nodeKey)) {
    const group = projection.groups[member.groupKey];
    if (!group || group.strategy === "all") continue;
    const result = group.result;
    const accepted = result && typeof result === "object" && !Array.isArray(result)
      ? result.acceptedMemberKeys
      : undefined;
    if (group.status !== "completed"
      || !Array.isArray(accepted)
      || !accepted.includes(member.memberKey)) return false;
  }
  return true;
}

function forkRequestFingerprint(runId: string, options: ControlOptions): string {
  return stableJsonLine({
    runId,
    ...(options.prepared === undefined ? {} : {
      prepared: {
        source: options.prepared.source,
        irFileDigest: options.prepared.lock.ir.digest,
        sourceGraphDigest: options.prepared.sourceGraphDigest,
      },
    }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.agentOverrides === undefined ? {} : { agentOverrides: options.agentOverrides }),
    ...(options.target === undefined ? {} : { target: options.target }),
  });
}

function assertSameDirectory(
  before: DirectoryIdentity,
  after: DirectoryIdentity,
  message: string,
): void {
  if (before.filesystemIdentity !== after.filesystemIdentity) {
    throw new Error(message);
  }
}

async function removeOwnedDirectory(
  root: DirectoryFence,
  owned: DirectoryIdentity,
): Promise<void> {
  root.verify();
  verifyDirectoryIdentity(owned, `Owned directory '${owned.path}'`);
  await rm(owned.path, { recursive: true, force: true });
  root.verify();
}

async function removeOwnedDirectoryAfterFailure(
  root: DirectoryFence,
  owned: DirectoryIdentity,
  failure: unknown,
): Promise<never> {
  try {
    await removeOwnedDirectory(root, owned);
  } catch (cleanupError) {
    if (isMissingPathError(cleanupError)) throw failure;
    throw new AggregateError([failure, cleanupError], `Operation failed and owned path '${owned.path}' could not be removed.`);
  }
  throw failure;
}

async function removeOwnedDirectoriesAfterFailure(
  root: DirectoryFence,
  owned: readonly DirectoryIdentity[],
  failure: unknown,
): Promise<never> {
  const failures = [failure];
  for (const directory of owned) {
    try {
      await removeOwnedDirectory(root, directory);
    } catch (cleanupError) {
      if (!isMissingPathError(cleanupError)) failures.push(cleanupError);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Operation failed and its owned directories could not all be removed.");
  }
  throw failure;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isNodeError(error) && error.code === code;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeWorkflowForEvent(ir: WorkflowIR): {
  name: string;
  description?: string;
  irVersion: number;
  nodeCount: number;
  outputShape: StaticExprShape;
  diagnostics: { total: number; errors: number; warnings: number; infos: number };
} {
  return {
    name: ir.name,
    ...(ir.description === undefined ? {} : { description: ir.description }),
    irVersion: ir.irVersion,
    nodeCount: countNodes(ir.root),
    outputShape: staticExprShape(ir.root.output),
    diagnostics: {
      total: ir.diagnostics.length,
      errors: ir.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
      warnings: ir.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
      infos: ir.diagnostics.filter(diagnostic => diagnostic.severity === "info").length,
    },
  };
}

function countNodes(scope: ScopeIR): number {
  return Array.from(walkNodes(scope)).length;
}

function newRunId(): string {
  return `${localTimestampId(new Date())}${randomBytes(10).toString("hex").toUpperCase()}`;
}

function localTimestampId(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
