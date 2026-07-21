import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { walkNodes, type AgentDefinitionIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { isJsonValue, staticExprShape, type ExprIR, type JsonValue, type StaticExprShape } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { rewriteArtifactValue, type ArtifactRewriteFailure } from "../artifacts/rewrite.js";
import { compactUndefined, parseAgentOverrideMap, tryParseAgentOverrideMap, type AgentOverrideParseFailure } from "../control/agent-overrides.js";
import { tryCreateDeadline, tryParsePersistedDeadline } from "../deadline.js";
import { evaluateExpr } from "../evaluation/evaluator.js";
import { normalizeWorkflowData } from "../evaluation/admissible.js";
import type { HookJournalEntry } from "../hooks/journal.js";
import { probeProcessLiveness } from "../process-liveness.js";
import { stableJson } from "../stable-json.js";
import { selectNextAdmission } from "../scheduler/admission.js";
import { applySchedulerEvents, cancellationEventsForFrame, cancellationEventsForNode, createSchedulerProjection, signalTimeoutEvents, targetedRetryDependencyBlocker, targetedRetryGroupBlocker, type SchedulerProjectionTimings } from "../scheduler/transitions.js";
import { ancestorGroupMembersForFrame, ancestorGroupMembersForNode } from "../scheduler/membership.js";
import { planTargetedForkSeed, type ForkSeedFailure, type ForkSeedPlan } from "../scheduler/fork-seed.js";
import type { SchedulerEvent } from "../scheduler/events.js";
import { SchedulerStoreException, schedulerStoreResult, throwSchedulerStoreResult, type RunOwnerClaim, type SchedulerCancelInput, type SchedulerCommit, type SchedulerSnapshot, type SchedulerStorePort, type AttemptStartInput, type AttemptStartResult, type AttemptCommitInput, type SignalConsumeInput, type SchedulerPauseInput, type SchedulerResumeInput, type SchedulerRetryInput, type SchedulerRunRetryInput, type SchedulerRecoveryInput, type SchedulerStoreError, type SchedulerStoreResult } from "../scheduler/store-port.js";
import type { GroupMember, GroupMemberIdentity, GroupProjection, InstancePath, SchedulerFrame, SchedulerProjection } from "../scheduler/types.js";
import { nextFrozenRunTransitionEvents, settleFrozenProjection } from "../scheduler/settle.js";
import { decodeSchedulerPayload, isSchedulerEventType } from "../scheduler/event-codec.js";
import { decodeCommittedRuntimeEventRow, type CommittedRuntimeEventRow } from "../hooks/events.js";
import { tryNormalizeWorkflowInput, type SchemaNormalizationFailure } from "../admission/input.js";

export type RunStatus = "pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled";

export type PreparedRunValidationFailure = {
  type: "prepared-workflow-invalid";
  reason: "invalid-ir-json" | "ir-mismatch" | "ir-digest-mismatch" | "source-graph-mismatch" | "package-lock-mismatch" | "entry-mismatch";
  message: string;
};

export type AgentOverrideValidationFailure = AgentOverrideParseFailure;

export type AdmitRunFailure = PreparedRunValidationFailure
  | SchemaNormalizationFailure
  | AgentOverrideValidationFailure;

export type ForkRunFailure = PreparedRunValidationFailure
  | AgentOverrideValidationFailure
  | SchemaNormalizationFailure
  | ForkSeedFailure
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "fork-request-conflict"; requestId: string; message: string };

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

const localStateRoot = ".acpus/.local";
const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

export type RuntimeStore = {
  scheduler: SchedulerStorePort;
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
  readRunInspection(runId: string, afterEventSequence?: number): RunInspectionStoreRead;
  getRunDir(runId: string): string | undefined;
  registerArtifact(input: RegisterArtifactInput): SchedulerStoreResult<void>;
  getArtifact(runId: string, artifactId: string): ArtifactRecord | undefined;
  listArtifacts(runId: string): ArtifactRecord[];
  writeExecutionMetadata(input: WriteExecutionMetadataInput): void;
  getExecutionMetadata(runId: string): RunExecutionMetadata[];
  writeNodeProgress(input: WriteNodeProgressInput): void;
  getRun(runId: string): RunDetails | undefined;
  listRuns(): RunRecord[];
  getRuntimeDiagnostics(): RuntimeDiagnostics;
};

export type RunInspectionStoreRead = {
  run?: RunDetails;
  frozen?: FrozenRun;
  artifacts: ArtifactRecord[];
  cursor: {
    eventSequence: number;
    progressVersion: number;
  };
  events: CommittedRuntimeEventRow[];
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

export type AgentOverrideMap = Record<string, AgentOverrideSpec>;

type AgentOverrideSpec = {
  use?: string;
  command?: string;
  model?: string;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  agentMode?: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type RunWorkflowLockArtifact = {
  kind: "acpus_workflow_preparation_lock";
  version: 1;
  workflow: {
    entry: string;
    sourceDigest: string;
  };
  ir: {
    path: "workflow.ir.json";
    digest: string;
  };
  packageLockDigest?: string;
  sourceGraphDigest: string;
};

export type PreparedRunWorkflow = {
  workflowPath: string;
  ir: WorkflowIR;
  irJson: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: RunWorkflowLockArtifact;
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
  unsafeReuse?: true;
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

export type RunDynamicDetails = {
  version: number;
  progressVersion: number;
  progressUpdatedAt?: string;
  frames: RunDynamicFrame[];
  nodeInstances: RunDynamicNodeInstance[];
  attempts: RunDynamicAttempt[];
  groups: RunDynamicGroup[];
  groupMembers: RunDynamicGroupMember[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
  progress: RunNodeProgress[];
};

type RunDynamicGroupBase = {
  groupKey: string;
  nodeKey: string;
  nodeId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  maxConcurrency?: number;
};

export type RunDynamicGroup =
  | (RunDynamicGroupBase & { kind: "parallel"; strategy: "all" | "race"; quorumCount?: never })
  | (RunDynamicGroupBase & { kind: "fanout"; strategy: "all"; quorumCount?: never })
  | (RunDynamicGroupBase & { kind: "fanout"; strategy: "quorum"; quorumCount: number });

export type RunExecutionMetadata = {
  id: number;
  attemptId?: string;
  kind: string;
  metadata: unknown;
  createdAt: string;
};

export type RunNodeProgress = {
  nodeKey: string;
  nodeId: string;
  attemptId?: string;
  attemptNo?: number;
  kind: string;
  status: string;
  message?: string;
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  context?: unknown;
  tokenUsage?: unknown;
  tools?: unknown;
  updatedAt: string;
};

export type RunDynamicFrame = {
  frameKey: string;
  parentFrameKey?: string;
  nodeKey?: string;
  nodeId?: string;
  instancePath?: InstancePath;
  frameKind: string;
  status: string;
  scope?: Record<string, string>;
  strategy?: string;
  loop?: SchedulerFrame["loop"];
  terminalReason?: string;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicNodeInstance = {
  nodeKey: string;
  nodeId: string;
  parentFrameKey?: string;
  instancePath?: InstancePath;
  status: string;
  /** Current status reason only; historical control reasons are kept in run events/attempt metadata. */
  statusReason?: string;
  output?: unknown;
  error?: unknown;
  acceptedAttemptId?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicAttempt = {
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  status: string;
  deadlineAt?: string;
  result?: unknown;
  error?: unknown;
  terminalReason?: string;
  cancelReason?: string;
  startedAt: string;
  finishedAt?: string;
};

type RunDynamicGroupMemberBase = {
  groupKey: string;
  memberKey: string;
  childFrameKey?: string;
  status: string;
  completionSequence?: number;
  acceptedRank?: number;
  terminalReason?: string;
  output?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicGroupMember = RunDynamicGroupMemberBase & GroupMemberIdentity;

export type RunDynamicSignalWait = {
  nodeKey: string;
  nodeId: string;
  status: string;
  payload?: JsonValue;
  deadlineAt?: string;
  timeoutMessage?: string;
  timeoutRemainingMs?: number;
  renderedPrompt?: string;
  terminalReason?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type FrozenRun = {
  ir: WorkflowIR;
  input: JsonValue;
  agentOverrides: AgentOverrideMap;
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
  unsafeReuse?: boolean;
};

export type RegisterArtifactInput = {
  id: string;
  runId: string;
  nodeKey: string;
  attemptId: string;
  attempt: number;
  ownerEpoch: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
};


export type ArtifactRecord = {
  id: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  path: string;
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
  run_dir: string;
};

type FrozenWorkflowRow = Pick<RunInputRow, "workflow_ir_path" | "workflow_ir_digest" | "input_json" | "agent_overrides_json" | "run_dir">;
type RunDetailsInputRow = Pick<RunInputRow, "input_json" | "agent_overrides_json" | "output_json">;

type RunDirRow = {
  run_dir: string;
};

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

type HookJournalRow = {
  id: number;
  run_id: string;
  event_sequence: number;
  trigger_order: number;
  event: HookJournalEntry["event"];
  source: HookJournalEntry["source"];
  source_path: string;
  handler_id: string;
  definition_hash: string;
  node_key: string | null;
  status: HookJournalEntry["status"];
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  error: string | null;
  triggered_at: string;
};

export async function openRuntimeStore(cwd: string): Promise<RuntimeStore> {
  const stateDir = join(cwd, localStateRoot, "state");
  await mkdir(stateDir, { recursive: true });
  const db = openDatabase(join(stateDir, "runtime.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  initializeSchema(db);
  return new SqliteRuntimeStore(db, cwd);
}

export async function openExistingRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, true);
}

export async function openExistingWritableRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, false);
}

async function openExistingStore(cwd: string, readOnly: boolean): Promise<RuntimeStore | undefined> {
  const path = join(cwd, localStateRoot, "state", "runtime.db");
  try {
    await access(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (readOnly) {
    const db = openDatabase(path, true);
    return new SqliteRuntimeStore(db, cwd);
  }
  const db = openDatabase(path);
  initializeSchema(db);
  return new SqliteRuntimeStore(db, cwd);
}

class SqliteRuntimeStore implements RuntimeStore {
  private schedulerPort?: SqliteSchedulerStorePort;

  constructor(private readonly db: DatabaseSync, private readonly cwd: string) {}

  get scheduler(): SchedulerStorePort {
    return this.schedulerStore();
  }

  private schedulerStore(): SqliteSchedulerStorePort {
    this.schedulerPort ??= new SqliteSchedulerStorePort(this.db, this.cwd);
    return this.schedulerPort;
  }

  private runRecordColumns(): string {
    return "id, name, status, workflow_entry, source_graph_digest, created_at, updated_at, progress_version, progress_updated_at";
  }

  close(): void {
    this.db.close();
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
    const runId = newRunId();
    const now = new Date().toISOString();
    const workflowEntry = relative(this.cwd, prepared.value.workflowPath);
    const runDir = join(this.cwd, localStateRoot, "runs", runId);
    const stagedRunDir = join(this.cwd, localStateRoot, "runs", `.staging-${runId}`);
    const lockJson = stableJsonLine(prepared.value.lock);
    const eventPayload = {
      workflow: summarizeWorkflowForEvent(prepared.value.ir),
      input: normalizedInput.value,
      ...(Object.keys(agentOverrides.value).length > 0 ? { agentOverrides: agentOverrides.value } : {}),
    };
    await publishRunDirectory({
      cwd: this.cwd,
      stagedRunDir,
      runDir,
      populate: async stagingDir => {
        await writeFrozenRunFiles(stagingDir, prepared.value.irJson, lockJson);
      },
    });
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.db.prepare(`
        INSERT INTO runs (id, name, status, workflow_entry, source_graph_digest, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?)
      `).run(runId, prepared.value.ir.name, workflowEntry, prepared.value.sourceGraphDigest, now, now);
      this.db.prepare(`
        INSERT INTO run_inputs (
          run_id, workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, lock_path, lock_digest, package_lock_digest, run_dir
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        "workflow.ir.json",
        digest(Buffer.from(prepared.value.irJson)),
        stableJsonLine(normalizedInput.value),
        stableJsonLine(agentOverrides.value),
        "lock.json",
        digest(Buffer.from(lockJson)),
        prepared.value.packageLockDigest ?? null,
        relative(this.cwd, runDir),
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
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      await removeOwnedPathAfterFailure(runDir, rollbackAfterFailure(this.db, transactionStarted, error));
    }

    const record = this.getRunRecord(runId);
    if (!record) throw new Error(`Admitted run ${runId} was not persisted.`);
    return ok(record);
  }

  getFrozenRun(runId: string): FrozenRun | undefined {
    const row = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, run_inputs.workflow_ir_path, run_inputs.workflow_ir_digest, run_inputs.input_json, run_inputs.agent_overrides_json, run_inputs.run_dir
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
      WHERE run_inputs.run_id = ?
    `).get(runId) as (FrozenWorkflowRow & { id: string; name: string; workflow_entry: string }) | undefined;
    if (!row) {
      if (this.getRunRecord(runId)) throw new Error(`Run '${runId}' has no frozen input.`);
      return undefined;
    }
    const workflowIrJson = frozenWorkflowIrJson(this.cwd, row);
    const originalIr = JSON.parse(workflowIrJson) as WorkflowIR;
    const agentOverrides = parseAgentOverrides(row.agent_overrides_json);
    return {
      ir: withAgentOverrides(originalIr, agentOverrides),
      input: JSON.parse(row.input_json) as JsonValue,
      agentOverrides,
      meta: {
        runId: String(row.id),
        workflowPath: String(row.workflow_entry),
        workflowName: String(row.name),
        workspaceDir: resolve(this.cwd),
      },
    };
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
    for (const wait of timedWaits) persistedDeadline(wait.deadline_at, `Signal wait '${wait.run_id}:${wait.node_key}'`);
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
    const source = this.getRunRecord(runId);
    if (!source) return err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const input = this.db.prepare(`
      SELECT workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, lock_path, lock_digest, output_json, package_lock_digest, run_dir
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input) throw new Error(`Run '${runId}' has no frozen input.`);
    const sourceWorkflowIrJson = frozenWorkflowIrJson(this.cwd, input);
    const sourceLockJson = frozenLockJson(this.cwd, input);
    const forkIrJson = options.prepared?.irJson ?? sourceWorkflowIrJson;
    const forkIr = options.prepared?.ir ?? JSON.parse(forkIrJson) as WorkflowIR;
    if (options.agentOverrides !== undefined) {
      const agentOverrides = tryParseAgentOverrideMap(options.agentOverrides, forkIr.agents);
      if (agentOverrides.isErr()) return err(agentOverrides.error);
      options = { ...options, agentOverrides: agentOverrides.value };
    }
    const sourceAgentOverrides = parseAgentOverrides(input.agent_overrides_json);
    const forkAgentOverrides = normalizeAgentOverrides(forkIr, options.agentOverrides, sourceAgentOverrides);
    const sourceIr = JSON.parse(sourceWorkflowIrJson) as WorkflowIR;
    const sourceEffectiveIr = withAgentOverrides(sourceIr, sourceAgentOverrides);
    const forkEffectiveIr = withAgentOverrides(forkIr, forkAgentOverrides);
    let forkInput = options.input;
    if (forkInput !== undefined || options.prepared) {
      const normalized = tryNormalizeWorkflowInput(forkIr, forkInput ?? JSON.parse(input.input_json) as JsonValue, "Fork input");
      if (normalized.isErr()) return err(normalized.error);
      forkInput = normalized.value;
    }
    const forkInputJson = forkInput === undefined ? input.input_json : stableJsonLine(forkInput);
    const forkLockJson = options.prepared ? stableJsonLine(options.prepared.lock) : sourceLockJson;
    const forkPackageLockDigest = options.prepared?.packageLockDigest ?? input.package_lock_digest ?? null;
    const forkName = options.prepared ? forkIr.name : source.name;
    const forkWorkflowEntry = options.prepared ? relative(this.cwd, options.prepared.workflowPath) : source.workflowEntry;
    const forkSourceGraphDigest = options.prepared?.sourceGraphDigest ?? source.sourceGraphDigest;
    const forkId = newRunId();
    const now = new Date().toISOString();
    const replacement = Boolean(options.prepared || options.input !== undefined || options.target !== undefined || options.agentOverrides !== undefined || options.unsafeReuse === true);
    const targetedReplacement = replacement;
    const forkStatus = source.status === "completed" && !replacement ? "completed" : "pending";
    const sourceRunDir = containedRunDir(this.cwd, input.run_dir);
    const forkRunDir = join(localStateRoot, "runs", forkId);
    const forkRunPath = join(this.cwd, forkRunDir);
    const stagedForkRunPath = join(this.cwd, localStateRoot, "runs", `.staging-${forkId}`);
    const completedOutputRows = completedSchedulerOutputRows(this.db, runId);
    const completedNodeKeys = new Set([
      ...this.db.prepare(`
      SELECT node_key
      FROM node_states
      WHERE run_id = ? AND status = 'completed'
    `).all(runId).map(row => String(row.node_key)),
      ...completedOutputRows.map(row => row.nodeKey),
    ]);
    const sourceNodeSignatures = nodeSignatures(sourceEffectiveIr.root);
    const forkNodeSignatures = nodeSignatures(forkEffectiveIr.root);
    const irNodeKeys = new Set(forkNodeSignatures.keys());
    const knownCompletedNodeKeys = new Set([...completedNodeKeys].filter(nodeKey => {
      if (forkNodeSignatures.has(nodeKey)) return forkNodeSignatures.get(nodeKey) === sourceNodeSignatures.get(nodeKey);
      return !replacement && source.status === "completed";
    }));
    let seedPlan: ForkSeedPlan | undefined;
    if (targetedReplacement) {
      const planned = planTargetedForkSeed({
          forkRunId: forkId,
          sourceWorkflow: sourceEffectiveIr,
          replacementWorkflow: forkEffectiveIr,
          replacementScope: {
            input: JSON.parse(forkInputJson) as JsonValue,
            nodes: {},
            meta: {
              runId: forkId,
              workflowPath: forkWorkflowEntry,
              workflowName: forkName,
              workspaceDir: resolve(this.cwd),
            },
            fanout: {},
            loop: {},
          },
          sourceProjection: throwSchedulerStoreResult(this.scheduler.tryLoadRunSnapshot(runId)).projection,
          inputChanged: options.input !== undefined,
          unsafeReuse: options.unsafeReuse === true,
          ...(options.target === undefined ? {} : { target: options.target }),
        });
      if (planned.isErr()) return err(planned.error);
      seedPlan = planned.value;
    }
    const inheritableNodeKeys = seedPlan?.inheritedNodeKeys ?? (options.input !== undefined ? new Set<string>() : source.status === "completed"
      ? knownCompletedNodeKeys
      : inheritableCompletedNodeKeys(forkIr, knownCompletedNodeKeys));
    const nodeRows = this.db.prepare("SELECT node_key, node_id, status, output_json FROM node_states WHERE run_id = ?").all(runId) as Array<Record<string, unknown>>;
    const reachableArtifactIds = reachableInheritedArtifactIds({
      runId,
      outputJson: input.output_json,
      nodeRows,
      inheritableNodeKeys,
    });
    if (seedPlan) {
      for (const event of seedPlan.events) collectArtifactIds(event.payload as JsonValue, runId, reachableArtifactIds);
    }
    const artifacts = this.db.prepare(`
      SELECT id, node_key, attempt, media_type, digest, size, relative_path
      FROM artifacts
      WHERE run_id = ?
    `).all(runId).filter(artifact => reachableArtifactIds.has(String(artifact.id)) && inheritableNodeKeys.has(String(artifact.node_key))) as ArtifactRow[];
    const artifactIdMap = Object.fromEntries(artifacts.map(artifact => [
      String(artifact.id),
      `artifact_${randomUUID()}`,
    ]));
    let forkOutputJson: string | null = null;
    if (source.status === "completed" && !replacement && input.output_json) {
      const rewrittenOutput = forkCompletedOutputJson({
          output: forkIr.root.output,
          completedOutputRows,
          inheritableNodeKeys,
          inputJson: forkInputJson,
          meta: {
            runId: forkId,
            workflowPath: forkWorkflowEntry,
            workflowName: forkName,
            workspaceDir: resolve(this.cwd),
          },
          sourceRunId: runId,
          forkRunId: forkId,
          artifactIdMap,
        });
      if (rewrittenOutput.isErr()) return err(rewrittenOutput.error);
      forkOutputJson = rewrittenOutput.value;
    }
    const rewrittenNodeRows: Array<Record<string, unknown>> = [];
    for (const row of nodeRows) {
      if (!inheritableNodeKeys.has(String(row.node_key)) || !row.output_json) {
        rewrittenNodeRows.push(row);
        continue;
      }
      const output = rewriteArtifactRefs(String(row.output_json), runId, forkId, artifactIdMap);
      if (output.isErr()) return err(output.error);
      rewrittenNodeRows.push({ ...row, output_json: output.value });
    }
    let rewrittenSeedPlan = seedPlan;
    if (seedPlan) {
      const rewritten = rewriteForkSeedPlan(seedPlan, runId, forkId, artifactIdMap);
      if (rewritten.isErr()) return err(rewritten.error);
      rewrittenSeedPlan = rewritten.value;
    }
    await publishRunDirectory({
      cwd: this.cwd,
      stagedRunDir: stagedForkRunPath,
      runDir: forkRunPath,
      populate: async stagingDir => {
        await writeFrozenRunFiles(stagingDir, forkIrJson, forkLockJson);
        await verifyFrozenRunFiles(stagingDir, forkLockJson, forkIrJson);
        await copyVerifiedArtifacts(sourceRunDir, stagingDir, artifacts);
      },
    });
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.db.prepare(`
        INSERT INTO runs (id, name, status, workflow_entry, source_graph_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(forkId, forkName, forkStatus, forkWorkflowEntry, forkSourceGraphDigest, now, now);
      this.db.prepare(`
        INSERT INTO run_inputs (
          run_id, workflow_ir_path, workflow_ir_digest, input_json, agent_overrides_json, output_json, lock_path, lock_digest, package_lock_digest, run_dir
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        forkId,
        "workflow.ir.json",
        digest(Buffer.from(forkIrJson)),
        forkInputJson,
        stableJsonLine(forkAgentOverrides),
        forkOutputJson,
        "lock.json",
        digest(Buffer.from(forkLockJson)),
        forkPackageLockDigest,
        forkRunDir,
      );
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, 1, 'run.forked', NULL, ?, ?, ?)
      `).run(forkId, stableJsonLine({ sourceRunId: runId, requestFingerprint, ...(options.target === undefined ? {} : { target: options.target }), ...(options.unsafeReuse === true ? { unsafeReuse: true } : {}), ...(Object.keys(forkAgentOverrides).length > 0 ? { agentOverrides: forkAgentOverrides } : {}) }), now, forkRequestKey ?? `fork:${forkId}:${runId}`);
      if (forkStatus === "completed" && forkOutputJson) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, 2, 'run.completed', NULL, ?, ?, ?)
        `).run(forkId, stableJsonLine({ output: JSON.parse(forkOutputJson) as JsonValue }), now, `complete:${forkId}`);
      }
      if (forkStatus !== "completed") {
        this.db.prepare(`
          INSERT INTO scheduler_projection_checkpoints (run_id, event_sequence, projection_json, updated_at)
          VALUES (?, 1, ?, ?)
        `).run(forkId, stableJsonLine(createSchedulerProjection(forkId) as unknown as JsonValue), now);
      }
      this.db.prepare("INSERT INTO hook_dispatch_cursors (run_id, event_sequence) VALUES (?, 0)").run(forkId);
      if (targetedReplacement && rewrittenSeedPlan) {
        this.schedulerStore().insertForkSeedEventsInTransaction({
          runId: forkId,
          plan: rewrittenSeedPlan,
          now,
        });
      } else {
        const insertedNodeKeys = new Set<string>();
        for (const row of rewrittenNodeRows) {
          const nodeKey = String(row.node_key);
          if (!irNodeKeys.has(nodeKey) && !inheritableNodeKeys.has(nodeKey)) continue;
          insertedNodeKeys.add(nodeKey);
          this.db.prepare(`
            INSERT INTO node_states (run_id, node_key, node_id, status, output_json)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            forkId,
            nodeKey,
            String(row.node_id),
            inheritableNodeKeys.has(nodeKey) ? "completed" : "pending",
            inheritableNodeKeys.has(nodeKey) && row.output_json ? String(row.output_json) : null,
          );
        }
        for (const nodeKey of irNodeKeys) {
          if (insertedNodeKeys.has(nodeKey)) continue;
          this.db.prepare(`
            INSERT INTO node_states (run_id, node_key, node_id, status)
            VALUES (?, ?, ?, 'pending')
          `).run(forkId, nodeKey, nodeKey);
        }
      }
      for (const artifact of artifacts) {
        this.db.prepare(`
          INSERT INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          requireArtifactId(artifactIdMap, String(artifact.id)),
          forkId,
          artifact.node_key === null ? null : String(artifact.node_key),
          Number(artifact.attempt ?? 0),
          artifact.media_type === null ? null : String(artifact.media_type),
          String(artifact.digest),
          Number(artifact.size),
          String(artifact.relative_path),
          now,
        );
      }
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      await removeOwnedPathAfterFailure(forkRunPath, rollbackAfterFailure(this.db, transactionStarted, error));
    }
    return ok({ ...this.requireRun(forkId), forkCreated: true });
  }

  async cleanupStagedRunDirectories(): Promise<void> {
    let runsDir: string;
    try {
      runsDir = containedRunsRoot(this.cwd);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.startsWith(".staging-")) continue;
      const absolutePath = join(runsDir, entry);
      if (!(await isStalePath(absolutePath, 60_000))) continue;
      await rm(absolutePath, { recursive: true, force: true });
    }
  }

  deleteRun(runId: string): ResultAsync<RunRecord | undefined, RunDeleteFailure> {
    return new ResultAsync(this.deleteRunResult(runId));
  }

  private async deleteRunResult(runId: string): Promise<Result<RunRecord | undefined, RunDeleteFailure>> {
    let transactionStarted = false;
    let run: RunRecord;
    let absoluteRunDir: string;
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
      const runDir = this.getRunDir(runId);
      if (!runDir) throw new Error(`Run '${runId}' has no frozen input.`);
      absoluteRunDir = containedRunDir(this.cwd, runDir);
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      this.db.exec("COMMIT");
      transactionStarted = false;
      run = existing;
    } catch (error) {
      throw rollbackAfterFailure(this.db, transactionStarted, error);
    }
    await rm(absoluteRunDir, { recursive: true, force: true });
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
    const rows = this.db.prepare(`
      SELECT id, run_id, event_sequence, trigger_order, event, source, source_path, handler_id, definition_hash,
        node_key, status, exit_code, stdout, stderr, duration_ms, error, triggered_at
      FROM hook_journal
      WHERE run_id = ?
      ORDER BY event_sequence ASC, trigger_order ASC, id ASC
    `).all(runId) as HookJournalRow[];
    return rows.map(hookJournalEntryFromRow);
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
      throw rollbackAfterFailure(this.db, transactionStarted, error);
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

  readRunInspection(runId: string, afterEventSequence?: number): RunInspectionStoreRead {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN");
      transactionStarted = true;
      const run = this.getRun(runId);
      const frozen = run ? this.getFrozenRun(runId) : undefined;
      const eventSequence = run ? this.getLastRunEventSequence(runId) : 0;
      const artifacts = run ? this.listArtifacts(runId) : [];
      const events = run && afterEventSequence !== undefined
        ? this.getCommittedRuntimeEventsAfter(runId, afterEventSequence)
        : [];
      this.db.exec("COMMIT");
      transactionStarted = false;
      return {
        ...(run ? { run } : {}),
        ...(frozen ? { frozen } : {}),
        artifacts,
        cursor: { eventSequence, progressVersion: run?.progressVersion ?? 0 },
        events,
      };
    } catch (error) {
      if (transactionStarted) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRunDir(runId: string): string | undefined {
    const row = this.db.prepare("SELECT run_dir FROM run_inputs WHERE run_id = ?").get(runId) as RunDirRow | undefined;
    return row?.run_dir;
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
    const root = resolve(this.cwd, runDir);
    if (dirname(root) !== resolve(this.cwd, localStateRoot, "runs") || basename(root) !== runId || !runIdPattern.test(runId)) {
      throw new Error(`Run directory '${runDir}' is outside ${localStateRoot}/runs.`);
    }
    return root;
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
    return readRunExecutionMetadata(this.db, runId);
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
          context_json, token_usage_json, tools_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const dynamic = this.getRunDynamicDetails(runId);
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
    if (payload.unsafeReuse !== undefined && payload.unsafeReuse !== true) throw new Error(`Fork event for run '${runId}' has an invalid unsafeReuse flag.`);
    return {
      sourceRunId: payload.sourceRunId,
      ...(payload.target === undefined ? {} : { target: payload.target }),
      ...(payload.unsafeReuse === true ? { unsafeReuse: true } : {}),
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

  private getRunDynamicDetails(runId: string): RunDynamicDetails | undefined {
    const frames = readRunDynamicFrames(this.db, runId);
    const nodeInstances = readRunDynamicNodeInstances(this.db, runId);
    const attempts = readRunDynamicAttempts(this.db, runId);
    const groups = Object.values(throwSchedulerStoreResult(this.scheduler.tryLoadRunSnapshot(runId)).projection.groups).map(runDynamicGroup);
    const groupMembers = readRunDynamicGroupMembers(this.db, runId);
    const signalWaits = readRunDynamicSignalWaits(this.db, runId);
    const executionMetadata = this.getExecutionMetadata(runId);
    const progress = readRunNodeProgress(this.db, runId);
    const progressVersion = runProgressVersion(this.db, runId);
    if (frames.length + nodeInstances.length + attempts.length + groups.length + groupMembers.length + signalWaits.length + executionMetadata.length + progress.length === 0) return undefined;
    return {
      version: this.nextSequence(runId) - 1,
      progressVersion: progressVersion.version,
      ...(progressVersion.updatedAt ? { progressUpdatedAt: progressVersion.updatedAt } : {}),
      frames,
      nodeInstances,
      attempts,
      groups,
      groupMembers,
      signalWaits,
      executionMetadata,
      progress,
    };
  }

  listRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT ${this.runRecordColumns()}
      FROM runs
      ORDER BY updated_at DESC, created_at DESC
    `).all().map(toRunRecord);
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

  private nextSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as CountRow | undefined;
    return row?.count ?? 1;
  }
}

class SqliteSchedulerStorePort implements SchedulerStorePort {
  private readonly snapshotCache = new Map<string, SchedulerSnapshot>();

  constructor(private readonly db: DatabaseSync, private readonly cwd: string) {}

  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
      if (!run) throw new Error(`Run '${runId}' was not found.`);
      const current = this.db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
      if (current && current.released_at === null && current.lease_expires_at > now) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const ownerEpoch = (current?.owner_epoch ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO run_leases (run_id, owner_id, owner_epoch, lease_expires_at, claimed_at, released_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(run_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          owner_epoch = excluded.owner_epoch,
          lease_expires_at = excluded.lease_expires_at,
          claimed_at = excluded.claimed_at,
          released_at = NULL
      `).run(runId, ownerId, ownerEpoch, leaseExpiresAt, now);
      this.db.exec("COMMIT");
      return { runId, ownerId, ownerEpoch, leaseExpiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE run_leases
      SET lease_expires_at = ?
      WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL AND lease_expires_at > ?
    `).run(leaseExpiresAt, claim.runId, claim.ownerId, claim.ownerEpoch, now);
    return result.changes === 1;
  }

  releaseRun(claim: RunOwnerClaim): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE run_leases
        SET released_at = ?
        WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL
      `).run(now, claim.runId, claim.ownerId, claim.ownerEpoch);
      if (result.changes === 1) {
        const snapshot = this.loadRunSnapshot(claim.runId);
        this.maybePersistSchedulerCheckpoint(claim.runId, snapshot.version, snapshot.projection, now, true);
      }
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryLoadRunSnapshot(runId: string): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.loadRunSnapshot(runId));
  }

  private loadRunSnapshot(runId: string): SchedulerSnapshot {
    const row = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!row) throwSchedulerStoreError({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const version = this.currentVersion(runId);
    const cached = this.snapshotCache.get(runId);
    if (cached?.version === version) return cached;
    const checkpoint = schedulerProjectionCheckpoint(this.db, runId);
    if (checkpoint && checkpoint.event_sequence > version) {
      throw new Error(`Run '${runId}' scheduler projection checkpoint sequence ${checkpoint.event_sequence} exceeds event sequence ${version}.`);
    }
    let projection: SchedulerProjection;
    let afterSequence: number;
    if (checkpoint) {
      projection = parseSchedulerProjection(checkpoint.projection_json, runId);
      afterSequence = checkpoint.event_sequence;
    } else {
      projection = createSchedulerProjection(runId);
      afterSequence = 0;
    }
    projection = applySchedulerEvents(projection, this.schedulerEventsAfter(runId, afterSequence));
    const snapshot = {
      runId,
      version,
      projection,
    };
    this.snapshotCache.set(runId, snapshot);
    return snapshot;
  }

  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.appendSchedulerEvents(commit));
  }

  private appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    const hasEvents = commit.events.length > 0;
    if (!hasEvents && commit.intentDigest === undefined) return this.loadRunSnapshot(commit.runId);
    const duplicate = this.duplicateAppendIdempotency(commit);
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    const eventDigest = schedulerEventDigest(commit.events);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.currentVersion(commit.runId);
      if (currentVersion !== commit.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: commit.runId,
          expectedVersion: commit.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${commit.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(commit.runId, commit.ownerEpoch);
      const current = this.loadRunSnapshot(commit.runId);
      this.db.prepare(`
        INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest, intent_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run(commit.runId, commit.idempotencyKey, commit.events.length, eventDigest, commit.intentDigest ?? null);
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: commit.runId,
        current,
        events: commit.events,
        now,
        idempotencyKeys: commit.events.map((_, index) => schedulerEventIdempotencyKey(commit.runId, commit.idempotencyKey, index)),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(commit.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertForkSeedEventsInTransaction(input: {
    runId: string;
    plan: ForkSeedPlan;
    now: string;
  }): void {
    if (input.plan.events.length === 0) return;
    const events = input.plan.events;
    const current = this.loadRunSnapshot(input.runId);
    const commitKey = `fork-seed:${input.runId}`;
    this.db.prepare(`
      INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest)
      VALUES (?, ?, ?, ?)
    `).run(input.runId, commitKey, events.length, schedulerEventDigest(events));
    this.commitProjectionEventsInTransaction({
      runId: input.runId,
      current,
      events,
      now: input.now,
      idempotencyKeys: events.map((_, index) => schedulerEventIdempotencyKey(input.runId, commitKey, index)),
    });
  }

  tryStartAttempt(input: AttemptStartInput): SchedulerStoreResult<AttemptStartResult> {
    return schedulerStoreResult(() => this.startAttempt(input));
  }

  private startAttempt(input: AttemptStartInput): AttemptStartResult {
    const now = new Date().toISOString();
    const attemptId = `attempt_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.eventByIdempotencyKey(input.idempotencyKey);
      if (existing && existing.type === "attempt.started") {
        const payload = existing.payload as { attemptId?: unknown; attemptNo?: unknown };
        if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with another run.` });
        if (!matchesAttemptStartInput(input, payload)) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with different input.` });
        this.requireOwnerEpoch(input.runId, input.ownerEpoch);
        if (typeof payload.attemptId !== "string" || typeof payload.attemptNo !== "number") {
          throw new Error(`Attempt start idempotency key '${input.idempotencyKey}' has invalid payload.`);
        }
        const replay = {
          attemptId: payload.attemptId,
          attemptNo: payload.attemptNo,
          snapshot: this.loadRunSnapshot(input.runId),
          disposition: "existing" as const,
        };
        this.db.exec("COMMIT");
        return replay;
      }
      if (existing) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with ${existing.type}.` });
      const currentVersion = this.currentVersion(input.runId);
      if (currentVersion !== input.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${input.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      const current = this.loadRunSnapshot(input.runId);
      if (current.projection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
      const instance = current.projection.instances[input.nodeKey];
      if (!instance || instance.status !== "ready" || instance.nodeId !== input.nodeId) {
        throwSchedulerStoreError({
          type: "instance-not-ready",
          runId: input.runId,
          nodeKey: input.nodeKey,
          status: instance?.status ?? "missing",
          message: `Node instance '${input.nodeKey}' is not ready.`,
        });
      }
      const blockedMember = ancestorGroupMembersForNode(current.projection, input.nodeKey)
        .find(member => member.status !== "ready" && member.status !== "running");
      if (blockedMember) {
        throwSchedulerStoreError({
          type: "instance-not-ready",
          runId: input.runId,
          nodeKey: input.nodeKey,
          status: `member_${blockedMember.status}`,
          message: `Node instance '${input.nodeKey}' has ${blockedMember.status} ancestor member '${blockedMember.memberKey}'.`,
        });
      }
      const row = this.db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS count FROM node_attempts WHERE run_id = ? AND node_key = ?").get(input.runId, input.nodeKey) as CountRow | undefined;
      const attemptNo = row?.count ?? 1;
      const payload = {
        runId: input.runId,
        attemptId,
        nodeKey: input.nodeKey,
        nodeId: input.nodeId,
        attemptNo,
        ownerEpoch: input.ownerEpoch,
        admissionVersion: input.expectedVersion,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      };
      const instanceStartedEvent: SchedulerEvent = { type: "instance.started", payload: { nodeKey: input.nodeKey, attemptId } };
      const attemptStartedEvent: SchedulerEvent = { type: "attempt.started", payload };
      const memberStartedEvents = this.groupMemberStartedEventsForNode(input.runId, input.nodeKey, current.projection);
      const events = [instanceStartedEvent, ...memberStartedEvents, attemptStartedEvent];
      const clearedProgress = this.db.prepare("DELETE FROM node_progress WHERE run_id = ? AND node_key = ?").run(input.runId, input.nodeKey);
      if (clearedProgress.changes > 0) {
        this.db.prepare(`
          UPDATE runs
          SET progress_version = progress_version + 1, progress_updated_at = ?
          WHERE id = ?
        `).run(now, input.runId);
      }
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now,
        idempotencyKeys: [
          derivedIdempotencyKey(input.idempotencyKey, "instance"),
          ...memberStartedEvents.map((_, index) => derivedIdempotencyKey(input.idempotencyKey, index === 0 ? "member" : `member:${index}`)),
          input.idempotencyKey,
        ],
        nodeKeys: events.map(() => input.nodeKey),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return { attemptId, attemptNo, snapshot, disposition: "started" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.commitAttemptResult(input));
  }

  private commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.eventByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with another run.` });
        const attempt = this.db.prepare("SELECT node_key, owner_epoch FROM node_attempts WHERE run_id = ? AND attempt_id = ?").get(input.runId, input.attemptId) as { node_key: string; owner_epoch: number } | undefined;
        if (!attempt) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
        if (attempt.owner_epoch !== input.ownerEpoch) throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
        this.requireOwnerEpoch(input.runId, input.ownerEpoch);
        const event = attemptResultEvent(input, attempt.node_key);
        if (existing.type !== event.type || stableJsonLine(existing.payload) !== stableJsonLine(event.payload)) {
          throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with different input.` });
        }
        const replay = this.loadRunSnapshot(input.runId);
        this.db.exec("COMMIT");
        return replay;
      }
      const attempt = this.db.prepare("SELECT run_id, node_key, owner_epoch, status FROM node_attempts WHERE attempt_id = ?").get(input.attemptId) as { run_id: string; node_key: string; owner_epoch: number; status: string } | undefined;
      if (!attempt || attempt.run_id !== input.runId) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
      if (attempt.owner_epoch !== input.ownerEpoch) throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      if (attempt.status !== "started") throwSchedulerStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
      const current = this.loadRunSnapshot(input.runId);
      const event = attemptResultEvent(input, String(attempt.node_key));
      const instanceEvent = instanceResultEvent(input, String(attempt.node_key), event);
      const memberEvent = this.groupMemberResultEventForNode(input.runId, String(attempt.node_key), input.result, current.projection);
      const events = [event, instanceEvent, ...(memberEvent ? [memberEvent] : [])];
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now,
        idempotencyKeys: [input.idempotencyKey, derivedIdempotencyKey(input.idempotencyKey, "instance"), ...(memberEvent ? [derivedIdempotencyKey(input.idempotencyKey, "member")] : [])],
        nodeKeys: events.map(() => String(attempt.node_key)),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryConsumeSignal(input: SignalConsumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.consumeSignal(input));
  }

  private consumeSignal(input: SignalConsumeInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({
      type: "signal",
      requestedTarget: input.requestedTarget ?? input.nodeKey,
      nodeKey: input.nodeKey,
      payload: input.payload,
      commandIdempotencyKey: input.commandIdempotencyKey,
    });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    let snapshot = this.loadRunSnapshot(input.runId);
    let wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status === "consumed" && wait.payload !== undefined && stableJsonLine(wait.payload) === stableJsonLine(input.payload)) {
      if (wait.commandIdempotencyKey !== input.commandIdempotencyKey) {
        throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' was already consumed by a different command.` });
      }
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    if (wait.status === "consumed") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' has already consumed a different payload.` });
    }
    if (wait.status !== "awaiting") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' is already ${wait.status}.` });
    }
    snapshot = this.drainDueSignalTimeouts(input.runId, input.ownerEpoch, now);
    wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status !== "awaiting") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' is already ${wait.status}.` });
    }
    if (snapshot.projection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
    const events: SchedulerEvent[] = [
      {
        type: "signal.consumed",
        payload: {
          nodeKey: input.nodeKey,
          payload: input.payload,
          commandIdempotencyKey: input.commandIdempotencyKey,
        },
      },
      {
        type: "instance.completed",
        payload: {
          nodeKey: input.nodeKey,
          output: input.payload,
        },
      },
    ];
    const member = snapshot.projection.groupMembers[input.nodeKey];
    if (member?.status === "ready" || member?.status === "running") {
      events.push({
        type: "group.member_completed",
        payload: {
          memberKey: member.memberKey,
          completionSequence: snapshot.version + events.length + 1,
          output: input.payload,
        },
      });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryPauseRun(input: SchedulerPauseInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.pauseRun(input));
  }

  private pauseRun(input: SchedulerPauseInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "pause" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.drainDueSignalTimeouts(input.runId, input.ownerEpoch, now);
    if (snapshot.projection.run.status === "paused") {
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: {} },
    ];
    for (const wait of Object.values(snapshot.projection.signalWaits)) {
      const deadlineAt = wait.deadlineAt;
      if (wait.status !== "awaiting" || deadlineAt === undefined) continue;
      events.push({
        type: "signal.timeout_paused",
        payload: {
          nodeKey: wait.nodeKey,
          remainingMs: Math.max(0, new Date(deadlineAt).getTime() - now.getTime()),
        },
      });
    }
    for (const attempt of Object.values(snapshot.projection.attempts).filter(attempt => attempt.status === "started")) {
      const instance = snapshot.projection.instances[attempt.nodeKey];
      events.push({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "paused" } });
      if (instance?.status === "running" || instance?.status === "awaiting") {
        events.push({
          type: "instance.requeued",
          payload: {
            nodeKey: instance.nodeKey,
            reason: "paused",
            ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
          },
        });
      }
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryResumeRun(input: SchedulerResumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.resumeRun(input));
  }

  private resumeRun(input: SchedulerResumeInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "resume" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "paused") {
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    const events: SchedulerEvent[] = [{ type: "control.resumed", payload: {} }];
    for (const wait of Object.values(snapshot.projection.signalWaits)) {
      const timeoutRemainingMs = wait.timeoutRemainingMs;
      if (wait.status !== "awaiting" || timeoutRemainingMs === undefined) continue;
      const deadline = tryCreateDeadline(now, timeoutRemainingMs);
      if (deadline.isErr()) {
        throwSchedulerStoreError({
          type: "deadline-out-of-range",
          runId: input.runId,
          nodeKey: wait.nodeKey,
          message: `Signal wait '${wait.nodeKey}' remaining timeout cannot be represented as a persisted deadline.`,
        });
      }
      events.push({
        type: "signal.timeout_resumed",
        payload: {
          nodeKey: wait.nodeKey,
          deadlineAt: deadline.value.toISOString(),
        },
      });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retryRun(input));
  }

  private retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "run_retry" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, status: snapshot.projection.run.status, message: `Cannot retry run from ${snapshot.projection.run.status}.` });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events: [{ type: "control.run_retry_requested", payload: {} }],
    });
  }

  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retry(input));
  }

  private retry(input: SchedulerRetryInput): SchedulerSnapshot {
    const idempotencyKey = input.idempotencyKey;
    const intentDigest = schedulerIntentDigest({ type: "retry", target: input.target });
    const duplicate = this.duplicateIntentIdempotency(input.runId, idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const current = this.loadRunSnapshot(input.runId);
    assertTargetedRetryRunOpen(input.runId, input.target, current.projection.run.status);
    const settled = settleFrozenProjection({
      frozen: this.loadFrozenRun(input.runId),
      projection: current.projection,
      now: new Date(),
    });
    const snapshot: SchedulerSnapshot = {
      runId: current.runId,
      version: current.version + settled.events.length,
      projection: settled.projection,
    };
    assertTargetedRetryRunOpen(input.runId, input.target, snapshot.projection.run.status);
    const targetKey = retryTargetKey(input.target, snapshot).match(
      value => value,
      failure => throwSchedulerStoreError(failure),
    );
    const instance = snapshot.projection.instances[targetKey];
    const frame = snapshot.projection.frames[targetKey];
    if (!instance && !frame) throwSchedulerStoreError({ type: "missing-retry-target", runId: input.runId, targetKey, message: `Retry target '${targetKey}' was not found.` });
    if (frame && !instance) {
      if (frame.status !== "failed") {
        throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey, status: frame.status, message: `Frame '${targetKey}' cannot be retried from ${frame.status}.` });
      }
      if (frame.frameKind !== "node" && frame.frameKind !== "loop") {
        throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey, status: frame.status, message: `Frame '${targetKey}' is not a retryable public node frame.` });
      }
      assertRetryableAncestorFrames(input.runId, targetKey, snapshot.projection, frame.parentFrameKey);
      const plan = planRetryAncestorGroups(input.runId, targetKey, snapshot.projection, ancestorGroupMembersForFrame(snapshot.projection, frame.parentFrameKey));
      const retryEvents: SchedulerEvent[] = [{
        type: "frame.retry_requested",
        payload: {
          frameKey: targetKey,
          ...(plan.retryDependencyMemberKeys.length === 0 ? {} : { retryDependencyMemberKeys: plan.retryDependencyMemberKeys }),
        },
      }, ...plan.events];
      assertRetryDependenciesCanProgress(input.runId, targetKey, snapshot.projection, retryEvents, plan.retryDependencyMemberKeys);
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: current.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey,
        intentDigest,
        events: [...settled.events, ...retryEvents],
      });
    }
    if (!instance) throwSchedulerStoreError({ type: "missing-retry-target", runId: input.runId, targetKey, message: `Retry target '${targetKey}' was not found.` });
    if (instance.status !== "failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey, status: instance.status, message: `Node instance '${targetKey}' cannot be retried from ${instance.status}.` });
    }
    if (instance.statusReason === "expression_resolution_failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey, status: instance.statusReason, message: `Node instance '${targetKey}' failed before execution and must be retried through its containing frame or run.` });
    }
    assertRetryableAncestorFrames(input.runId, targetKey, snapshot.projection, instance.parentFrameKey);
    const plan = planRetryAncestorGroups(input.runId, targetKey, snapshot.projection, ancestorGroupMembersForNode(snapshot.projection, targetKey));
    const retryEvents: SchedulerEvent[] = [
      {
        type: "instance.retry_requested",
        payload: {
          nodeKey: targetKey,
          ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
          ...(plan.retryDependencyMemberKeys.length === 0 ? {} : { retryDependencyMemberKeys: plan.retryDependencyMemberKeys }),
        },
      },
      ...plan.events,
    ];
    assertRetryDependenciesCanProgress(input.runId, targetKey, snapshot.projection, retryEvents, plan.retryDependencyMemberKeys);
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: current.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey,
      intentDigest,
      events: [...settled.events, ...retryEvents],
    });
  }

  tryCancel(input: SchedulerCancelInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.cancel(input));
  }

  private cancel(input: SchedulerCancelInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "cancel", target: input.target ?? null });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (input.target === undefined && snapshot.projection.run.status === "canceled") {
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    const targetKey = input.target === undefined ? "root" : cancelTargetKey(input.target, snapshot).match(
      value => value,
      failure => throwSchedulerStoreError(failure),
    );
    const events = targetKey === "root" && !snapshot.projection.frames.root && snapshot.projection.run.status === "pending"
      ? [
        { type: "frame.started", payload: { runId: input.runId, frameKey: "root", frameKind: "root" } },
        { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "operator_cancelled" } },
      ] satisfies SchedulerEvent[]
      : targetKey === "root"
        ? cancellationEventsForFrame(snapshot.projection, "root", "operator_cancelled")
      : snapshot.projection.frames[targetKey]
        ? cancellationEventsForFrame(snapshot.projection, targetKey, "operator_cancelled")
        : cancellationEventsForNode(snapshot.projection, targetKey, "operator_cancelled");
    if (events.length === 0) {
      const status = snapshot.projection.frames[targetKey]?.status ?? snapshot.projection.instances[targetKey]?.status;
      if (status) throwSchedulerStoreError({ type: "invalid-cancel-target", runId: input.runId, targetKey, status, message: `Cancel target '${targetKey}' is already ${status}.` });
      throwSchedulerStoreError({ type: "missing-cancel-target", runId: input.runId, targetKey, message: `Cancel target '${targetKey}' was not found.` });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryMarkExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.markExpiredOwnerAttemptsSuperseded(input));
  }

  private markExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.currentVersion(input.runId);
      if (currentVersion !== input.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${input.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(input.runId, input.currentOwnerEpoch);
      this.assertOwnerEpochExpired(input.runId, input.expiredOwnerEpoch);
      const attempts = this.db.prepare("SELECT attempt_id, node_key FROM node_attempts WHERE run_id = ? AND owner_epoch = ? AND status = 'started'").all(input.runId, input.expiredOwnerEpoch) as Array<{ attempt_id: string; node_key: string }>;
      const current = this.loadRunSnapshot(input.runId);
      let projection = current.projection;
      const recoveryEvents: SchedulerEvent[] = [];
      const idempotencyKeys: string[] = [];
      const nodeKeys: string[] = [];
      for (const attempt of attempts) {
        const instance = projection.instances[attempt.node_key];
        const events: SchedulerEvent[] = [
          { type: "attempt.superseded", payload: { attemptId: attempt.attempt_id, cancelReason: "superseded" } },
          ...(instance && (instance.status === "running" || instance.status === "awaiting")
            ? [{ type: "instance.requeued", payload: { nodeKey: instance.nodeKey, reason: "superseded", ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }) } } satisfies SchedulerEvent]
            : []),
        ];
        projection = applySchedulerEvents(projection, events);
        for (const [index, event] of events.entries()) {
          recoveryEvents.push(event);
          idempotencyKeys.push(`supersede:${input.runId}:${attempt.attempt_id}:${index}`);
          nodeKeys.push(eventNodeKey(event) ?? attempt.node_key);
        }
      }
      const snapshot = this.commitProjectionEventsInTransaction({ runId: input.runId, current, events: recoveryEvents, now, idempotencyKeys, nodeKeys });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private schedulerEventsAfter(runId: string, sequence: number): SchedulerEvent[] {
    return schedulerEventsAfter(this.db, runId, sequence);
  }

  private commitProjectionEventsInTransaction(input: {
    runId: string;
    current: SchedulerSnapshot;
    events: SchedulerEvent[];
    now: string;
    idempotencyKeys: string[];
    nodeKeys?: Array<string | null>;
  }): SchedulerSnapshot {
    if (input.events.length !== input.idempotencyKeys.length || (input.nodeKeys && input.events.length !== input.nodeKeys.length)) {
      throw new Error(`Run '${input.runId}' scheduler projection commit metadata does not match its event count.`);
    }
    const projection = applySchedulerEvents(input.current.projection, input.events);
    let sequence = input.current.version + 1;
    const insert = this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, event] of input.events.entries()) {
      insert.run(input.runId, sequence, event.type, input.nodeKeys?.[index] ?? eventNodeKey(event), encodeSchedulerPayload(event.payload), input.now, input.idempotencyKeys[index]!);
      sequence += 1;
    }
    if (input.events.length > 0) {
      this.syncSchedulerProjectionTables(input.runId, input.now, input.current.projection, projection);
      this.syncPublicRunProjection(input.runId, input.now, input.current.projection, projection);
    }
    const version = this.currentVersion(input.runId);
    this.maybePersistSchedulerCheckpoint(input.runId, version, projection, input.now);
    return { runId: input.runId, version, projection };
  }

  private currentVersion(runId: string): number {
    return this.nextSequence(runId) - 1;
  }

  private nextSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as CountRow | undefined;
    return row?.count ?? 1;
  }

  private requireOwnerEpoch(runId: string, ownerEpoch: number): void {
    requireActiveOwnerEpoch(this.db, runId, ownerEpoch);
  }

  private drainDueSignalTimeouts(runId: string, ownerEpoch: number, now: Date): SchedulerSnapshot {
    const snapshot = throwSchedulerStoreResult(this.tryLoadRunSnapshot(runId));
    const events = signalTimeoutEvents(snapshot.projection, now);
    if (events.length === 0) return snapshot;
    const frozen = this.loadFrozenRun(runId);
    const settled = settleFrozenProjection({ frozen, projection: snapshot.projection, initialEvents: events, now });
    return throwSchedulerStoreResult(this.tryAppendSchedulerEvents({
      runId,
      ownerEpoch,
      expectedVersion: snapshot.version,
      idempotencyKey: `scheduler:signal-timeouts:${runId}:${snapshot.version}`,
      events: settled.events,
    }));
  }

  private loadFrozenRun(runId: string): FrozenRun {
    const row = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, run_inputs.workflow_ir_path, run_inputs.workflow_ir_digest, run_inputs.input_json, run_inputs.agent_overrides_json, run_inputs.run_dir
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
      WHERE run_inputs.run_id = ?
    `).get(runId) as (FrozenWorkflowRow & { id: string; name: string; workflow_entry: string }) | undefined;
    if (!row) throw new Error(`Run '${runId}' has no frozen workflow.`);
    const workflowIrJson = frozenWorkflowIrJson(this.cwd, row);
    const originalIr = JSON.parse(workflowIrJson) as WorkflowIR;
    const agentOverrides = parseAgentOverrides(row.agent_overrides_json);
    return {
      ir: withAgentOverrides(originalIr, agentOverrides),
      input: JSON.parse(row.input_json) as JsonValue,
      agentOverrides,
      meta: {
        runId: String(row.id),
        workflowPath: String(row.workflow_entry),
        workflowName: String(row.name),
        workspaceDir: resolve(this.cwd),
      },
    };
  }

  private assertOwnerEpochExpired(runId: string, ownerEpoch: number): void {
    const row = this.db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
    const now = new Date().toISOString();
    if (row && row.owner_epoch === ownerEpoch && row.released_at === null && row.lease_expires_at > now) {
      throwSchedulerStoreError({ type: "owner-epoch-still-active", runId, ownerEpoch, message: `Run '${runId}' scheduler owner epoch ${ownerEpoch} is still active.` });
    }
  }

  private eventByIdempotencyKey(idempotencyKey: string): { run_id: string; type: string; payload: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT run_id, type, payload_json FROM run_events WHERE idempotency_key = ?").get(idempotencyKey) as { run_id: string; type: string; payload_json: string } | undefined;
    if (!row) return undefined;
    if (!isSchedulerEventType(row.type)) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId: row.run_id, message: `Scheduler idempotency key '${idempotencyKey}' conflicts with non-scheduler event.` });
    }
    return { run_id: row.run_id, type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) };
  }

  private groupMemberStartedEventsForNode(_runId: string, nodeKey: string, projection: SchedulerProjection): Array<Extract<SchedulerEvent, { type: "group.member_started" }>> {
    return ancestorGroupMembersForNode(projection, nodeKey)
      .filter(member => member.status === "ready")
      .map(member => ({ type: "group.member_started", payload: { memberKey: member.memberKey } }));
  }

  private groupMemberResultEventForNode(runId: string, nodeKey: string, result: AttemptCommitInput["result"], projection: SchedulerProjection): Extract<SchedulerEvent, { type: "group.member_completed" | "group.member_failed" | "group.member_cancelled" }> | undefined {
    const member = projection.groupMembers[nodeKey];
    if (!member || member.status !== "running") return undefined;
    if (result.status === "completed") {
      return { type: "group.member_completed", payload: { memberKey: member.memberKey, completionSequence: this.nextSequence(runId), ...(result.output === undefined ? {} : { output: result.output }) } };
    }
    if (result.status === "cancelled") return { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason: result.reason } };
    return { type: "group.member_failed", payload: { memberKey: member.memberKey, error: result.error ?? { reason: result.reason }, terminalReason: result.status === "timed_out" ? "timed_out" : result.reason } };
  }

  private duplicateAppendIdempotency(commit: SchedulerCommit): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT event_count, event_digest, intent_digest
      FROM scheduler_commits
      WHERE run_id = ? AND idempotency_key = ?
    `).get(commit.runId, commit.idempotencyKey) as { event_count: number; event_digest: string; intent_digest: string | null } | undefined;
    if (!row) return undefined;
    if (row.event_count !== commit.events.length
      || row.event_digest !== schedulerEventDigest(commit.events)
      || (row.intent_digest ?? undefined) !== commit.intentDigest) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: commit.idempotencyKey, runId: commit.runId, message: `Scheduler commit idempotency key '${commit.idempotencyKey}' conflicts with different events.` });
    }
    return this.loadRunSnapshot(commit.runId);
  }

  private duplicateIntentIdempotency(runId: string, idempotencyKey: string, intentDigest: string): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT intent_digest
      FROM scheduler_commits
      WHERE run_id = ? AND idempotency_key = ?
    `).get(runId, idempotencyKey) as { intent_digest: string | null } | undefined;
    if (!row) return undefined;
    if (row.intent_digest !== intentDigest) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId, message: `Scheduler intent idempotency key '${idempotencyKey}' conflicts with a different control.` });
    }
    return this.loadRunSnapshot(runId);
  }

  private syncSchedulerProjectionTables(runId: string, now: string, before: SchedulerProjection, projection: SchedulerProjection): void {
    const delta = schedulerProjectionDelta(before, projection);
    const timings = incrementalProjectionTimings(this.db, runId, now, before, projection, delta);
    const frameKeys = delta.frame.upserts;
    const instanceKeys = delta.instance.upserts;
    const attemptKeys = delta.attempt.upserts;
    const memberKeys = delta.member.upserts;
    const signalKeys = delta.signal.upserts;
    const existingSignalWaits = new Map((this.db.prepare("SELECT node_key, consumed_at, created_at FROM signal_waits WHERE run_id = ?").all(runId) as Array<{ node_key: string; consumed_at: string | null; created_at: string }>)
      .map(row => [row.node_key, row]));
    deleteProjectionRows(this.db, "scheduler_frames", "frame_key", runId, delta.frame.deletes);
    deleteProjectionRows(this.db, "node_instances", "node_key", runId, delta.instance.deletes);
    deleteProjectionRows(this.db, "node_attempts", "attempt_id", runId, delta.attempt.deletes);
    deleteProjectionRows(this.db, "group_members", "member_key", runId, delta.member.deletes);
    deleteProjectionRows(this.db, "signal_waits", "node_key", runId, delta.signal.deletes);

    for (const frameKey of frameKeys) {
      const frame = projection.frames[frameKey]!;
      const timing = timings.frame.get(frame.frameKey);
      this.db.prepare(`
        INSERT INTO scheduler_frames (
          run_id, frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
          terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, frame_key) DO UPDATE SET
          parent_frame_key = excluded.parent_frame_key,
          node_key = excluded.node_key,
          node_id = excluded.node_id,
          frame_kind = excluded.frame_kind,
          status = excluded.status,
          strategy = excluded.strategy,
          terminal_reason = excluded.terminal_reason,
          instance_path_json = excluded.instance_path_json,
          scope_json = excluded.scope_json,
          loop_json = excluded.loop_json,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        frame.runId,
        frame.frameKey,
        frame.parentFrameKey ?? null,
        frame.nodeKey ?? null,
        frame.nodeId ?? null,
        frame.frameKind,
        frame.status,
        frame.strategy ?? null,
        frame.terminalReason ?? null,
        frame.instancePath === undefined ? null : stableJsonLine(frame.instancePath as unknown as JsonValue),
        stableJsonLine(frame.scope),
        frame.loop === undefined ? null : stableJsonLine(frame.loop),
        frame.result === undefined ? null : stableJsonLine(frame.result),
        frame.error === undefined ? null : stableJsonLine(frame.error),
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const instanceKey of instanceKeys) {
      const instance = projection.instances[instanceKey]!;
      const timing = timings.instance.get(instance.nodeKey);
      this.db.prepare(`
        INSERT INTO node_instances (
          run_id, node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
          readiness_sequence, output_json, error_json, accepted_attempt_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          parent_frame_key = excluded.parent_frame_key,
          instance_path_json = excluded.instance_path_json,
          status = excluded.status,
          status_reason = excluded.status_reason,
          readiness_sequence = excluded.readiness_sequence,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          accepted_attempt_id = excluded.accepted_attempt_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.parentFrameKey ?? null,
        stableJsonLine(instance.instancePath as unknown as JsonValue),
        instance.status,
        instance.statusReason ?? null,
        instance.readinessSequence ?? null,
        instance.output === undefined ? null : stableJsonLine(instance.output),
        instance.error === undefined ? null : stableJsonLine(instance.error),
        instance.acceptedAttemptId ?? null,
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const attemptKey of attemptKeys) {
      const attempt = projection.attempts[attemptKey]!;
      const timing = timings.attempt.get(attempt.attemptId);
      this.db.prepare(`
        INSERT INTO node_attempts (
          run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch, status, deadline_at,
          started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET
          run_id = excluded.run_id,
          node_key = excluded.node_key,
          node_id = excluded.node_id,
          attempt_no = excluded.attempt_no,
          owner_epoch = excluded.owner_epoch,
          status = excluded.status,
          deadline_at = excluded.deadline_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          terminal_reason = excluded.terminal_reason,
          cancel_reason = excluded.cancel_reason
      `).run(
        attempt.runId,
        attempt.attemptId,
        attempt.nodeKey,
        attempt.nodeId,
        attempt.attemptNo,
        attempt.ownerEpoch,
        attempt.status,
        attempt.deadlineAt ?? null,
        timing?.createdAt ?? now,
        attempt.status === "started" ? null : timing?.updatedAt ?? now,
        attempt.result === undefined ? null : stableJsonLine(attempt.result),
        attempt.error === undefined ? null : stableJsonLine(attempt.error),
        attempt.terminalReason ?? null,
        attempt.cancelReason ?? null,
      );
    }

    for (const memberKey of memberKeys) {
      const member = projection.groupMembers[memberKey]!;
      const timing = timings.member.get(member.memberKey);
      const branchId = member.memberKind === "branch" ? member.branchId : null;
      const itemIndex = member.memberKind === "fanout_item" ? member.itemIndex : null;
      const itemJson = member.memberKind === "fanout_item" ? stableJsonLine(member.item) : null;
      this.db.prepare(`
        INSERT INTO group_members (
          run_id, group_key, member_key, member_kind, branch_id, item_index, item_json, child_frame_key,
          status, readiness_sequence, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, member_key) DO UPDATE SET
          group_key = excluded.group_key,
          member_kind = excluded.member_kind,
          branch_id = excluded.branch_id,
          item_index = excluded.item_index,
          item_json = excluded.item_json,
          child_frame_key = excluded.child_frame_key,
          status = excluded.status,
          readiness_sequence = excluded.readiness_sequence,
          completion_sequence = excluded.completion_sequence,
          accepted_rank = excluded.accepted_rank,
          terminal_reason = excluded.terminal_reason,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        member.runId,
        member.groupKey,
        member.memberKey,
        member.memberKind,
        branchId,
        itemIndex,
        itemJson,
        member.childFrameKey ?? null,
        member.status,
        member.readinessSequence,
        member.completionSequence ?? null,
        member.acceptedRank ?? null,
        member.terminalReason ?? null,
        member.output === undefined ? null : stableJsonLine(member.output),
        member.error === undefined ? null : stableJsonLine(member.error),
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const signalKey of signalKeys) {
      const wait = projection.signalWaits[signalKey]!;
      const existing = existingSignalWaits.get(wait.nodeKey);
      const timing = timings.signal.get(wait.nodeKey);
      this.db.prepare(`
        INSERT INTO signal_waits (
          run_id, node_key, node_id, status, payload_json,
          deadline_at, timeout_message, timeout_remaining_ms, rendered_prompt, consumed_at, terminal_reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          status = excluded.status,
          payload_json = excluded.payload_json,
          deadline_at = excluded.deadline_at,
          timeout_message = excluded.timeout_message,
          timeout_remaining_ms = excluded.timeout_remaining_ms,
          rendered_prompt = excluded.rendered_prompt,
          consumed_at = excluded.consumed_at,
          terminal_reason = excluded.terminal_reason,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        wait.runId,
        wait.nodeKey,
        wait.nodeId,
        wait.status,
        wait.payload === undefined ? null : stableJsonLine(wait.payload),
        wait.deadlineAt ?? null,
        wait.timeoutMessage ?? null,
        wait.timeoutRemainingMs ?? null,
        wait.renderedPrompt ?? null,
        wait.status === "consumed" ? timing?.updatedAt ?? existing?.consumed_at ?? now : null,
        wait.terminalReason ?? null,
        timing?.createdAt ?? existing?.created_at ?? now,
        timing?.updatedAt ?? now,
      );
    }
  }

  private syncPublicRunProjection(runId: string, now: string, before: SchedulerProjection, projection: SchedulerProjection): void {
    const current = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    const hasTargetedRetry = Boolean(this.db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('instance.retry_requested', 'frame.retry_requested') LIMIT 1").get(runId));
    if (current?.status === "failed" && projection.run.status === "pending" && Object.keys(projection.frames).length === 0) {
      this.db.prepare("UPDATE runs SET status = 'pending', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM node_states WHERE run_id = ?").run(runId);
      return;
    }
    if (!current || current.status === "completed" || current.status === "canceled" || (current.status === "failed" && !hasTargetedRetry)) return;
    this.syncPublicNodeStates(before, projection);
    const root = projection.frames.root;
    if (projection.run.status === "completed") {
      const output = root?.result ?? {};
      this.db.prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = ? WHERE run_id = ?").run(stableJsonLine(output), runId);
      this.insertPublicRunEvent(runId, "run.completed", { output }, now, `scheduler-public:completed:${runId}:${this.rootTerminalEventCount(runId, "frame.completed")}`);
      return;
    }
    if (projection.run.status === "failed") {
      const error = root?.error ?? { reason: root?.terminalReason ?? "scheduler_failed" };
      this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.failed", error, now, `scheduler-public:failed:${runId}:${this.rootTerminalEventCount(runId, "frame.failed")}`);
      return;
    }
    if (projection.run.status === "canceled") {
      this.db.prepare("UPDATE runs SET status = 'canceled', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.canceled", { reason: root?.terminalReason ?? "operator_cancelled" }, now, `scheduler-public:canceled:${runId}:${this.rootTerminalEventCount(runId, "frame.cancelled")}`);
      return;
    }
    if (projection.run.status === "paused") {
      this.db.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(now, runId);
      return;
    }
    const status = publicRunStatus(projection);
    if (current.status === "failed") {
      this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      return;
    }
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(status, now, runId);
  }

  private syncPublicNodeStates(before: SchedulerProjection, projection: SchedulerProjection): void {
    const delta = recordDelta(before.instances, projection.instances);
    const changedInstances = delta.upserts.map(nodeKey => projection.instances[nodeKey]!);
    const dynamicNodeIds = [...new Set(changedInstances
      .filter(instance => instance.nodeKey !== instance.nodeId)
      .map(instance => instance.nodeId))];
    if (dynamicNodeIds.length > 0) {
      const placeholders = dynamicNodeIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key = node_id AND node_id IN (${placeholders})`).run(projection.run.runId, ...dynamicNodeIds);
    }
    if (delta.deletes.length > 0) {
      const placeholders = delta.deletes.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key IN (${placeholders})`).run(projection.run.runId, ...delta.deletes);
    }
    for (const instance of changedInstances) {
      this.db.prepare(`
        INSERT INTO node_states (run_id, node_key, node_id, status, output_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          status = excluded.status,
          output_json = excluded.output_json
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.status,
        instance.output === undefined ? null : stableJsonLine(instance.output),
      );
    }
  }

  private insertPublicRunEvent(runId: string, type: "run.completed" | "run.failed" | "run.canceled", payload: JsonValue, now: string, idempotencyKey: string): void {
    const existing = this.db.prepare("SELECT id FROM run_events WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return;
    this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(runId, this.nextSequence(runId), type, stableJsonLine(payload), now, idempotencyKey);
  }

  private rootTerminalEventCount(runId: string, type: "frame.completed" | "frame.failed" | "frame.cancelled"): number {
    const rows = this.db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = ?").all(runId, type) as Array<{ payload_json: string }>;
    return rows.filter(row => decodeSchedulerPayload(row.payload_json, type).frameKey === "root").length;
  }

  private maybePersistSchedulerCheckpoint(runId: string, eventSequence: number, projection: SchedulerProjection, now: string, release = false): void {
    if (projection.run.status === "completed") {
      this.db.prepare("DELETE FROM scheduler_projection_checkpoints WHERE run_id = ?").run(runId);
      return;
    }
    const existing = this.db.prepare("SELECT event_sequence FROM scheduler_projection_checkpoints WHERE run_id = ?").get(runId) as { event_sequence: number } | undefined;
    if (existing?.event_sequence === eventSequence) return;
    const force = release || projection.run.status === "failed" || projection.run.status === "canceled" || projection.run.status === "paused";
    if (existing && !force && eventSequence - existing.event_sequence < 256) return;
    this.db.prepare(`
      INSERT INTO scheduler_projection_checkpoints (run_id, event_sequence, projection_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        projection_json = excluded.projection_json,
        updated_at = excluded.updated_at
    `).run(runId, eventSequence, stableJsonLine(projection as unknown as JsonValue), now);
  }
}

function schedulerEventsAfter(db: DatabaseSync, runId: string, sequence: number): SchedulerEvent[] {
  const rows = db.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, sequence) as Array<{ type: string; payload_json: string }>;
  return rows.flatMap(row => {
    if (!isSchedulerEventType(row.type)) return [];
    return [{ type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) } as SchedulerEvent];
  });
}

function parseSchedulerProjection(json: string, runId: string): SchedulerProjection {
  let projection: Partial<SchedulerProjection>;
  try {
    projection = JSON.parse(json) as Partial<SchedulerProjection>;
  } catch (cause) {
    throw new Error(`Run '${runId}' scheduler projection checkpoint JSON is malformed.`, { cause });
  }
  if (projection.run?.runId !== runId
    || !projection.frames
    || !projection.instances
    || !projection.attempts
    || !projection.groups
    || !projection.groupMembers
    || !projection.signalWaits
    || !projection.branchDecisions) {
    throw new Error(`Run '${runId}' scheduler projection checkpoint is malformed.`);
  }
  return projection as SchedulerProjection;
}

function schedulerProjectionCheckpoint(db: DatabaseSync, runId: string): { event_sequence: number; projection_json: string } | undefined {
  return db.prepare(`
    SELECT event_sequence, projection_json
    FROM scheduler_projection_checkpoints
    WHERE run_id = ?
  `).get(runId) as { event_sequence: number; projection_json: string } | undefined;
}

type ProjectionEntityDelta = { upserts: string[]; deletes: string[] };
type SchedulerProjectionDelta = {
  frame: ProjectionEntityDelta;
  instance: ProjectionEntityDelta;
  attempt: ProjectionEntityDelta;
  member: ProjectionEntityDelta;
  signal: ProjectionEntityDelta;
};

function schedulerProjectionDelta(before: SchedulerProjection, after: SchedulerProjection): SchedulerProjectionDelta {
  return {
    frame: recordDelta(before.frames, after.frames),
    instance: recordDelta(before.instances, after.instances),
    attempt: recordDelta(before.attempts, after.attempts),
    member: recordDelta(before.groupMembers, after.groupMembers),
    signal: recordDelta(before.signalWaits, after.signalWaits),
  };
}

function recordDelta<T>(before: Record<string, T>, after: Record<string, T>): ProjectionEntityDelta {
  return {
    upserts: Object.keys(after).filter(key => before[key] !== after[key]),
    deletes: Object.keys(before).filter(key => !(key in after)),
  };
}

function incrementalProjectionTimings(
  db: DatabaseSync,
  runId: string,
  now: string,
  before: SchedulerProjection,
  after: SchedulerProjection,
  delta: SchedulerProjectionDelta,
): SchedulerProjectionTimings {
  const timings: SchedulerProjectionTimings = {
    frame: new Map(),
    instance: new Map(),
    attempt: new Map(),
    member: new Map(),
    signal: new Map(),
  };
  for (const key of delta.frame.upserts) timings.frame.set(key, changedTiming(db, "scheduler_frames", "frame_key", runId, key, now, before.frames[key]?.status, after.frames[key]!.status));
  for (const key of delta.instance.upserts) timings.instance.set(key, changedTiming(db, "node_instances", "node_key", runId, key, now, before.instances[key]?.status, after.instances[key]!.status));
  for (const key of delta.attempt.upserts) timings.attempt.set(key, changedAttemptTiming(db, runId, key, now, before.attempts[key]?.status, after.attempts[key]!.status));
  for (const key of delta.member.upserts) timings.member.set(key, changedTiming(db, "group_members", "member_key", runId, key, now, before.groupMembers[key]?.status, after.groupMembers[key]!.status));
  for (const key of delta.signal.upserts) timings.signal.set(key, changedTiming(db, "signal_waits", "node_key", runId, key, now, before.signalWaits[key]?.status, after.signalWaits[key]!.status));
  return timings;
}

function changedTiming(
  db: DatabaseSync,
  table: "scheduler_frames" | "node_instances" | "group_members" | "signal_waits",
  keyColumn: "frame_key" | "node_key" | "member_key",
  runId: string,
  key: string,
  now: string,
  beforeStatus: string | undefined,
  afterStatus: string,
): { createdAt: string; updatedAt: string } {
  const row = db.prepare(`SELECT created_at FROM ${table} WHERE run_id = ? AND ${keyColumn} = ?`).get(runId, key) as { created_at: string } | undefined;
  return {
    createdAt: row && !resetsProjectionLifecycle(beforeStatus, afterStatus) ? row.created_at : now,
    updatedAt: now,
  };
}

function changedAttemptTiming(
  db: DatabaseSync,
  runId: string,
  attemptId: string,
  now: string,
  beforeStatus: string | undefined,
  afterStatus: string,
): { createdAt: string; updatedAt: string } {
  const row = db.prepare("SELECT started_at FROM node_attempts WHERE run_id = ? AND attempt_id = ?").get(runId, attemptId) as { started_at: string } | undefined;
  return {
    createdAt: row && !resetsProjectionLifecycle(beforeStatus, afterStatus) ? row.started_at : now,
    updatedAt: now,
  };
}

function resetsProjectionLifecycle(before: string | undefined, after: string): boolean {
  return before !== undefined && terminalProjectionStatus(before) && !terminalProjectionStatus(after);
}

function terminalProjectionStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled" || status === "timed_out" || status === "consumed" || status === "superseded";
}

function deleteProjectionRows(
  db: DatabaseSync,
  table: "scheduler_frames" | "node_instances" | "node_attempts" | "group_members" | "signal_waits",
  keyColumn: "frame_key" | "node_key" | "attempt_id" | "member_key",
  runId: string,
  keys: readonly string[],
): void {
  const statement = db.prepare(`DELETE FROM ${table} WHERE run_id = ? AND ${keyColumn} = ?`);
  for (const key of keys) statement.run(runId, key);
}

function publicRunStatus(projection: ReturnType<typeof createSchedulerProjection>): RunStatus {
  if (projection.run.status === "awaiting" || hasAwaitingWork(projection)) return "awaiting";
  if (hasRunningWork(projection)) return "running";
  return "pending";
}

function hasAwaitingWork(projection: ReturnType<typeof createSchedulerProjection>): boolean {
  return Object.values(projection.instances).some(instance => instance.status === "awaiting")
    || Object.values(projection.frames).some(frame => frame.status === "awaiting")
    || Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
}

function hasRunningWork(projection: ReturnType<typeof createSchedulerProjection>): boolean {
  if (projection.frames.root !== undefined) return true;
  return Object.values(projection.frames).some(frame => frame.status === "ready" || frame.status === "running")
    || Object.values(projection.instances).some(instance => instance.status === "ready" || instance.status === "running")
    || Object.values(projection.groupMembers).some(member => member.status === "ready" || member.status === "running")
    || Object.values(projection.groups).some(group => group.status === "running")
    || Object.values(projection.attempts).some(attempt => attempt.status === "started");
}

function readRunDynamicFrames(db: DatabaseSync, runId: string): RunDynamicFrame[] {
  const rows = db.prepare(`
    SELECT frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
      terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json, created_at, updated_at
    FROM scheduler_frames
    WHERE run_id = ?
    ORDER BY frame_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => withoutUndefined({
    frameKey: String(row.frame_key),
    parentFrameKey: nullableString(row.parent_frame_key),
    nodeKey: nullableString(row.node_key),
    nodeId: nullableString(row.node_id),
    instancePath: parseOptionalJson(row.instance_path_json),
    frameKind: String(row.frame_kind),
    status: String(row.status),
    scope: parseOptionalJson(row.scope_json),
    strategy: nullableString(row.strategy),
    loop: parseOptionalJson(row.loop_json),
    terminalReason: nullableString(row.terminal_reason),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }) as RunDynamicFrame);
}

function readRunDynamicNodeInstances(db: DatabaseSync, runId: string): RunDynamicNodeInstance[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
      output_json, error_json, accepted_attempt_id, created_at, updated_at
    FROM node_instances
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => {
    const status = String(row.status);
    const statusReason = publicNodeInstanceStatusReason(status, nullableString(row.status_reason));
    return withoutUndefined({
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      parentFrameKey: nullableString(row.parent_frame_key),
      instancePath: parseOptionalJson(row.instance_path_json),
      status,
      statusReason,
      output: parseOptionalJson(row.output_json),
      error: parseOptionalJson(row.error_json),
      acceptedAttemptId: nullableString(row.accepted_attempt_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicNodeInstance;
  });
}

function publicNodeInstanceStatusReason(status: string, statusReason: string | undefined): string | undefined {
  return status === "running" || status === "completed" ? undefined : statusReason;
}

function readRunDynamicAttempts(db: DatabaseSync, runId: string): RunDynamicAttempt[] {
  const rows = db.prepare(`
    SELECT attempt_id, node_key, node_id, attempt_no, status, deadline_at,
      started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
    FROM node_attempts
    WHERE run_id = ?
    ORDER BY attempt_id
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => {
    const attemptId = String(row.attempt_id);
    return withoutUndefined({
      attemptId,
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      attemptNo: Number(row.attempt_no),
      status: String(row.status),
      deadlineAt: optionalPersistedDeadline(row.deadline_at, `Attempt '${attemptId}'`),
      startedAt: String(row.started_at),
      finishedAt: nullableString(row.finished_at),
      result: parseOptionalJson(row.result_json),
      error: parseOptionalJson(row.error_json),
      terminalReason: nullableString(row.terminal_reason),
      cancelReason: nullableString(row.cancel_reason),
    }) as RunDynamicAttempt;
  });
}

function readRunDynamicGroupMembers(db: DatabaseSync, runId: string): RunDynamicGroupMember[] {
  const rows = db.prepare(`
    SELECT group_key, member_key, member_kind, branch_id, item_index, item_json, child_frame_key,
      status, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
    FROM group_members
    WHERE run_id = ?
    ORDER BY member_key
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => {
    const member = withoutUndefined({
      groupKey: String(row.group_key),
      memberKey: String(row.member_key),
      childFrameKey: nullableString(row.child_frame_key),
      status: String(row.status),
      completionSequence: nullableNumber(row.completion_sequence),
      acceptedRank: nullableNumber(row.accepted_rank),
      terminalReason: nullableString(row.terminal_reason),
      output: parseOptionalJson(row.output_json),
      error: parseOptionalJson(row.error_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicGroupMemberBase;
    if (row.member_kind === "branch") {
      const branchId = nullableString(row.branch_id);
      if (branchId === undefined) throw new Error(`Branch group member '${member.memberKey}' is missing branch_id.`);
      return { ...member, memberKind: "branch", branchId };
    }
    if (row.member_kind === "fanout_item") {
      const itemIndex = nullableNumber(row.item_index);
      const item = parseOptionalJson(row.item_json);
      if (itemIndex === undefined) throw new Error(`Fanout group member '${member.memberKey}' is missing item_index.`);
      if (item === undefined) throw new Error(`Fanout group member '${member.memberKey}' is missing item_json.`);
      return { ...member, memberKind: "fanout_item", itemIndex, item: item as JsonValue };
    }
    throw new Error(`Group member '${member.memberKey}' has invalid member_kind '${row.member_kind}'.`);
  });
}

function readRunDynamicSignalWaits(db: DatabaseSync, runId: string): RunDynamicSignalWait[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, status, payload_json, deadline_at,
      timeout_message, timeout_remaining_ms, rendered_prompt, terminal_reason,
      consumed_at, created_at, updated_at
    FROM signal_waits
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => {
    const nodeKey = String(row.node_key);
    return withoutUndefined({
      nodeKey,
      nodeId: String(row.node_id),
      status: String(row.status),
      payload: row.status === "consumed" ? parseOptionalJson(row.payload_json) : undefined,
      deadlineAt: optionalPersistedDeadline(row.deadline_at, `Signal wait '${nodeKey}'`),
      timeoutMessage: nullableString(row.timeout_message),
      timeoutRemainingMs: nullableNumber(row.timeout_remaining_ms),
      renderedPrompt: nullableString(row.rendered_prompt),
      terminalReason: nullableString(row.terminal_reason),
      consumedAt: row.status === "consumed" ? nullableString(row.consumed_at) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicSignalWait;
  });
}

function runDynamicGroup(group: GroupProjection): RunDynamicGroup {
  const base: RunDynamicGroupBase = {
    groupKey: group.groupKey,
    nodeKey: group.nodeKey,
    nodeId: group.nodeId,
    status: group.status,
    ...(group.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
  };
  if (group.kind === "parallel") return { ...base, kind: "parallel", strategy: group.strategy };
  if (group.strategy === "quorum") return { ...base, kind: "fanout", strategy: "quorum", quorumCount: group.quorumCount };
  return { ...base, kind: "fanout", strategy: "all" };
}

function readRunExecutionMetadata(db: DatabaseSync, runId: string): RunExecutionMetadata[] {
  const rows = db.prepare(`
    SELECT id, attempt_id, kind, metadata_json, created_at
    FROM execution_metadata
    WHERE run_id = ?
    ORDER BY id
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => withoutUndefined({
    id: Number(row.id),
    attemptId: nullableString(row.attempt_id),
    kind: String(row.kind),
    metadata: JSON.parse(String(row.metadata_json)) as unknown,
    createdAt: String(row.created_at),
  }) as RunExecutionMetadata);
}

function readRunNodeProgress(db: DatabaseSync, runId: string): RunNodeProgress[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, attempt_id, attempt_no, kind, status, message,
      output_tail, output_total_bytes, output_truncated,
      context_json, token_usage_json, tools_json, updated_at
    FROM node_progress
    WHERE run_id = ?
    ORDER BY updated_at ASC, node_key ASC
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    attemptId: nullableString(row.attempt_id),
    attemptNo: nullableNumber(row.attempt_no),
    kind: String(row.kind),
    status: String(row.status),
    message: nullableString(row.message),
    output: row.output_tail === null ? undefined : {
      tail: String(row.output_tail),
      totalBytes: Number(row.output_total_bytes ?? 0),
      truncated: Boolean(row.output_truncated),
    },
    context: row.context_json === null ? undefined : JSON.parse(String(row.context_json)) as unknown,
    tokenUsage: row.token_usage_json === null ? undefined : JSON.parse(String(row.token_usage_json)) as unknown,
    tools: row.tools_json === null ? undefined : JSON.parse(String(row.tools_json)) as unknown,
    updatedAt: String(row.updated_at),
  }) as RunNodeProgress);
}

function runProgressVersion(db: DatabaseSync, runId: string): { version: number; updatedAt?: string } {
  const row = db.prepare("SELECT progress_version, progress_updated_at FROM runs WHERE id = ?").get(runId) as { progress_version: number; progress_updated_at: string | null } | undefined;
  return {
    version: Number(row?.progress_version ?? 0),
    ...(row?.progress_updated_at ? { updatedAt: row.progress_updated_at } : {}),
  };
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalPersistedDeadline(value: unknown, subject: string): string | undefined {
  const deadlineAt = nullableString(value);
  return deadlineAt === undefined ? undefined : persistedDeadline(deadlineAt, subject);
}

function persistedDeadline(value: string, subject: string): string {
  if (tryParsePersistedDeadline(value).isErr()) throw new Error(`${subject} has invalid persisted deadline ${JSON.stringify(value)}.`);
  return value;
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function hookJournalEntryFromRow(row: HookJournalRow): HookJournalEntry {
  return {
    id: Number(row.id),
    runId: row.run_id,
    eventSequence: Number(row.event_sequence),
    triggerOrder: Number(row.trigger_order),
    event: row.event,
    source: row.source,
    sourcePath: row.source_path,
    handlerId: row.handler_id,
    definitionHash: row.definition_hash,
    ...(row.node_key === null ? {} : { nodeKey: row.node_key }),
    status: row.status,
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.stdout === null ? {} : { stdout: row.stdout }),
    ...(row.stderr === null ? {} : { stderr: row.stderr }),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    ...(row.error === null ? {} : { error: row.error }),
    triggeredAt: row.triggered_at,
  };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function parseOptionalJson(value: unknown): unknown {
  return value === null || value === undefined ? undefined : JSON.parse(String(value));
}

function eventNodeKey(event: SchedulerEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.nodeKey === "string" ? payload.nodeKey : null;
}

function attemptResultEvent(input: AttemptCommitInput, nodeKey: string): Extract<SchedulerEvent, { type: "attempt.completed" | "attempt.failed" | "attempt.timed_out" | "attempt.cancelled" }> {
  if (input.result.status === "completed") {
    return {
      type: "attempt.completed",
      payload: {
        attemptId: input.attemptId,
        ...(input.result.output === undefined ? {} : { result: input.result.output }),
      },
    };
  }
  if (input.result.status === "timed_out") {
    return { type: "attempt.timed_out", payload: { attemptId: input.attemptId, error: input.result.error ?? { reason: input.result.reason, nodeKey } } };
  }
  if (input.result.status === "cancelled") {
    return { type: "attempt.cancelled", payload: { attemptId: input.attemptId, cancelReason: input.result.reason } };
  }
  return { type: "attempt.failed", payload: { attemptId: input.attemptId, error: input.result.error ?? { reason: input.result.reason, nodeKey }, terminalReason: input.result.reason } };
}

function instanceResultEvent(
  input: AttemptCommitInput,
  nodeKey: string,
  attemptEvent: Extract<SchedulerEvent, { type: "attempt.completed" | "attempt.failed" | "attempt.timed_out" | "attempt.cancelled" }>,
): Extract<SchedulerEvent, { type: "instance.completed" | "instance.failed" | "instance.cancelled" }> {
  if (attemptEvent.type === "attempt.completed") {
    return {
      type: "instance.completed",
      payload: {
        nodeKey,
        attemptId: input.attemptId,
        acceptedAttemptId: input.attemptId,
        ...(input.result.status === "completed" && input.result.output !== undefined ? { output: input.result.output } : {}),
      },
    };
  }
  if (attemptEvent.type === "attempt.cancelled") {
    return { type: "instance.cancelled", payload: { nodeKey, cancelReason: attemptEvent.payload.cancelReason } };
  }
  const statusReason = attemptEvent.type === "attempt.timed_out" ? "timed_out" : attemptEvent.payload.terminalReason;
  return {
    type: "instance.failed",
    payload: {
      nodeKey,
      attemptId: input.attemptId,
      error: attemptEvent.payload.error ?? { reason: input.result.status === "failed" || input.result.status === "timed_out" ? input.result.reason : "attempt_failed" },
      ...(statusReason === undefined ? {} : { statusReason }),
    },
  };
}

function matchesAttemptStartInput(input: AttemptStartInput, payload: Record<string, unknown>): boolean {
  return payload.runId === input.runId
    && payload.nodeKey === input.nodeKey
    && payload.nodeId === input.nodeId
    && payload.ownerEpoch === input.ownerEpoch
    && payload.admissionVersion === input.expectedVersion
    && (payload.deadlineAt ?? undefined) === input.deadlineAt;
}

function encodeSchedulerPayload(payload: object): string {
  return stableJsonLine({ schedulerEventVersion: 1, payload });
}

function schedulerEventDigest(events: SchedulerEvent[]): string {
  return createHash("sha256").update(stableJsonLine(events as unknown as JsonValue)).digest("hex");
}

function schedulerIntentDigest(intent: JsonValue): string {
  return createHash("sha256").update(stableJson(intent)).digest("hex");
}

function assertTargetedRetryRunOpen(
  runId: string,
  targetKey: string,
  status: SchedulerProjection["run"]["status"],
): void {
  if (status !== "completed" && status !== "canceled" && status !== "paused") return;
  throwSchedulerStoreError({
    type: "invalid-retry-target",
    runId,
    targetKey,
    status,
    message: `Cannot retry target '${targetKey}' in a ${status} run.`,
  });
}

function assertRetryDependenciesCanProgress(
  runId: string,
  targetKey: string,
  projection: SchedulerProjection,
  retryEvents: readonly SchedulerEvent[],
  dependencyMemberKeys: readonly string[],
): void {
  const retried = applySchedulerEvents(projection, retryEvents);
  const blockedDependency = targetedRetryDependencyBlocker(retried, dependencyMemberKeys);
  if (blockedDependency) {
    throwBlockedTargetedRetry(runId, targetKey, `completion dependency '${blockedDependency.memberKey}' contains an independent failure blocker`);
  }
}

function throwBlockedTargetedRetry(runId: string, targetKey: string, reason: string): never {
  throwSchedulerStoreError({
    type: "invalid-retry-target",
    runId,
    targetKey,
    status: "blocked",
    message: `Target '${targetKey}' cannot make progress because ${reason}; use run-level retry or fork.`,
  });
}

function planRetryAncestorGroups(
  runId: string,
  targetKey: string,
  projection: SchedulerProjection,
  members: readonly GroupMember[],
): { events: SchedulerEvent[]; retryDependencyMemberKeys: string[] } {
  const membersByGroup = new Map<string, GroupMember[]>();
  for (const member of Object.values(projection.groupMembers)) {
    const groupMembers = membersByGroup.get(member.groupKey) ?? [];
    groupMembers.push(member);
    membersByGroup.set(member.groupKey, groupMembers);
  }
  const events: SchedulerEvent[] = [];
  const retryDependencyMemberKeys: string[] = [];
  for (const member of members) {
    if (member.status !== "failed") {
      const detail = member.status === "cancelled" && member.terminalReason === "parent_failed"
        ? " is outside the failed completion path"
        : ` cannot be retried from ${member.status}`;
      throwSchedulerStoreError({ type: "invalid-retry-target", runId, targetKey, status: member.status, message: `Group member '${member.memberKey}'${detail}.` });
    }
    const group = projection.groups[member.groupKey];
    if (!group) throw new Error(`Group member '${member.memberKey}' references missing group '${member.groupKey}'.`);
    if (group.status === "completed" || group.status === "cancelled") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId, targetKey, status: group.status, message: `Target '${targetKey}' belongs to ${group.status} group '${group.groupKey}'.` });
    }
    const groupMembers = membersByGroup.get(member.groupKey) ?? [];
    const dependencies = groupMembers
      .filter(candidate => candidate.memberKey !== member.memberKey
        && candidate.status === "cancelled"
        && candidate.terminalReason === "parent_failed")
      .sort((left, right) => left.readinessSequence - right.readinessSequence || left.memberKey.localeCompare(right.memberKey));
    const reopenedMemberKeys = new Set([member.memberKey, ...dependencies.map(dependency => dependency.memberKey)]);
    const blocker = targetedRetryGroupBlocker(group, groupMembers, reopenedMemberKeys);
    if (blocker) {
      throwSchedulerStoreError({
        type: "invalid-retry-target",
        runId,
        targetKey,
        status: "blocked",
        message: `Target '${targetKey}' cannot make progress because group '${group.groupKey}' would immediately become ${blocker.status} (${blocker.reason}); use run-level retry or fork.`,
      });
    }
    events.push({
      type: "group.member_retry_requested",
      payload: { memberKey: member.memberKey, readinessSequence: member.readinessSequence },
    });
    for (const dependency of dependencies) {
      retryDependencyMemberKeys.push(dependency.memberKey);
    }
  }
  return { events, retryDependencyMemberKeys };
}

function assertRetryableAncestorFrames(
  runId: string,
  targetKey: string,
  projection: SchedulerProjection,
  frameKey: string | undefined,
): void {
  const seen = new Set<string>();
  for (let current = frameKey; current !== undefined;) {
    if (seen.has(current)) throw new Error(`Retry target '${targetKey}' has cyclic frame ancestry at '${current}'.`);
    seen.add(current);
    const frame = projection.frames[current];
    if (!frame) throw new Error(`Retry target '${targetKey}' references missing ancestor frame '${current}'.`);
    if (frame.status === "completed" || frame.status === "cancelled") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId, targetKey, status: frame.status, message: `Target '${targetKey}' belongs to ${frame.status} frame '${frame.frameKey}'.` });
    }
    if (frame.status !== "running" && frame.status !== "failed") {
      throw new Error(`Retry target '${targetKey}' has non-runnable ancestor frame '${frame.frameKey}' in status '${frame.status}'.`);
    }
    current = frame.parentFrameKey;
  }
}

function retryTargetKey(target: string, snapshot: SchedulerSnapshot): Result<string, SchedulerStoreError> {
  if (target !== "root" && (snapshot.projection.instances[target] || snapshot.projection.frames[target])) return ok(target);
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && instance.status === "failed")
    .map(instance => instance.nodeKey);
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame => (frame.frameKind === "node" || frame.frameKind === "loop") && frame.nodeId === target && frame.status === "failed")
    .map(frame => frame.frameKey);
  const matches = [...instanceMatches, ...frameMatches].sort();
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length > 1) return err({
    type: "ambiguous-retry-target",
    runId: snapshot.runId,
    targetKey: target,
    candidateKeys: matches,
    message: `Scheduler retry target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`,
  });
  if (target === "root" && snapshot.projection.frames.root) return ok("root");
  return ok(target);
}

function cancelTargetKey(target: string, snapshot: SchedulerSnapshot): Result<string, SchedulerStoreError> {
  if (target !== "root" && (snapshot.projection.instances[target] || snapshot.projection.frames[target])) return ok(target);
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && !isTerminalStatus(instance.status))
    .map(instance => instance.nodeKey);
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame => (frame.frameKind === "node" || frame.frameKind === "loop") && frame.nodeId === target && !isTerminalStatus(frame.status))
    .map(frame => frame.frameKey);
  const matches = [...instanceMatches, ...frameMatches].sort();
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length > 1) return err({
    type: "ambiguous-cancel-target",
    runId: snapshot.runId,
    targetKey: target,
    candidateKeys: matches,
    message: `Scheduler cancel target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`,
  });
  if (target === "root" && snapshot.projection.frames.root) return ok("root");
  return ok(target);
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function schedulerEventIdempotencyKey(runId: string, commitKey: string, index: number): string {
  const digest = createHash("sha256").update(commitKey).digest("hex");
  return `scheduler-event:${runId}:${digest}:${index}`;
}

function derivedIdempotencyKey(idempotencyKey: string, suffix: string): string {
  return `${idempotencyKey}:${suffix}`;
}

const RUNTIME_STORE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";
let databaseSyncConstructor: typeof import("node:sqlite").DatabaseSync | undefined;

export function isRuntimeStoreBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_LOCKED") return true;
  return candidate.code === "ERR_SQLITE_ERROR" && (candidate.errcode === 5 || candidate.errcode === 6);
}

function openDatabase(path: string, readOnly = false): DatabaseSync {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, readOnly, timeout: RUNTIME_STORE_BUSY_TIMEOUT_MS });
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
  if (databaseSyncConstructor) return databaseSyncConstructor;

  const emitWarning = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqliteExperimental(this: NodeJS.Process, ...args: unknown[]): void {
    if (args[0] === SQLITE_EXPERIMENTAL_WARNING && args[1] === "ExperimentalWarning") return;
    Reflect.apply(emitWarning, this, args);
  } as typeof process.emitWarning;
  try {
    databaseSyncConstructor = (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
    return databaseSyncConstructor;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_lease (
      workspace_realpath TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      pid INTEGER,
      heartbeat_at TEXT,
      idle_since_at TEXT,
      idle_stop_ms INTEGER,
      protocol_version INTEGER NOT NULL,
      package_version TEXT NOT NULL,
      node_version TEXT NOT NULL,
      exec_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      workflow_entry TEXT NOT NULL,
      source_graph_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      progress_version INTEGER NOT NULL DEFAULT 0,
      progress_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      workflow_ir_path TEXT NOT NULL,
      workflow_ir_digest TEXT NOT NULL,
      input_json TEXT NOT NULL,
      agent_overrides_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      lock_path TEXT NOT NULL,
      lock_digest TEXT NOT NULL,
      package_lock_digest TEXT,
      run_dir TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      node_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(run_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS scheduler_commits (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      event_digest TEXT NOT NULL,
      intent_digest TEXT,
      PRIMARY KEY (run_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS node_states (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduler_projection_checkpoints (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL,
      projection_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduler_frames (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      frame_key TEXT NOT NULL,
      parent_frame_key TEXT,
      node_key TEXT,
      node_id TEXT,
      frame_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT,
      terminal_reason TEXT,
      instance_path_json TEXT,
      scope_json TEXT NOT NULL,
      loop_json TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, frame_key)
    );

    CREATE TABLE IF NOT EXISTS node_instances (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      parent_frame_key TEXT,
      instance_path_json TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      readiness_sequence INTEGER,
      output_json TEXT,
      error_json TEXT,
      accepted_attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS node_attempts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT PRIMARY KEY,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      deadline_at TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      error_json TEXT,
      terminal_reason TEXT,
      cancel_reason TEXT,
      UNIQUE(run_id, node_key, attempt_no)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_kind TEXT NOT NULL,
      branch_id TEXT,
      item_index INTEGER,
      item_json TEXT,
      child_frame_key TEXT,
      status TEXT NOT NULL,
      readiness_sequence INTEGER NOT NULL,
      completion_sequence INTEGER,
      accepted_rank INTEGER,
      terminal_reason TEXT,
      output_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, member_key)
    );

    CREATE TABLE IF NOT EXISTS signal_waits (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      deadline_at TEXT,
      timeout_message TEXT,
      timeout_remaining_ms INTEGER,
      rendered_prompt TEXT,
      consumed_at TEXT,
      terminal_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS execution_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_progress (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT,
      attempt_no INTEGER,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      output_tail TEXT,
      output_total_bytes INTEGER,
      output_truncated INTEGER,
      context_json TEXT,
      token_usage_json TEXT,
      tools_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS hook_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL,
      trigger_order INTEGER NOT NULL,
      event TEXT NOT NULL,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      handler_id TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      node_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'timed_out')),
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      duration_ms INTEGER,
      error TEXT,
      triggered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_dispatch_cursors (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_run_leases_expires ON run_leases(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_scheduler_frames_parent_status ON scheduler_frames(run_id, parent_frame_key, status);
    CREATE INDEX IF NOT EXISTS idx_node_instances_node_status ON node_instances(run_id, node_id, status);
    CREATE INDEX IF NOT EXISTS idx_node_instances_frame_status ON node_instances(run_id, parent_frame_key, status);
    CREATE INDEX IF NOT EXISTS idx_node_attempts_owner_status ON node_attempts(run_id, owner_epoch, status);
    CREATE INDEX IF NOT EXISTS idx_node_attempts_deadline_status ON node_attempts(run_id, deadline_at, status);
    CREATE INDEX IF NOT EXISTS idx_group_members_ready ON group_members(run_id, group_key, readiness_sequence);
    CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(run_id, group_key, status);
    CREATE INDEX IF NOT EXISTS idx_signal_waits_status ON signal_waits(run_id, node_key, status);
    CREATE INDEX IF NOT EXISTS idx_signal_waits_deadline_status ON signal_waits(run_id, deadline_at, status);
    CREATE INDEX IF NOT EXISTS idx_node_progress_run_updated ON node_progress(run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_hook_journal_run_id ON hook_journal(run_id);
    CREATE INDEX IF NOT EXISTS idx_hook_journal_triggered_at ON hook_journal(triggered_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_journal_event_handler
      ON hook_journal(run_id, event_sequence, definition_hash);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT,
      attempt INTEGER,
      media_type TEXT,
      digest TEXT NOT NULL,
      size INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO hook_dispatch_cursors (run_id, event_sequence)
    SELECT runs.id, COALESCE(MAX(run_events.sequence), 0)
    FROM runs
    LEFT JOIN run_events ON run_events.run_id = runs.id
    LEFT JOIN hook_dispatch_cursors ON hook_dispatch_cursors.run_id = runs.id
    WHERE hook_dispatch_cursors.run_id IS NULL
    GROUP BY runs.id;
  `);
}

function parseAgentOverrides(json: string): AgentOverrideMap {
  return parseAgentOverrideMap(JSON.parse(json) as unknown);
}

export function tryValidateAgentOverrides(ir: WorkflowIR, input: AgentOverrideMap | undefined): Result<AgentOverrideMap, AgentOverrideValidationFailure> {
  if (input === undefined) return ok({});
  return tryParseAgentOverrideMap(input, ir.agents).map(parsed => normalizeAgentOverrides(ir, parsed));
}

function normalizeAgentOverrides(ir: WorkflowIR, input: AgentOverrideMap | undefined, inherited: AgentOverrideMap = {}): AgentOverrideMap {
  const base = Object.fromEntries(Object.entries(inherited).filter(([name]) => ir.agents[name])) as AgentOverrideMap;
  if (input === undefined) return base;
  const incoming = parseAgentOverrideMap(input, ir.agents);
  const merged = Object.fromEntries(Object.entries(incoming).map(([name, override]) => {
    const previous = base[name] ?? {};
    const declared = ir.agents[name]!;
    return [name, mergeAgentOverride(declared, previous, override)];
  }));
  return { ...base, ...merged };
}

function mergeAgentOverride(declared: AgentDefinitionIR, previous: AgentOverrideSpec, incoming: AgentOverrideSpec): AgentOverrideSpec {
  const before = agentIdentity(declared, previous);
  const after = agentIdentity(declared, { ...previous, ...incoming });
  const changedIdentity = incoming.use !== undefined || incoming.command !== undefined
    ? before.kind !== after.kind || before.value !== after.value
    : false;
  const merged = changedIdentity
    ? { ...previous, model: undefined, agentMode: undefined, ...incoming }
    : { ...previous, ...incoming };
  if (incoming.use !== undefined) delete merged.command;
  if (incoming.command !== undefined) delete merged.use;
  return compactUndefined(merged) as AgentOverrideSpec;
}

function withAgentOverrides(ir: WorkflowIR, overrides: AgentOverrideMap): WorkflowIR {
  if (Object.keys(overrides).length === 0) return ir;
  return {
    ...ir,
    agents: Object.fromEntries(Object.entries(ir.agents).map(([name, definition]) => [
      name,
      applyAgentOverride(definition, overrides[name]),
    ])),
  };
}

function applyAgentOverride(definition: AgentDefinitionIR, override: AgentOverrideSpec | undefined): AgentDefinitionIR {
  if (!override) return definition;
  const identityChanged = override.use !== undefined || override.command !== undefined
    ? agentIdentity(definition, {}).kind !== agentIdentity(definition, override).kind
      || agentIdentity(definition, {}).value !== agentIdentity(definition, override).value
    : false;
  const shared = {
    model: override.model ?? (identityChanged ? undefined : definition.model),
    permissionMode: override.permissionMode ?? definition.permissionMode,
    agentMode: override.agentMode ?? (identityChanged ? undefined : definition.agentMode),
    trace: definition.trace,
    cwd: override.cwd ?? definition.cwd,
    env: override.env ?? definition.env,
  };
  if (override.command !== undefined) return compactUndefined({ kind: "agent_command", command: override.command, ...shared }) as AgentDefinitionIR;
  if (override.use !== undefined) return compactUndefined({ kind: "agent_definition", use: override.use, ...shared }) as AgentDefinitionIR;
  return compactUndefined({ ...definition, ...shared }) as AgentDefinitionIR;
}

function agentIdentity(definition: AgentDefinitionIR, override: AgentOverrideSpec): { kind: "use" | "command"; value: string } {
  if (override.command !== undefined) return { kind: "command", value: override.command };
  if (override.use !== undefined) return { kind: "use", value: override.use };
  return definition.kind === "agent_command"
    ? { kind: "command", value: definition.command }
    : { kind: "use", value: definition.use };
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

function inheritableCompletedNodeKeys(ir: WorkflowIR, completed: Set<string>): Set<string> {
  const ancestors = nodeAncestors(ir.root);
  return new Set([...completed].filter(nodeKey => (ancestors.get(nodeKey) ?? []).every(parent => completed.has(parent))));
}

function nodeAncestors(scope: ScopeIR): Map<string, string[]> {
  return new Map(Array.from(walkNodes(scope), ({ node, ancestry }) => [
    node.id,
    ancestry.map(({ owner }) => owner.id),
  ] as const));
}

function nodeSignatures(scope: ScopeIR): Map<string, string> {
  return new Map(Array.from(walkNodes(scope), ({ node }) => [node.id, stableJsonLine(node)] as const));
}

export function tryValidatePreparedRunWorkflow(cwd: string, prepared: PreparedRunWorkflow): Result<PreparedRunWorkflow, PreparedRunValidationFailure> {
  let ir: unknown;
  try {
    ir = JSON.parse(prepared.irJson);
  } catch {
    return preparedInvalid("invalid-ir-json", "Prepared workflow IR JSON is invalid.");
  }
  if (stableJsonLine(ir) !== stableJsonLine(prepared.ir)) {
    return preparedInvalid("ir-mismatch", "Prepared workflow IR JSON does not match prepared IR.");
  }
  if (digest(Buffer.from(prepared.irJson)) !== prepared.lock.ir.digest) {
    return preparedInvalid("ir-digest-mismatch", "Prepared workflow lock IR digest does not match IR JSON.");
  }
  if (prepared.lock.sourceGraphDigest !== prepared.sourceGraphDigest) {
    return preparedInvalid("source-graph-mismatch", "Prepared workflow lock source graph digest does not match prepared source graph digest.");
  }
  const hasPackageLockDigest = Object.prototype.hasOwnProperty.call(prepared, "packageLockDigest");
  const lockHasPackageLockDigest = Object.prototype.hasOwnProperty.call(prepared.lock, "packageLockDigest");
  if (hasPackageLockDigest !== lockHasPackageLockDigest || prepared.packageLockDigest !== prepared.lock.packageLockDigest) {
    return preparedInvalid("package-lock-mismatch", "Prepared workflow lock package lock digest does not match prepared package lock digest.");
  }
  const sourceGraphDigest = digest(Buffer.from([prepared.lock.workflow.sourceDigest, prepared.packageLockDigest ?? ""].join("\n")));
  if (prepared.sourceGraphDigest !== sourceGraphDigest) {
    return preparedInvalid("source-graph-mismatch", "Prepared workflow source graph digest does not match workflow and package lock digests.");
  }
  const workflowEntry = relative(resolve(cwd), resolve(cwd, prepared.workflowPath));
  if (prepared.lock.workflow.entry !== workflowEntry) {
    return preparedInvalid("entry-mismatch", "Prepared workflow lock entry does not match prepared workflow path.");
  }
  return ok({ ...prepared, ir: ir as WorkflowIR });
}

function preparedInvalid(reason: PreparedRunValidationFailure["reason"], message: string): Result<never, PreparedRunValidationFailure> {
  return err({ type: "prepared-workflow-invalid", reason, message });
}

function stableJsonLine(value: unknown): string {
  return `${stableJson(value)}\n`;
}

function assertJsonValue(value: unknown, path: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${path} is not JSON-serializable.`);
  return value;
}

function evaluateRecordedOutput(output: ExprIR, nodes: Record<string, unknown>, input: JsonValue, meta: Record<string, string>): JsonValue {
  return normalizeWorkflowData(evaluateExpr(output, {
    input,
    meta,
    nodes: Object.fromEntries(Object.entries(nodes).map(([nodeKey, value]) => [nodeKey, { status: "completed", output: value }])),
  }), "fork output") as JsonValue;
}

function forkCompletedOutputJson(args: {
  output: ExprIR;
  completedOutputRows: Array<{ nodeKey: string; nodeId: string; output: unknown }>;
  inheritableNodeKeys: Set<string>;
  inputJson: string;
  meta: Record<string, string>;
  sourceRunId: string;
  forkRunId: string;
  artifactIdMap: Record<string, string>;
}): Result<string, ArtifactRewriteFailure> {
  const rows: Array<{ nodeKey: string; nodeId: string; output: JsonValue }> = [];
  for (const row of args.completedOutputRows) {
    if (!args.inheritableNodeKeys.has(row.nodeKey)) continue;
    const rewritten = rewriteArtifactValue(assertJsonValue(row.output, `fork node '${row.nodeKey}' output`), args.sourceRunId, args.forkRunId, args.artifactIdMap);
    if (rewritten.isErr()) return err(rewritten.error);
    rows.push({ ...row, output: rewritten.value });
  }
  const nodes = completedOutputMap(rows);
  const output = evaluateRecordedOutput(args.output, nodes, JSON.parse(args.inputJson) as JsonValue, args.meta);
  return rewriteArtifactRefs(stableJsonLine(output), args.sourceRunId, args.forkRunId, args.artifactIdMap);
}

function completedSchedulerOutputRows(db: DatabaseSync, runId: string): Array<{ nodeKey: string; nodeId: string; output: unknown }> {
  const nodeRows = db.prepare(`
    SELECT node_key, node_id, output_json
    FROM node_states
    WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
  `).all(runId) as Array<{ node_key: unknown; node_id: unknown; output_json: unknown }>;
  const frameRows = db.prepare(`
    SELECT frame_key, node_id, result_json
    FROM scheduler_frames
    WHERE run_id = ?
      AND status = 'completed'
      AND frame_kind IN ('node', 'loop')
      AND node_id IS NOT NULL
      AND result_json IS NOT NULL
  `).all(runId) as Array<{ frame_key: unknown; node_id: unknown; result_json: unknown }>;
  return [
    ...nodeRows.map(row => ({
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      output: JSON.parse(String(row.output_json)) as unknown,
    })),
    ...frameRows.map(row => ({
      nodeKey: String(row.frame_key),
      nodeId: String(row.node_id),
      output: JSON.parse(String(row.result_json)) as unknown,
    })),
  ];
}

function completedOutputMap(rows: Array<{ nodeKey: string; nodeId: string; output: unknown }>): Record<string, unknown> {
  const byKey = Object.fromEntries(rows.map(row => [row.nodeKey, row.output]));
  const byId = new Map<string, Array<{ nodeKey: string; output: unknown }>>();
  for (const row of rows) byId.set(row.nodeId, [...byId.get(row.nodeId) ?? [], { nodeKey: row.nodeKey, output: row.output }]);
  for (const [nodeId, matches] of byId) {
    if (matches.length === 1 && byKey[nodeId] === undefined) byKey[nodeId] = matches[0]!.output;
  }
  return byKey;
}

function rewriteArtifactRefs(json: string, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): Result<string, ArtifactRewriteFailure> {
  const value = JSON.parse(json) as JsonValue;
  return rewriteArtifactValue(value, sourceRunId, forkRunId, artifactIds).map(stableJsonLine);
}

function rewriteForkSeedPlan(
  plan: ForkSeedPlan,
  sourceRunId: string,
  forkRunId: string,
  artifactIds: Record<string, string>,
): Result<ForkSeedPlan, ArtifactRewriteFailure> {
  const events: SchedulerEvent[] = [];
  for (const event of plan.events) {
    const payload = rewriteArtifactValue(event.payload as JsonValue, sourceRunId, forkRunId, artifactIds);
    if (payload.isErr()) return err(payload.error);
    events.push({ ...event, payload: payload.value } as SchedulerEvent);
  }
  return ok({ ...plan, events });
}

function requireArtifactId(map: Record<string, string>, sourceId: string): string {
  const id = map[sourceId];
  if (!id) throw new Error(`Missing fork artifact id for '${sourceId}'.`);
  return id;
}

function reachableInheritedArtifactIds(args: {
  runId: string;
  outputJson: string | null;
  nodeRows: Array<Record<string, unknown>>;
  inheritableNodeKeys: Set<string>;
}): Set<string> {
  const ids = new Set<string>();
  if (args.outputJson) collectArtifactIds(JSON.parse(args.outputJson) as JsonValue, args.runId, ids);
  for (const row of args.nodeRows) {
    if (!args.inheritableNodeKeys.has(String(row.node_key)) || !row.output_json) continue;
    collectArtifactIds(JSON.parse(String(row.output_json)) as JsonValue, args.runId, ids);
  }
  return ids;
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

async function publishRunDirectory(input: {
  cwd: string;
  stagedRunDir: string;
  runDir: string;
  populate(stagingDir: string): Promise<void>;
}): Promise<void> {
  const expectedRunsRoot = resolve(input.cwd, localStateRoot, "runs");
  await mkdir(expectedRunsRoot, { recursive: true });
  const runsRoot = containedRunsRoot(input.cwd);
  if (resolve(dirname(input.stagedRunDir)) !== runsRoot || resolve(dirname(input.runDir)) !== runsRoot) {
    throw new Error(`Run directory must be inside ${localStateRoot}/runs.`);
  }
  await mkdir(input.stagedRunDir);
  try {
    await input.populate(input.stagedRunDir);
    await requireMissingPath(input.runDir);
    await rename(input.stagedRunDir, input.runDir);
  } catch (error) {
    await removeOwnedPathAfterFailure(input.stagedRunDir, error);
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

async function copyVerifiedArtifacts(sourceRunDir: string, stagingRunDir: string, artifacts: ArtifactRow[]): Promise<void> {
  const sourceArtifactRoot = resolve(sourceRunDir, "artifacts");
  if (artifacts.length > 0) {
    const info = await lstat(sourceArtifactRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Fork artifact '${String(artifacts[0]!.id)}' has invalid relative path.`);
    }
  }
  for (const artifact of artifacts) {
    const relativePath = String(artifact.relative_path);
    const sourcePath = resolve(sourceRunDir, relativePath);
    const stagingArtifactRoot = resolve(stagingRunDir, "artifacts");
    const destination = resolve(stagingRunDir, relativePath);
    if (
      isAbsolute(relativePath)
      || sourcePath === sourceArtifactRoot
      || destination === stagingArtifactRoot
      || !isContainedPath(sourceArtifactRoot, sourcePath)
      || !isContainedPath(stagingArtifactRoot, destination)
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
    const expectedSize = Number(artifact.size);
    const expectedDigest = String(artifact.digest);
    const actualDigest = digest(bytes);
    if (bytes.byteLength !== expectedSize || actualDigest !== expectedDigest) {
      throw new Error(`Fork artifact '${String(artifact.id)}' failed source verification.`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function writeFrozenRunFiles(runDir: string, workflowIrJson: string, lockJson: string): Promise<void> {
  await writeFile(join(runDir, "workflow.ir.json"), workflowIrJson);
  await writeFile(join(runDir, "lock.json"), lockJson);
}

async function verifyFrozenRunFiles(runDir: string, lockJson: string, workflowIrJson: string): Promise<void> {
  const irBytes = await readContainedFile(runDir, "workflow.ir.json");
  const lock = JSON.parse(lockJson) as RunWorkflowLockArtifact;
  if (digest(irBytes) !== lock.ir.digest) throw new Error("Fork workflow.ir.json failed copy verification.");
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

function frozenWorkflowIrJson(cwd: string, row: Pick<RunInputRow, "workflow_ir_path" | "workflow_ir_digest" | "run_dir">): string {
  return readFrozenRunFile(cwd, row, row.workflow_ir_path, row.workflow_ir_digest, "workflow IR");
}

function frozenLockJson(cwd: string, row: Pick<RunInputRow, "lock_path" | "lock_digest" | "run_dir">): string {
  return readFrozenRunFile(cwd, row, row.lock_path, row.lock_digest, "workflow lock");
}

function readFrozenRunFile(cwd: string, row: Pick<RunInputRow, "run_dir">, path: string, expectedDigest: string, label: string): string {
  const runDir = containedRunDir(cwd, row.run_dir);
  const bytes = readContainedFileSync(runDir, path);
  if (digest(bytes) !== expectedDigest) throw new Error(`Frozen ${label} digest mismatch.`);
  return bytes.toString("utf8");
}

function readContainedFileSync(root: string, relativePath: string): Buffer {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, relativePath);
  if (!isContainedPath(rootPath, absolutePath)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  const info = lstatSync(absolutePath);
  if (info.isSymbolicLink()) throw new PathEscapeError(`Path '${relativePath}' is a symbolic link.`);
  if (!info.isFile()) throw new PathEscapeError(`Path '${relativePath}' is not a file.`);
  const real = realpathSync(absolutePath);
  const realRoot = realpathSync(rootPath);
  if (!isContainedPath(realRoot, real)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  return readFileSync(absolutePath);
}

function forkRequestFingerprint(runId: string, options: ControlOptions): string {
  return stableJsonLine({
    runId,
    ...(options.prepared === undefined ? {} : {
      prepared: {
        workflowPath: options.prepared.workflowPath,
        irFileDigest: options.prepared.lock.ir.digest,
        sourceGraphDigest: options.prepared.sourceGraphDigest,
        ...(options.prepared.packageLockDigest === undefined ? {} : { packageLockDigest: options.prepared.packageLockDigest }),
      },
    }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.agentOverrides === undefined ? {} : { agentOverrides: options.agentOverrides }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.unsafeReuse === true ? { unsafeReuse: true } : {}),
  });
}

class PathEscapeError extends Error {}

function containedRunDir(cwd: string, runDir: string): string {
  const runsRoot = containedRunsRoot(cwd);
  const absolute = resolve(cwd, runDir);
  if (dirname(absolute) !== runsRoot || !runIdPattern.test(basename(absolute))) {
    throw new Error(`Run directory '${runDir}' is outside ${localStateRoot}/runs.`);
  }
  const info = lstatSync(absolute);
  const realRunsRoot = realpathSync(runsRoot);
  const realRunDir = realpathSync(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || dirname(realRunDir) !== realRunsRoot) {
    throw new Error(`Run directory '${runDir}' is outside ${localStateRoot}/runs.`);
  }
  return absolute;
}

function containedRunsRoot(cwd: string): string {
  const runsRoot = resolve(cwd, localStateRoot, "runs");
  const info = lstatSync(runsRoot);
  const realWorkspace = realpathSync(resolve(cwd));
  const realRunsRoot = realpathSync(runsRoot);
  if (info.isSymbolicLink() || !info.isDirectory() || !isContainedPath(realWorkspace, realRunsRoot)) {
    throw new Error(`Run directory root '${join(localStateRoot, "runs")}' is outside the workspace.`);
  }
  return runsRoot;
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function isStalePath(path: string, olderThanMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs >= olderThanMs;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function removeOwnedPathAfterFailure(path: string, failure: unknown): Promise<never> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], `Operation failed and owned path '${path}' could not be removed.`);
  }
  throw failure;
}

function rollbackAfterFailure(db: DatabaseSync, transactionStarted: boolean, failure: unknown): unknown {
  if (!transactionStarted) return failure;
  try {
    db.exec("ROLLBACK");
    return failure;
  } catch (rollbackError) {
    return new AggregateError([failure, rollbackError], "Operation failed and its database transaction could not be rolled back.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
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

function throwSchedulerStoreError(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
}

function requireActiveOwnerEpoch(db: DatabaseSync, runId: string, ownerEpoch: number): void {
  const row = db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
  const now = new Date().toISOString();
  if (!row || row.owner_epoch !== ownerEpoch || row.released_at !== null || row.lease_expires_at <= now) {
    throwSchedulerStoreError({ type: "owner-epoch-inactive", runId, ownerEpoch, message: `Run '${runId}' scheduler owner epoch is not active.` });
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
