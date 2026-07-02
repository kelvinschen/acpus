import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentDefinitionIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import type { ExprIR, JsonValue } from "@acpus/expression/ir";
import { valueToExprIR } from "@acpus/expression/ir";
import { evaluateExpr } from "../evaluation/evaluator.js";
import { applySchedulerEvents, cancellationEventsForFrame, cancellationEventsForNode, createSchedulerProjection } from "../scheduler/transitions.js";
import { ancestorGroupMembersForFrame, ancestorGroupMembersForNode } from "../scheduler/membership.js";
import type { SchedulerEvent } from "../scheduler/events.js";
import { SchedulerStoreException, schedulerStoreResult, type RunOwnerClaim, type SchedulerCancelInput, type SchedulerCommit, type SchedulerSnapshot, type SchedulerStorePort, type AttemptStartInput, type AttemptCommitInput, type SignalConsumeInput, type SchedulerPauseInput, type SchedulerResumeInput, type SchedulerRetryInput, type SchedulerRunRetryInput, type SchedulerStoreError, type SchedulerStoreResult } from "../scheduler/store-port.js";
import type { InstancePath, SchedulerProjection } from "../scheduler/types.js";

export type RunStatus = "pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled";

export type RuntimeStore = {
  scheduler: SchedulerStorePort;
  close(): void;
  admitRun(input: AdmitRunInput): Promise<RunRecord>;
  completeRun(input: CompleteRunInput): RunRecord;
  persistCompletedNodes(input: PersistCompletedNodesInput): RunRecord;
  blockRun(input: BlockRunInput): RunRecord;
  failRun(input: FailRunInput): RunRecord;
  awaitSignal(input: AwaitSignalInput): RunRecord;
  signalRun(input: SignalRunInput): RunRecord;
  getSignalPayloads(runId: string): Record<string, unknown>;
  getCompletedNodeOutputs(runId: string): Record<string, unknown>;
  getFrozenRun(runId: string): FrozenRun | undefined;
  replayRun(runId: string): ReplayResult;
  claimSupervisor(input: ClaimSupervisorInput): SupervisorLease;
  heartbeatSupervisor(input: HeartbeatSupervisorInput): boolean;
  releaseSupervisor(input: HeartbeatSupervisorInput): boolean;
  releaseRunOwner(runId: string, ownerId: string): boolean;
  submitCommand(input: SubmitRunControlCommandInput): PendingRunControlCommand;
  submitCommand(input: SubmitSupervisorCommandInput): PendingSupervisorCommand;
  submitCommand(input: SubmitCommandInput): PendingControlCommand;
  getCommand(commandId: string): PendingControlCommand | undefined;
  claimCommand(commandId: string, options?: ClaimCommandOptions): boolean;
  deferCommand(commandId: string): void;
  recoverStaleCommands(options?: RecoverStaleCommandsOptions): number;
  listPendingCommands(): PendingControlCommand[];
  listRunnableRuns(): RunRecord[];
  finishCommand(input: FinishCommandInput): void;
  pauseRun(runId: string, options?: ControlOptions): RunRecord;
  resumeRun(runId: string, options?: ControlOptions): RunRecord;
  retryRun(runId: string, options?: ControlOptions): RunRecord;
  forkRun(runId: string, options?: ControlOptions): Promise<RunRecord>;
  cleanupRunDirectories(options?: CleanupRunDirectoriesOptions): Promise<CleanupRunDirectoriesResult>;
  getRunDir(runId: string): string | undefined;
  registerArtifact(input: RegisterArtifactInput): void;
  writeExecutionMetadata(input: WriteExecutionMetadataInput): void;
  getRun(runId: string): RunDetails | undefined;
  listRuns(): RunRecord[];
  getRuntimeDiagnostics(): RuntimeDiagnostics;
};

export type AdmitRunInput = {
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  cwd: string;
  agentOverrides?: AgentOverrideMap;
};

export type AgentOverrideMap = Record<string, AgentOverrideSpec>;

export type AgentOverrideSpec = {
  use?: string;
  command?: string;
  model?: string;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  agentMode?: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type RunWorkflowLockArtifact = {
  kind: "acpus_preflight_lock";
  version: 1;
  workflow: {
    entry: string;
    sourceDigest?: string;
  };
  ir: {
    path: "workflow.ir.json";
    digest: string;
  };
  packageLockDigest?: string;
  sourceGraphDigest: string;
  generatedAt: string;
};

export type PreparedRunWorkflow = {
  workflowPath: string;
  ir: WorkflowIR;
  irJson: string;
  irDigest: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: RunWorkflowLockArtifact;
};

export type RunRecord = {
  id: string;
  name: string;
  status: RunStatus;
  workflowEntry: string;
  irDigest: string;
  sourceGraphDigest: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDetails = RunRecord & {
  input: JsonValue;
  output?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  eventCount: number;
  nodeCount: number;
  dynamic?: RunDynamicDetails;
};

export type RuntimeDiagnostics = {
  supervisor?: SupervisorDiagnostics;
  commands: {
    pending: number;
    running: number;
    failed: number;
    oldestPendingAt?: string;
  };
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
    activeForeground: number;
    stale: number;
  };
};

export type SupervisorDiagnostics = {
  workspaceRealpath: string;
  generation: number;
  pid?: number;
  heartbeatAt?: string;
  protocolVersion: number;
  packageVersion: string;
  nodeVersion: string;
  execPath: string;
  updatedAt: string;
};

export type RunDynamicDetails = {
  version: number;
  frames: RunDynamicFrame[];
  nodeInstances: RunDynamicNodeInstance[];
  attempts: RunDynamicAttempt[];
  groupMembers: RunDynamicGroupMember[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
};

export type RunExecutionMetadata = {
  id: number;
  attemptId?: string;
  kind: string;
  metadata: unknown;
  createdAt: string;
};

export type RunDynamicFrame = {
  frameKey: string;
  parentFrameKey?: string;
  nodeKey?: string;
  nodeId?: string;
  instancePath?: InstancePath;
  frameKind: string;
  status: string;
  strategy?: string;
  terminalReason?: string;
  result?: unknown;
  error?: unknown;
};

export type RunDynamicNodeInstance = {
  nodeKey: string;
  nodeId: string;
  parentFrameKey?: string;
  instancePath?: InstancePath;
  status: string;
  statusReason?: string;
  output?: unknown;
  error?: unknown;
  acceptedAttemptId?: string;
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
};

export type RunDynamicGroupMember = {
  groupKey: string;
  memberKey: string;
  memberKind: string;
  branchId?: string;
  itemKey?: string;
  itemIndex?: number;
  item?: unknown;
  childFrameKey?: string;
  status: string;
  completionSequence?: number;
  acceptedRank?: number;
  terminalReason?: string;
  output?: unknown;
  error?: unknown;
};

export type RunDynamicSignalWait = {
  nodeKey: string;
  nodeId: string;
  status: string;
  deadlineAt?: string;
  terminalReason?: string;
};

export type CompleteRunInput = {
  runId: string;
  output: JsonValue;
  nodes: Record<string, { status: "completed"; output: unknown }>;
};

export type PersistCompletedNodesInput = {
  runId: string;
  nodes: Record<string, { status: "completed"; output: unknown }>;
};

export type BlockRunInput = {
  runId: string;
  nodeKey: string;
  message: string;
};

export type FailRunInput = {
  runId: string;
  message: string;
  nodeKey?: string;
};

export type AwaitSignalInput = {
  runId: string;
  nodeKey: string;
  nodes: Record<string, { status: "completed"; output: unknown }>;
};

export type SignalRunInput = {
  runId: string;
  nodeKey: string;
  payload: JsonValue;
};

export type FrozenRun = {
  ir: WorkflowIR;
  input: JsonValue;
  agentOverrides: AgentOverrideMap;
  meta: Record<string, string>;
};

export type ClaimSupervisorInput = {
  workspaceRealpath: string;
  pid: number;
  endpoint?: string;
  tokenHash?: string;
  protocolVersion: number;
  packageVersion: string;
  nodeVersion: string;
  execPath: string;
  staleAfterMs: number;
};

export type HeartbeatSupervisorInput = {
  workspaceRealpath: string;
  generation: number;
};

export type SupervisorLease = {
  workspaceRealpath: string;
  generation: number;
  pid: number;
  heartbeatAt: string;
};

export type ReplayResult = {
  ok: boolean;
  runId: string;
  expected?: JsonValue;
  actual?: JsonValue;
  artifacts?: {
    checked: number;
    missing: Array<{ id: string; relativePath: string }>;
    invalid: Array<{ id: string; relativePath: string; message: string }>;
    mismatched: Array<{ id: string; relativePath: string; expectedDigest: string; actualDigest?: string; expectedSize: number; actualSize?: number }>;
  };
  projection?: {
    issues: string[];
  };
};

export type RunControlCommandType = "pause" | "resume" | "retry" | "fork" | "signal" | "cancel";
export type SupervisorCommandType = "shutdown";
export type ControlCommandType = RunControlCommandType | SupervisorCommandType;
export type ControlCommandStatus = "pending" | "running" | "applied" | "failed";
export type PauseCommandPayload = { reason?: string };
export type EmptyCommandPayload = Record<string, never>;
export type RetryCommandPayload = { target?: string };
export type CancelCommandPayload = { target?: string };
export type ForkCommandPayload = { prepared?: JsonValue; input?: JsonValue; agentOverrides?: JsonValue };
export type SignalCommandPayload = { node: string; payload?: JsonValue };
export type AppliedCommandPayload = { status: string; forkRunId?: string; targetKey?: string };
export type FailedCommandPayload = { type: string; message: string };

type CommandPayload<T extends ControlCommandType> =
  T extends "pause" ? PauseCommandPayload
    : T extends "resume" ? EmptyCommandPayload
      : T extends "retry" ? RetryCommandPayload
        : T extends "cancel" ? CancelCommandPayload
          : T extends "fork" ? ForkCommandPayload
            : T extends "signal" ? SignalCommandPayload
              : EmptyCommandPayload;

type ControlCommandBase<T extends ControlCommandType> = {
  id: string;
  type: T;
  idempotencyKey: string;
};

export type ControlCommand =
  | { [T in RunControlCommandType]: ControlCommandBase<T> & { runId: string; status: ControlCommandStatus } }[RunControlCommandType]
  | (ControlCommandBase<"shutdown"> & { runId?: undefined; status: ControlCommandStatus });

type CommandStatePayload<T extends ControlCommandType> =
  | { status: "pending" | "running"; payload: CommandPayload<T> }
  | { status: "applied"; payload: AppliedCommandPayload }
  | { status: "failed"; payload: FailedCommandPayload };

export type PendingControlCommand =
  | PendingRunControlCommand
  | PendingSupervisorCommand;

export type PendingRunControlCommand = {
  [T in RunControlCommandType]: ControlCommandBase<T> & { runId: string } & CommandStatePayload<T>
}[RunControlCommandType];

export type PendingSupervisorCommand = ControlCommandBase<"shutdown"> & { runId?: undefined } & CommandStatePayload<"shutdown">;

type SubmitCommandBase<T extends ControlCommandType> = {
  type: T;
  payload?: CommandPayload<T>;
  idempotencyKey: string;
};

export type SubmitRunControlCommandInput = {
  [T in RunControlCommandType]: SubmitCommandBase<T> & { runId: string }
}[RunControlCommandType];

export type SubmitSupervisorCommandInput = SubmitCommandBase<"shutdown"> & { runId?: undefined };

export type SubmitCommandInput =
  | SubmitRunControlCommandInput
  | SubmitSupervisorCommandInput;

export type FinishCommandInput =
  | { id: string; status: "applied"; payload?: AppliedCommandPayload }
  | { id: string; status: "failed"; payload: FailedCommandPayload };

export type ControlOptions = {
  commandId?: string;
  prepared?: ForkPreparedWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
};

export type ForkPreparedWorkflow = {
  workflowPath: string;
  irJson: string;
  irDigest: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: RunWorkflowLockArtifact;
};

export type ClaimCommandOptions = {
  ownerGeneration?: number;
};

export type CleanupRunDirectoriesOptions = {
  olderThanMs?: number;
  removeOrphanedRuns?: boolean;
};

export type CleanupRunDirectoriesResult = {
  staged: number;
  orphaned: number;
};

export type RecoverStaleCommandsOptions = {
  olderThanMs?: number;
  ownerGeneration?: number;
};

export type RegisterArtifactInput = {
  id: string;
  runId: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
};

export type WriteExecutionMetadataInput = {
  runId: string;
  attemptId?: string;
  kind: string;
  metadata: JsonValue;
};

type RunRow = {
  id: string;
  name: string;
  status: RunStatus;
  workflow_entry: string;
  ir_digest: string;
  source_graph_digest: string;
  created_at: string;
  updated_at: string;
};

type RunInputRow = {
  workflow_ir_json?: string;
  input_json: string;
  agent_overrides_json?: string | null;
  lock_json?: string;
  output_json: string | null;
  package_lock_digest?: string | null;
  run_dir?: string;
};

type RunDirRow = {
  run_dir: string;
};

type CountRow = {
  count: number;
};

type ArtifactRow = {
  id: unknown;
  node_key: unknown;
  attempt: unknown;
  media_type: unknown;
  digest: unknown;
  size: unknown;
  relative_path: unknown;
};

export async function openRuntimeStore(cwd: string): Promise<RuntimeStore> {
  const stateDir = join(cwd, ".acpus", "state");
  await mkdir(stateDir, { recursive: true });
  const db = openDatabase(join(stateDir, "runtime.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return new SqliteRuntimeStore(db, cwd);
}

export async function openExistingRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, true);
}

export async function openExistingWritableRuntimeStore(cwd: string): Promise<RuntimeStore | undefined> {
  return openExistingStore(cwd, false);
}

async function openExistingStore(cwd: string, readOnly: boolean): Promise<RuntimeStore | undefined> {
  const path = join(cwd, ".acpus", "state", "runtime.db");
  try {
    await access(path);
  } catch {
    return undefined;
  }
  if (readOnly) return new SqliteRuntimeStore(openDatabase(path, true), cwd);
  const db = openDatabase(path);
  migrate(db);
  return new SqliteRuntimeStore(db, cwd);
}

class SqliteRuntimeStore implements RuntimeStore {
  private schedulerPort?: SchedulerStorePort;

  constructor(private readonly db: DatabaseSync, private readonly cwd: string) {}

  get scheduler(): SchedulerStorePort {
    this.schedulerPort ??= new SqliteSchedulerStorePort(this.db);
    return this.schedulerPort;
  }

  close(): void {
    this.db.close();
  }

  async admitRun(input: AdmitRunInput): Promise<RunRecord> {
    const runId = newRunId();
    const now = new Date().toISOString();
    const workflowEntry = relative(input.cwd, input.prepared.workflowPath);
    const runDir = join(input.cwd, ".acpus", "runs", runId);
    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "workflow.ir.json"), input.prepared.irJson);
      await writeFile(join(runDir, "lock.json"), `${JSON.stringify(input.prepared.lock, null, 2)}\n`);
      const agentOverrides = normalizeAgentOverrides(input.prepared.ir, input.agentOverrides);

      const eventPayload = {
        workflow: summarizeWorkflowForEvent(input.prepared.ir),
        input: input.input,
        lock: input.prepared.lock,
        ...(Object.keys(agentOverrides).length > 0 ? { agentOverrides } : {}),
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO runs (id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
        `).run(runId, input.prepared.ir.name, workflowEntry, input.prepared.irDigest, input.prepared.sourceGraphDigest, now, now);
        this.db.prepare(`
          INSERT INTO run_inputs (
            run_id, workflow_ir_json, input_json, agent_overrides_json, lock_json, package_lock_digest, run_dir, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          input.prepared.irJson,
          stableJson(input.input),
          stableJson(agentOverrides),
          stableJson(input.prepared.lock),
          input.prepared.packageLockDigest ?? null,
          relative(input.cwd, runDir),
          now,
        );
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, 1, 'run.admitted', NULL, ?, ?, ?)
        `).run(runId, stableJson(eventPayload), now, `admit:${runId}:${input.prepared.irDigest}`);
        for (const nodeId of collectNodeIds(input.prepared.ir.root)) {
          this.db.prepare(`
            INSERT INTO node_states (run_id, node_key, node_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
          `).run(runId, nodeId, nodeId, now, now);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      await rm(runDir, { recursive: true, force: true });
      throw error;
    }

    const record = this.getRunRecord(runId);
    if (!record) throw new Error(`Admitted run ${runId} was not persisted.`);
    return record;
  }

  completeRun(input: CompleteRunInput): RunRecord {
    const now = new Date().toISOString();
    const output = assertJsonValue(input.output, "run output");
    const nodeOutputs = Object.fromEntries(Object.entries(input.nodes).map(([nodeKey, node]) => [
      nodeKey,
      assertJsonValue(node.output, `node '${nodeKey}' output`),
    ]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(input.runId);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = 'completed', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')
      `).run(now, input.runId);
      if (transition.changes !== 1) throw new Error(`Run '${input.runId}' cannot transition to completed.`);

      for (const [nodeKey, output] of Object.entries(nodeOutputs)) {
        const update = this.db.prepare(`
          UPDATE node_states
          SET status = 'completed', output_json = ?, error_json = NULL, updated_at = ?
          WHERE run_id = ? AND node_key = ?
        `).run(stableJson(output), now, input.runId, nodeKey);
        if (update.changes !== 1) throw new Error(`Node '${nodeKey}' was not found for run '${input.runId}'.`);
      }
      this.db.prepare(`
        UPDATE run_inputs
        SET output_json = ?
        WHERE run_id = ?
      `).run(stableJson(output), input.runId);
      this.db.prepare(`
        UPDATE node_states
        SET status = 'skipped', updated_at = ?
        WHERE run_id = ? AND status = 'pending'
      `).run(now, input.runId);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'run.completed', NULL, ?, ?, ?)
      `).run(input.runId, nextSequence, stableJson({ output }), now, `complete:${input.runId}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const record = this.getRunRecord(input.runId);
    if (!record) throw new Error(`Completed run ${input.runId} was not persisted.`);
    return record;
  }

  persistCompletedNodes(input: PersistCompletedNodesInput): RunRecord {
    const now = new Date().toISOString();
    const nodeOutputs = Object.fromEntries(Object.entries(input.nodes).map(([nodeKey, node]) => [
      nodeKey,
      assertJsonValue(node.output, `node '${nodeKey}' output`),
    ]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [nodeKey, output] of Object.entries(nodeOutputs)) {
        const update = this.db.prepare(`
          UPDATE node_states
          SET status = 'completed', output_json = ?, error_json = NULL, updated_at = ?
          WHERE run_id = ? AND node_key = ?
        `).run(stableJson(output), now, input.runId, nodeKey);
        if (update.changes !== 1) throw new Error(`Node '${nodeKey}' was not found for run '${input.runId}'.`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.requireRun(input.runId);
  }

  blockRun(input: BlockRunInput): RunRecord {
    const now = new Date().toISOString();
    const payload = { message: input.message, nodeKey: input.nodeKey };
    this.db.prepare(`
      UPDATE node_states
      SET error_json = ?, updated_at = ?
      WHERE run_id = ? AND node_key = ? AND status = 'pending'
    `).run(stableJson(payload), now, input.runId, input.nodeKey);
    return this.requireRun(input.runId);
  }

  failRun(input: FailRunInput): RunRecord {
    const now = new Date().toISOString();
    const payload = {
      message: input.message,
      ...(input.nodeKey ? { nodeKey: input.nodeKey } : {}),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(input.runId);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = 'failed', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')
      `).run(now, input.runId);
      if (transition.changes !== 1) throw new Error(`Run '${input.runId}' cannot transition to failed.`);
      if (input.nodeKey) {
        this.db.prepare(`
          UPDATE node_states
          SET status = 'failed', error_json = ?, updated_at = ?
          WHERE run_id = ? AND node_key = ?
        `).run(stableJson(payload), now, input.runId, input.nodeKey);
      }
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'run.failed', ?, ?, ?, ?)
      `).run(input.runId, nextSequence, input.nodeKey ?? null, stableJson(payload), now, `fail:${input.runId}:${nextSequence}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const record = this.getRunRecord(input.runId);
    if (!record) throw new Error(`Failed run ${input.runId} was not persisted.`);
    return record;
  }

  awaitSignal(input: AwaitSignalInput): RunRecord {
    const now = new Date().toISOString();
    const nodeOutputs = Object.fromEntries(Object.entries(input.nodes).map(([nodeKey, node]) => [
      nodeKey,
      assertJsonValue(node.output, `node '${nodeKey}' output`),
    ]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(input.runId);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = 'awaiting', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')
      `).run(now, input.runId);
      if (transition.changes !== 1) throw new Error(`Run '${input.runId}' cannot transition to awaiting.`);
      for (const [nodeKey, output] of Object.entries(nodeOutputs)) {
        const update = this.db.prepare(`
          UPDATE node_states
          SET status = 'completed', output_json = ?, error_json = NULL, updated_at = ?
          WHERE run_id = ? AND node_key = ?
        `).run(stableJson(output), now, input.runId, nodeKey);
        if (update.changes !== 1) throw new Error(`Node '${nodeKey}' was not found for run '${input.runId}'.`);
      }
      this.db.prepare(`
        UPDATE node_states
        SET status = 'awaiting', updated_at = ?
        WHERE run_id = ? AND node_key = ?
      `).run(now, input.runId, input.nodeKey);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'signal.awaiting', ?, ?, ?, ?)
      `).run(input.runId, nextSequence, input.nodeKey, stableJson({}), now, `await:${input.runId}:${input.nodeKey}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.requireRun(input.runId);
  }

  signalRun(input: SignalRunInput): RunRecord {
    const now = new Date().toISOString();
    const payload = assertJsonValue(input.payload, "signal payload");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(input.runId);
      const nodeUpdate = this.db.prepare(`
        UPDATE node_states
        SET status = 'completed', output_json = ?, error_json = NULL, updated_at = ?
        WHERE run_id = ? AND node_key = ? AND status = 'awaiting'
      `).run(stableJson(payload), now, input.runId, input.nodeKey);
      if (nodeUpdate.changes !== 1) throw new Error(`Signal node '${input.nodeKey}' is not awaiting.`);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = 'pending', updated_at = ?
        WHERE id = ? AND status = 'awaiting'
      `).run(now, input.runId);
      if (transition.changes !== 1) throw new Error(`Run '${input.runId}' cannot accept a signal.`);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'signal.received', ?, ?, ?, ?)
      `).run(input.runId, nextSequence, input.nodeKey, stableJson({ payload }), now, `signal:${input.runId}:${input.nodeKey}:${nextSequence}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.requireRun(input.runId);
  }

  getSignalPayloads(runId: string): Record<string, unknown> {
    const rows = this.db.prepare(`
      SELECT node_key, node_id, output_json
      FROM node_states
      WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
    `).all(runId) as Array<{ node_key: unknown; node_id: unknown; output_json: unknown }>;
    return completedOutputMap(rows.map(row => ({
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      output: JSON.parse(String(row.output_json)) as unknown,
    })));
  }

  getCompletedNodeOutputs(runId: string): Record<string, unknown> {
    return completedOutputMap(completedSchedulerOutputRows(this.db, runId));
  }

  getFrozenRun(runId: string): FrozenRun | undefined {
    const row = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, run_inputs.workflow_ir_json, run_inputs.input_json, run_inputs.agent_overrides_json
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
      WHERE run_inputs.run_id = ?
    `).get(runId) as (RunInputRow & { id: string; name: string; workflow_entry: string }) | undefined;
    if (!row?.workflow_ir_json) return undefined;
    const originalIr = JSON.parse(row.workflow_ir_json) as WorkflowIR;
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

  replayRun(runId: string): ReplayResult {
    const frozen = this.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    const artifacts = this.verifyArtifactRegistry(runId);
    const projection = this.verifyReplayProjection(runId);
    const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return { ok: false, runId, artifacts, projection };
    const expected = JSON.parse(row.output_json) as JsonValue;
    const actual = schedulerEvents(this.db, runId).length === 0
      ? expected
      : evaluateRecordedOutputs(frozen.ir.outputs, this.getCompletedNodeOutputs(runId), frozen.input, frozen.meta);
    const outputOk = JSON.stringify(sortJson(actual)) === JSON.stringify(sortJson(expected));
    const artifactsOk = artifacts.missing.length === 0 && artifacts.invalid.length === 0 && artifacts.mismatched.length === 0;
    return {
      ok: outputOk && artifactsOk && projection.issues.length === 0,
      runId,
      expected,
      actual,
      artifacts,
      projection,
    };
  }

  claimSupervisor(input: ClaimSupervisorInput): SupervisorLease {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`
      SELECT generation, heartbeat_at
      FROM supervisor_lease
      WHERE workspace_realpath = ?
    `).get(input.workspaceRealpath) as { generation: number; heartbeat_at: string | null } | undefined;
    if (existing?.heartbeat_at && Date.now() - Date.parse(existing.heartbeat_at) <= input.staleAfterMs) {
      throw new Error(`Supervisor lease for '${input.workspaceRealpath}' is still active.`);
    }
    const generation = (existing?.generation ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO supervisor_lease (
        workspace_realpath, generation, pid, endpoint, auth_token_hash, heartbeat_at,
        protocol_version, package_version, node_version, exec_path, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_realpath) DO UPDATE SET
        generation = excluded.generation,
        pid = excluded.pid,
        endpoint = excluded.endpoint,
        auth_token_hash = excluded.auth_token_hash,
        heartbeat_at = excluded.heartbeat_at,
        protocol_version = excluded.protocol_version,
        package_version = excluded.package_version,
        node_version = excluded.node_version,
        exec_path = excluded.exec_path,
        updated_at = excluded.updated_at
    `).run(
      input.workspaceRealpath,
      generation,
      input.pid,
      input.endpoint ?? null,
      input.tokenHash ?? null,
      now,
      input.protocolVersion,
      input.packageVersion,
      input.nodeVersion,
      input.execPath,
      now,
    );
    return { workspaceRealpath: input.workspaceRealpath, generation, pid: input.pid, heartbeatAt: now };
  }

  heartbeatSupervisor(input: HeartbeatSupervisorInput): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE supervisor_lease
      SET heartbeat_at = ?, updated_at = ?
      WHERE workspace_realpath = ? AND generation = ?
    `).run(now, now, input.workspaceRealpath, input.generation);
    return result.changes === 1;
  }

  releaseSupervisor(input: HeartbeatSupervisorInput): boolean {
    const result = this.db.prepare(`
      DELETE FROM supervisor_lease
      WHERE workspace_realpath = ? AND generation = ?
    `).run(input.workspaceRealpath, input.generation);
    return result.changes === 1;
  }

  releaseRunOwner(runId: string, ownerId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE run_leases
      SET released_at = ?, heartbeat_at = ?
      WHERE run_id = ? AND owner_id = ? AND released_at IS NULL
    `).run(now, now, runId, ownerId);
    return result.changes === 1;
  }

  submitCommand(input: SubmitRunControlCommandInput): PendingRunControlCommand;
  submitCommand(input: SubmitSupervisorCommandInput): PendingSupervisorCommand;
  submitCommand(input: SubmitCommandInput): PendingControlCommand;
  submitCommand(input: SubmitCommandInput): PendingControlCommand {
    const now = new Date().toISOString();
    const id = `cmd_${randomUUID()}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO commands (id, run_id, type, payload_json, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, input.runId ?? null, input.type, stableJson(input.payload ?? {}), input.idempotencyKey, now, now);
    const row = this.db.prepare(`
      SELECT id, run_id, type, status, idempotency_key, payload_json
      FROM commands
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Command '${input.idempotencyKey}' was not persisted.`);
    return toPendingCommand(row);
  }

  getCommand(commandId: string): PendingControlCommand | undefined {
    const row = this.db.prepare(`
      SELECT id, run_id, type, status, idempotency_key, payload_json
      FROM commands
      WHERE id = ?
    `).get(commandId) as Record<string, unknown> | undefined;
    return row ? toPendingCommand(row) : undefined;
  }

  listPendingCommands(): PendingControlCommand[] {
    return this.db.prepare(`
      SELECT id, run_id, type, status, idempotency_key, payload_json
      FROM commands
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `).all().map(toPendingCommand);
  }

  listRunnableRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
      FROM runs
      WHERE status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM node_states
          WHERE node_states.run_id = runs.id
            AND node_states.status = 'pending'
            AND node_states.error_json IS NOT NULL
        )
      ORDER BY created_at ASC
    `).all().map(toRunRecord);
  }

  claimCommand(commandId: string, options: ClaimCommandOptions = {}): boolean {
    const result = this.db.prepare(`
      UPDATE commands
      SET status = 'running', owner_generation = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(options.ownerGeneration ?? null, new Date().toISOString(), commandId);
    return result.changes === 1;
  }

  deferCommand(commandId: string): void {
    this.db.prepare(`
      UPDATE commands
      SET status = 'pending', owner_generation = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), commandId);
  }

  recoverStaleCommands(options: RecoverStaleCommandsOptions = {}): number {
    const olderThanMs = options.olderThanMs ?? 30_000;
    if (options.ownerGeneration === undefined) return 0;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare(`
      UPDATE commands
      SET status = 'pending', owner_generation = NULL, updated_at = ?
      WHERE status = 'running' AND owner_generation = ? AND updated_at < ?
    `).run(new Date().toISOString(), options.ownerGeneration, cutoff);
    return Number(result.changes);
  }

  finishCommand(input: FinishCommandInput): void {
    this.db.prepare(`
      UPDATE commands
      SET status = ?, payload_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(input.status, stableJson(input.payload ?? {}), new Date().toISOString(), input.id);
  }

  pauseRun(runId: string, options: ControlOptions = {}): RunRecord {
    return this.transitionRun(runId, "paused", ["pending", "running"], "run.paused", options);
  }

  resumeRun(runId: string, options: ControlOptions = {}): RunRecord {
    return this.transitionRun(runId, "pending", ["paused"], "run.resumed", options);
  }

  retryRun(runId: string, options: ControlOptions = {}): RunRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(runId);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = 'pending', updated_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(now, runId);
      if (transition.changes !== 1) throw new Error(`Run '${runId}' cannot transition to pending.`);
      this.db.prepare(`
        UPDATE run_inputs
        SET output_json = NULL
        WHERE run_id = ?
      `).run(runId);
      this.db.prepare(`
        UPDATE node_states
        SET status = 'pending', output_json = NULL, error_json = NULL, updated_at = ?
        WHERE run_id = ?
      `).run(now, runId);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'run.retried', NULL, ?, ?, ?)
      `).run(runId, nextSequence, stableJson({}), now, `retry:${runId}:${nextSequence}`);
      if (options.commandId) this.finishCommandInTransaction(options.commandId, "applied", { status: "pending" }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.requireRun(runId);
  }

  async forkRun(runId: string, options: ControlOptions = {}): Promise<RunRecord> {
    const source = this.getRunRecord(runId);
    if (!source) throw new Error(`Run '${runId}' was not found.`);
    const input = this.db.prepare(`
      SELECT workflow_ir_json, input_json, agent_overrides_json, lock_json, output_json, package_lock_digest, run_dir
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input?.workflow_ir_json || !input.lock_json) throw new Error(`Run '${runId}' has no frozen input.`);
    const forkIrJson = options.prepared?.irJson ?? input.workflow_ir_json;
    if (options.prepared && digest(Buffer.from(forkIrJson)) !== options.prepared.irDigest) throw new Error("Fork prepared workflow IR digest does not match payload.");
    const forkIr = JSON.parse(forkIrJson) as WorkflowIR;
    const sourceAgentOverrides = parseAgentOverrides(input.agent_overrides_json);
    const forkAgentOverrides = normalizeAgentOverrides(forkIr, options.agentOverrides, sourceAgentOverrides);
    const forkInputJson = options.input === undefined ? input.input_json : stableJson(options.input);
    const forkLockJson = options.prepared ? stableJson(options.prepared.lock) : input.lock_json;
    const forkPackageLockDigest = options.prepared?.packageLockDigest ?? input.package_lock_digest ?? null;
    const forkName = options.prepared ? forkIr.name : source.name;
    const forkWorkflowEntry = options.prepared ? relative(this.cwd, options.prepared.workflowPath) : source.workflowEntry;
    const forkIrDigest = options.prepared?.irDigest ?? source.irDigest;
    const forkSourceGraphDigest = options.prepared?.sourceGraphDigest ?? source.sourceGraphDigest;
    const forkId = newRunId();
    const now = new Date().toISOString();
    const replacement = Boolean(options.prepared || options.input !== undefined || stableJson(forkAgentOverrides) !== stableJson(sourceAgentOverrides));
    const forkStatus = source.status === "completed" && !replacement ? "completed" : "pending";
    const sourceRunDir = input.run_dir ? containedRunDir(this.cwd, input.run_dir) : undefined;
    const forkRunDir = join(".acpus", "runs", forkId);
    const forkRunPath = join(this.cwd, forkRunDir);
    const stagedForkRunPath = join(this.cwd, ".acpus", "runs", `.staging-${forkId}`);
    const completedOutputRows = completedSchedulerOutputRows(this.db, runId);
    const completedNodeKeys = new Set([
      ...this.db.prepare(`
      SELECT node_key
      FROM node_states
      WHERE run_id = ? AND status = 'completed'
    `).all(runId).map(row => String(row.node_key)),
      ...completedOutputRows.map(row => row.nodeKey),
    ]);
    const sourceIr = JSON.parse(input.workflow_ir_json) as WorkflowIR;
    const sourceNodeSignatures = nodeSignatures(sourceIr.root);
    const forkNodeSignatures = nodeSignatures(forkIr.root);
    const irNodeKeys = new Set(forkNodeSignatures.keys());
    const knownCompletedNodeKeys = new Set([...completedNodeKeys].filter(nodeKey => {
      if (forkNodeSignatures.has(nodeKey)) return forkNodeSignatures.get(nodeKey) === sourceNodeSignatures.get(nodeKey);
      return !replacement && source.status === "completed";
    }));
    const inheritableNodeKeys = options.input !== undefined ? new Set<string>() : source.status === "completed"
      ? knownCompletedNodeKeys
      : inheritableCompletedNodeKeys(forkIr, knownCompletedNodeKeys);
    const nodeRows = this.db.prepare("SELECT node_key, node_id, status, output_json, error_json, attempt FROM node_states WHERE run_id = ?").all(runId) as Array<Record<string, unknown>>;
    const reachableArtifactIds = reachableInheritedArtifactIds({
      runId,
      outputJson: input.output_json,
      nodeRows,
      inheritableNodeKeys,
    });
    const artifacts = this.db.prepare(`
      SELECT id, node_key, attempt, media_type, digest, size, relative_path
      FROM artifacts
      WHERE run_id = ?
    `).all(runId).filter(artifact => reachableArtifactIds.has(String(artifact.id)) && inheritableNodeKeys.has(String(artifact.node_key))) as ArtifactRow[];
    const artifactIdMap = Object.fromEntries(artifacts.map(artifact => [
      String(artifact.id),
      `artifact_${randomUUID()}`,
    ]));
    const forkOutputJson = source.status === "completed" && !replacement && input.output_json
      ? forkCompletedOutputJson({
          outputs: forkIr.outputs,
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
        })
      : null;
    if (sourceRunDir) {
      try {
        await mkdir(dirname(stagedForkRunPath), { recursive: true });
        await cp(sourceRunDir, stagedForkRunPath, { recursive: true });
        await pruneNonInheritedArtifacts(stagedForkRunPath, artifacts);
        if (options.prepared) await writePreparedRunFiles(stagedForkRunPath, options.prepared);
        await verifyFrozenRunFiles(stagedForkRunPath, forkIrDigest, forkLockJson, forkIrJson);
        await verifyCopiedArtifacts(stagedForkRunPath, artifacts);
        await rm(forkRunPath, { recursive: true, force: true });
        await rename(stagedForkRunPath, forkRunPath);
      } catch (error) {
        await rm(stagedForkRunPath, { recursive: true, force: true });
        await rm(forkRunPath, { recursive: true, force: true });
        throw error;
      }
    } else if (artifacts.length > 0) {
      throw new Error(`Run '${runId}' has artifacts but no run directory.`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO runs (id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(forkId, forkName, forkStatus, forkWorkflowEntry, forkIrDigest, forkSourceGraphDigest, now, now);
        this.db.prepare(`
          INSERT INTO run_inputs (
          run_id, workflow_ir_json, input_json, agent_overrides_json, output_json, lock_json, package_lock_digest, run_dir, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        forkId,
        forkIrJson,
        forkInputJson,
        stableJson(forkAgentOverrides),
        forkOutputJson,
        forkLockJson,
        forkPackageLockDigest,
        forkRunDir,
        now,
      );
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, 1, 'run.forked', NULL, ?, ?, ?)
      `).run(forkId, stableJson({ sourceRunId: runId, ...(Object.keys(forkAgentOverrides).length > 0 ? { agentOverrides: forkAgentOverrides } : {}) }), now, `fork:${forkId}:${runId}`);
      if (forkStatus === "completed" && forkOutputJson) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, 2, 'run.completed', NULL, ?, ?, ?)
        `).run(forkId, stableJson({ output: JSON.parse(forkOutputJson) as JsonValue }), now, `complete:${forkId}`);
      }
      const insertedNodeKeys = new Set<string>();
      for (const row of nodeRows) {
        const nodeKey = String(row.node_key);
        if (!irNodeKeys.has(nodeKey) && !inheritableNodeKeys.has(nodeKey)) continue;
        insertedNodeKeys.add(nodeKey);
        this.db.prepare(`
          INSERT INTO node_states (run_id, node_key, node_id, status, output_json, error_json, attempt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          forkId,
          nodeKey,
          String(row.node_id),
          inheritableNodeKeys.has(nodeKey) ? "completed" : "pending",
          inheritableNodeKeys.has(nodeKey) && row.output_json ? rewriteArtifactRefs(String(row.output_json), runId, forkId, artifactIdMap) : null,
          null,
          Number(row.attempt ?? 0),
          now,
          now,
        );
      }
      for (const nodeKey of irNodeKeys) {
        if (insertedNodeKeys.has(nodeKey)) continue;
        this.db.prepare(`
          INSERT INTO node_states (run_id, node_key, node_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(forkId, nodeKey, nodeKey, now, now);
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
      if (options.commandId) this.finishCommandInTransaction(options.commandId, "applied", { forkRunId: forkId, status: forkStatus }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      await rm(stagedForkRunPath, { recursive: true, force: true });
      await rm(forkRunPath, { recursive: true, force: true });
      throw error;
    }
    return this.requireRun(forkId);
  }

  async cleanupRunDirectories(options: CleanupRunDirectoriesOptions = {}): Promise<CleanupRunDirectoriesResult> {
    const runsDir = join(this.cwd, ".acpus", "runs");
    const olderThanMs = options.olderThanMs ?? 60_000;
    const removeOrphanedRuns = options.removeOrphanedRuns ?? false;
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      return { staged: 0, orphaned: 0 };
    }
    const validRunDirs = new Set(this.db.prepare("SELECT run_dir FROM run_inputs").all().map(row => String(row.run_dir)));
    let staged = 0;
    let orphaned = 0;
    for (const entry of entries) {
      const absolutePath = join(runsDir, entry);
      if (!(await isStalePath(absolutePath, olderThanMs))) continue;
      if (entry.startsWith(".staging-")) {
        await rm(absolutePath, { recursive: true, force: true });
        staged += 1;
        continue;
      }
      const relativePath = join(".acpus", "runs", entry);
      if (removeOrphanedRuns && entry.startsWith("run_") && !validRunDirs.has(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        orphaned += 1;
      }
    }
    return { staged, orphaned };
  }

  getRunDir(runId: string): string | undefined {
    const row = this.db.prepare("SELECT run_dir FROM run_inputs WHERE run_id = ?").get(runId) as RunDirRow | undefined;
    return row?.run_dir;
  }

  registerArtifact(input: RegisterArtifactInput): void {
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
  }

  writeExecutionMetadata(input: WriteExecutionMetadataInput): void {
    this.db.prepare(`
      INSERT INTO execution_metadata (run_id, attempt_id, kind, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.attemptId ?? null,
      input.kind,
      stableJson(input.metadata),
      new Date().toISOString(),
    );
  }

  getRun(runId: string): RunDetails | undefined {
    const run = this.getRunRecord(runId);
    if (!run) return undefined;
    const input = this.db.prepare(`
      SELECT input_json, agent_overrides_json, output_json
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input) return undefined;
    const agentOverrides = parseAgentOverrides(input.agent_overrides_json);
    const eventCount = this.count("run_events", runId);
    const nodeCount = this.count("node_states", runId);
    const dynamic = this.tryGetRunDynamicDetails(runId);
    return {
      ...run,
      input: JSON.parse(input.input_json) as JsonValue,
      ...(input.output_json ? { output: JSON.parse(input.output_json) as JsonValue } : {}),
      ...(Object.keys(agentOverrides).length > 0 ? { agentOverrides } : {}),
      eventCount,
      nodeCount,
      ...(dynamic ? { dynamic } : {}),
    };
  }

  private tryGetRunDynamicDetails(runId: string): RunDynamicDetails | undefined {
    try {
      const frames = readRunDynamicFrames(this.db, runId);
      const nodeInstances = readRunDynamicNodeInstances(this.db, runId);
      const attempts = readRunDynamicAttempts(this.db, runId);
      const groupMembers = readRunDynamicGroupMembers(this.db, runId);
      const signalWaits = readRunDynamicSignalWaits(this.db, runId);
      const executionMetadata = readRunExecutionMetadata(this.db, runId);
      if (frames.length + nodeInstances.length + attempts.length + groupMembers.length + signalWaits.length + executionMetadata.length === 0) return undefined;
      return {
        version: this.nextSequence(runId) - 1,
        frames,
        nodeInstances,
        attempts,
        groupMembers,
        signalWaits,
        executionMetadata,
      };
    } catch {
      return undefined;
    }
  }

  private verifyArtifactRegistry(runId: string): NonNullable<ReplayResult["artifacts"]> {
    const runDir = this.getRunDir(runId);
    const rows = this.db.prepare(`
      SELECT id, digest, size, relative_path
      FROM artifacts
      WHERE run_id = ?
      ORDER BY id
    `).all(runId) as Array<{ id: unknown; digest: unknown; size: unknown; relative_path: unknown }>;
    const missing: NonNullable<ReplayResult["artifacts"]>["missing"] = [];
    const invalid: NonNullable<ReplayResult["artifacts"]>["invalid"] = [];
    const mismatched: NonNullable<ReplayResult["artifacts"]>["mismatched"] = [];
    if (!runDir) {
      for (const row of rows) missing.push({ id: String(row.id), relativePath: String(row.relative_path) });
      return { checked: rows.length, missing, invalid, mismatched };
    }
    const absoluteRunDir = join(this.cwd, runDir);
    for (const row of rows) {
      const id = String(row.id);
      const relativePath = String(row.relative_path);
      const expectedDigest = String(row.digest);
      const expectedSize = Number(row.size);
      try {
        const bytes = readFileSyncContained(absoluteRunDir, relativePath);
        const actualDigest = digest(bytes);
        if (bytes.byteLength !== expectedSize || actualDigest !== expectedDigest) {
          mismatched.push({
            id,
            relativePath,
            expectedDigest,
            actualDigest,
            expectedSize,
            actualSize: bytes.byteLength,
          });
        }
      } catch (error) {
        if (error instanceof PathEscapeError) {
          invalid.push({ id, relativePath, message: error.message });
        } else {
          missing.push({ id, relativePath });
        }
      }
    }
    return { checked: rows.length, missing, invalid, mismatched };
  }

  private verifyReplayProjection(runId: string): NonNullable<ReplayResult["projection"]> {
    const issues: string[] = [];
    const run = this.getRunRecord(runId);
    if (!run) return { issues: [`Run '${runId}' was not found.`] };
    const terminalEvents = this.db.prepare(`
      SELECT type, payload_json
      FROM run_events
      WHERE run_id = ? AND type IN ('run.completed', 'run.failed')
      ORDER BY sequence
    `).all(runId) as Array<{ type: string; payload_json: string }>;
    const completed = terminalEvents.filter(event => event.type === "run.completed");
    const failed = terminalEvents.filter(event => event.type === "run.failed");
    const schedulerEventRows = schedulerEvents(this.db, runId);
    const hasRunRetry = schedulerEventRows.some(event => event.type === "control.run_retry_requested");
    const hasTargetedRetry = schedulerEventRows.some(event => event.type === "instance.retry_requested" || event.type === "frame.retry_requested");
    const hasRetry = hasRunRetry || hasTargetedRetry;
    const rebuilt = rebuildTerminalProjection(terminalEvents);
    if (rebuilt.status && rebuilt.status !== run.status && !(hasTargetedRetry && (run.status === "pending" || run.status === "awaiting" || run.status === "paused"))) {
      issues.push(`Run '${runId}' status does not match terminal event stream.`);
    }
    if (rebuilt.output !== undefined) {
      const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
      const persistedOutput = row?.output_json ? safeParseJson(row.output_json) : undefined;
      if (!persistedOutput?.ok || JSON.stringify(sortJson(persistedOutput.value)) !== JSON.stringify(sortJson(rebuilt.output))) {
        issues.push(`Run '${runId}' output projection does not match terminal event stream.`);
      }
    }
    if (!hasRetry && completed.length > 0 && failed.length > 0) issues.push(`Run '${runId}' has conflicting terminal events.`);
    if (run.status === "completed") {
      if (hasRetry) {
        if (completed.length < 1) issues.push(`Completed run '${runId}' must have a run.completed event.`);
      } else {
        if (completed.length !== 1) issues.push(`Completed run '${runId}' must have exactly one run.completed event.`);
        if (failed.length > 0) issues.push(`Completed run '${runId}' must not have run.failed events.`);
      }
      const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
      if (!row?.output_json) issues.push(`Completed run '${runId}' has no persisted output.`);
      const completedEvent = completed.at(-1);
      if (completedEvent && row?.output_json) {
        const eventPayload = safeParseJson(completedEvent.payload_json);
        const persistedOutput = safeParseJson(row.output_json);
        if (!eventPayload.ok) issues.push(`Completed run '${runId}' has invalid run.completed payload JSON.`);
        if (!persistedOutput.ok) issues.push(`Completed run '${runId}' has invalid persisted output JSON.`);
        if (eventPayload.ok && persistedOutput.ok && JSON.stringify(sortJson((eventPayload.value as { output?: JsonValue }).output)) !== JSON.stringify(sortJson(persistedOutput.value))) {
          issues.push(`Completed run '${runId}' output does not match run.completed event.`);
        }
      }
    }
    if (run.status === "failed") {
      if (hasRetry) {
        if (failed.length < 1) issues.push(`Failed run '${runId}' must have a run.failed event.`);
      } else {
        if (failed.length !== 1) issues.push(`Failed run '${runId}' must have exactly one run.failed event.`);
        if (completed.length > 0) issues.push(`Failed run '${runId}' must not have run.completed events.`);
      }
      const failedEvent = failed.at(-1);
      if (failedEvent) {
        const eventPayload = safeParseJson(failedEvent.payload_json);
        if (!eventPayload.ok) issues.push(`Failed run '${runId}' has invalid run.failed payload JSON.`);
        if (eventPayload.ok) {
          const nodeKey = (eventPayload.value as { nodeKey?: unknown }).nodeKey;
          if (typeof nodeKey === "string") {
            const node = this.db.prepare("SELECT status, error_json FROM node_states WHERE run_id = ? AND node_key = ?").get(runId, nodeKey) as { status: string; error_json: string | null } | undefined;
            if (!node || node.status !== "failed") issues.push(`Failed run '${runId}' event node '${nodeKey}' does not match failed node projection.`);
            if (node?.error_json) {
              const nodeError = safeParseJson(node.error_json);
              if (!nodeError.ok) issues.push(`Failed run '${runId}' has invalid node error JSON.`);
              if (nodeError.ok && JSON.stringify(sortJson(nodeError.value)) !== JSON.stringify(sortJson(eventPayload.value))) {
                issues.push(`Failed run '${runId}' error projection does not match run.failed event.`);
              }
            }
          }
        }
      }
    }
    if ((run.status === "pending" || run.status === "awaiting" || run.status === "paused") && terminalEvents.length > 0 && !hasRetry) {
      issues.push(`Non-terminal run '${runId}' has terminal events.`);
    }
    issues.push(...this.verifySchedulerReplayProjection(runId, run));
    return { issues };
  }

  private verifySchedulerReplayProjection(runId: string, run: RunRecord): string[] {
    const replayEvents = schedulerEventsForReplay(this.db, runId);
    const events = replayEvents.events;
    if (events.length === 0) {
      return [
        ...replayEvents.issues,
        ...compareSchedulerProjectionTables(this.db, runId, createSchedulerProjection(runId)),
      ];
    }
    let projection: SchedulerProjection;
    try {
      projection = applySchedulerEvents(createSchedulerProjection(runId), events);
    } catch (error) {
      return [`Scheduler event stream for run '${runId}' is not replayable: ${error instanceof Error ? error.message : String(error)}`];
    }
    const issues = [...replayEvents.issues];
    const expectedPublicStatus = publicStatusFromSchedulerProjection(projection);
    if (run.status !== expectedPublicStatus) {
      issues.push(`Run '${runId}' public status does not match scheduler event stream.`);
    }
    if (projection.run.status === "completed") {
      const expectedOutput = projection.frames.root?.result ?? {};
      const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
      const persistedOutput = row?.output_json ? safeParseJson(row.output_json) : undefined;
      if (!persistedOutput?.ok || !sameStableJson(persistedOutput.value, expectedOutput)) {
        issues.push(`Run '${runId}' public output does not match scheduler event stream.`);
      }
    }
    issues.push(...compareSchedulerProjectionTables(this.db, runId, projection));
    return issues;
  }

  listRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
      FROM runs
      ORDER BY updated_at DESC, created_at DESC
    `).all().map(toRunRecord);
  }

  getRuntimeDiagnostics(): RuntimeDiagnostics {
    const now = new Date().toISOString();
    const supervisor = this.db.prepare(`
      SELECT workspace_realpath, generation, pid, heartbeat_at, protocol_version, package_version, node_version, exec_path, updated_at
      FROM supervisor_lease
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as {
      workspace_realpath: string;
      generation: number;
      pid: number | null;
      heartbeat_at: string | null;
      protocol_version: number;
      package_version: string;
      node_version: string;
      exec_path: string;
      updated_at: string;
    } | undefined;
    const commands = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MIN(CASE WHEN status = 'pending' THEN created_at ELSE NULL END) AS oldest_pending_at
      FROM commands
    `).get() as { pending: number | null; running: number | null; failed: number | null; oldest_pending_at: string | null };
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
    const activeForeground = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM run_leases
      WHERE released_at IS NULL AND lease_expires_at > ? AND owner_id LIKE 'foreground:%'
    `).get(now) as CountRow;
    const stale = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM run_leases
      WHERE released_at IS NULL AND lease_expires_at <= ?
    `).get(now) as CountRow;
    return {
      ...(supervisor ? {
        supervisor: {
          workspaceRealpath: supervisor.workspace_realpath,
          generation: supervisor.generation,
          ...(supervisor.pid === null ? {} : { pid: supervisor.pid }),
          ...(supervisor.heartbeat_at === null ? {} : { heartbeatAt: supervisor.heartbeat_at }),
          protocolVersion: supervisor.protocol_version,
          packageVersion: supervisor.package_version,
          nodeVersion: supervisor.node_version,
          execPath: supervisor.exec_path,
          updatedAt: supervisor.updated_at,
        },
      } : {}),
      commands: {
        pending: Number(commands.pending ?? 0),
        running: Number(commands.running ?? 0),
        failed: Number(commands.failed ?? 0),
        ...(commands.oldest_pending_at ? { oldestPendingAt: commands.oldest_pending_at } : {}),
      },
      runs: {
        total: Number(runs.total ?? 0),
        pending: Number(runs.pending ?? 0),
        running: Number(runs.running ?? 0),
        awaiting: Number(runs.awaiting ?? 0),
        paused: Number(runs.paused ?? 0),
        failed: Number(runs.failed ?? 0),
        completed: Number(runs.completed ?? 0),
        canceled: Number(runs.canceled ?? 0),
        runnable: this.listRunnableRuns().length,
      },
      leases: {
        activeForeground: Number(activeForeground.count),
        stale: Number(stale.count),
      },
    };
  }

  private getRunRecord(runId: string): RunRecord | undefined {
    const row = this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
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

  private transitionRun(runId: string, status: RunStatus, from: RunStatus[], eventType: string, options: ControlOptions = {}): RunRecord {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = this.nextSequence(runId);
      const transition = this.db.prepare(`
        UPDATE runs
        SET status = ?, updated_at = ?
        WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})
      `).run(status, now, runId, ...from);
      if (transition.changes !== 1) throw new Error(`Run '${runId}' cannot transition to ${status}.`);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
      `).run(runId, nextSequence, eventType, stableJson({ status }), now, `${eventType}:${runId}:${nextSequence}`);
      if (options.commandId) this.finishCommandInTransaction(options.commandId, "applied", { status }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.requireRun(runId);
  }

  private finishCommandInTransaction(id: string, status: "applied" | "failed", payload: JsonValue, now: string): void {
    this.db.prepare(`
      UPDATE commands
      SET status = ?, payload_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(status, stableJson(payload), now, id);
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
  constructor(private readonly db: DatabaseSync) {}

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
        INSERT INTO run_leases (run_id, owner_id, owner_epoch, lease_expires_at, heartbeat_at, claimed_at, released_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 'advance')
        ON CONFLICT(run_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          owner_epoch = excluded.owner_epoch,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at,
          claimed_at = excluded.claimed_at,
          released_at = NULL,
          reason = excluded.reason
      `).run(runId, ownerId, ownerEpoch, leaseExpiresAt, now, now);
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
      SET lease_expires_at = ?, heartbeat_at = ?
      WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL AND lease_expires_at > ?
    `).run(leaseExpiresAt, now, claim.runId, claim.ownerId, claim.ownerEpoch, now);
    return result.changes === 1;
  }

  releaseRun(claim: RunOwnerClaim): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE run_leases
      SET released_at = ?, heartbeat_at = ?
      WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL
    `).run(now, now, claim.runId, claim.ownerId, claim.ownerEpoch);
    return result.changes === 1;
  }

  tryLoadRunSnapshot(runId: string): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.loadRunSnapshot(runId));
  }

  loadRunSnapshot(runId: string): SchedulerSnapshot {
    const row = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!row) throwSchedulerStoreError({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const events = this.schedulerEvents(runId);
    return {
      runId,
      version: this.currentVersion(runId),
      projection: applySchedulerEvents(createSchedulerProjection(runId), events),
    };
  }

  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.appendSchedulerEvents(commit));
  }

  appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    if (commit.events.length === 0) return this.loadRunSnapshot(commit.runId);
    const replay = this.replayAppendIdempotency(commit);
    if (replay) return replay;
    const now = new Date().toISOString();
    const commitDigest = schedulerCommitDigest(commit.events);
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
      applySchedulerEvents(createSchedulerProjection(commit.runId), [...this.schedulerEvents(commit.runId), ...commit.events]);
      this.db.prepare(`
        INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(commit.runId, commit.idempotencyKey, commit.events.length, commitDigest, now);
      let sequence = currentVersion + 1;
      for (const [index, event] of commit.events.entries()) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(commit.runId, sequence, event.type, eventNodeKey(event), encodeSchedulerPayload(event.payload), now, schedulerEventIdempotencyKey(commit.runId, commit.idempotencyKey, index));
        sequence += 1;
      }
      this.syncSchedulerProjectionTables(commit.runId, now);
      this.syncPublicRunProjection(commit.runId, now);
      this.db.exec("COMMIT");
      return this.loadRunSnapshot(commit.runId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryStartAttempt(input: AttemptStartInput): SchedulerStoreResult<{ attemptId: string; attemptNo: number }> {
    return schedulerStoreResult(() => this.startAttempt(input));
  }

  startAttempt(input: AttemptStartInput): { attemptId: string; attemptNo: number } {
    const existing = this.eventByIdempotencyKey(input.idempotencyKey);
    if (existing && existing.type === "attempt.started") {
      const payload = existing.payload as { attemptId?: unknown; attemptNo?: unknown };
      if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with another run.` });
      if (!matchesAttemptStartInput(input, payload)) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with different input.` });
      if (typeof payload.attemptId === "string" && typeof payload.attemptNo === "number") return { attemptId: payload.attemptId, attemptNo: payload.attemptNo };
      throw new Error(`Attempt start idempotency key '${input.idempotencyKey}' has invalid payload.`);
    }
    if (existing) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with ${existing.type}.` });
    const now = new Date().toISOString();
    const attemptId = `attempt_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      const currentProjection = applySchedulerEvents(createSchedulerProjection(input.runId), this.schedulerEvents(input.runId));
      if (currentProjection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
      const row = this.db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS count FROM node_attempts WHERE run_id = ? AND node_key = ?").get(input.runId, input.nodeKey) as CountRow | undefined;
      const attemptNo = row?.count ?? 1;
      const sequence = this.nextSequence(input.runId);
      const payload = {
        runId: input.runId,
        attemptId,
        nodeKey: input.nodeKey,
        nodeId: input.nodeId,
        attemptNo,
        ownerEpoch: input.ownerEpoch,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      };
      const instanceStartedEvent: SchedulerEvent = { type: "instance.started", payload: { nodeKey: input.nodeKey } };
      const attemptStartedEvent: SchedulerEvent = { type: "attempt.started", payload };
      const memberStartedEvents = this.groupMemberStartedEventsForNode(input.runId, input.nodeKey);
      const events = [instanceStartedEvent, ...memberStartedEvents, attemptStartedEvent];
      applySchedulerEvents(createSchedulerProjection(input.runId), [...this.schedulerEvents(input.runId), ...events]);
      let sequenceOffset = 0;
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'instance.started', ?, ?, ?, ?)
      `).run(input.runId, sequence + sequenceOffset, input.nodeKey, encodeSchedulerPayload(instanceStartedEvent.payload), now, derivedIdempotencyKey(input.idempotencyKey, "instance"));
      sequenceOffset += 1;
      for (const [index, memberStartedEvent] of memberStartedEvents.entries()) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, 'group.member_started', ?, ?, ?, ?)
        `).run(input.runId, sequence + sequenceOffset, input.nodeKey, encodeSchedulerPayload(memberStartedEvent.payload), now, derivedIdempotencyKey(input.idempotencyKey, index === 0 ? "member" : `member:${index}`));
        sequenceOffset += 1;
      }
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'attempt.started', ?, ?, ?, ?)
      `).run(input.runId, sequence + sequenceOffset, input.nodeKey, encodeSchedulerPayload(payload), now, input.idempotencyKey);
      this.syncSchedulerProjectionTables(input.runId, now);
      this.syncPublicRunProjection(input.runId, now);
      this.db.exec("COMMIT");
      return { attemptId, attemptNo };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.commitAttemptResult(input));
  }

  commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    const existing = this.eventByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with another run.` });
      const attempt = this.db.prepare("SELECT node_key FROM node_attempts WHERE run_id = ? AND attempt_id = ?").get(input.runId, input.attemptId) as { node_key: string } | undefined;
      if (!attempt) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
      const event = attemptResultEvent(input, attempt.node_key);
      if (existing.type !== event.type || stableJson(existing.payload) !== stableJson(event.payload)) {
        throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with different input.` });
      }
      return this.loadRunSnapshot(input.runId);
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.db.prepare("SELECT run_id, node_key, owner_epoch, status FROM node_attempts WHERE attempt_id = ?").get(input.attemptId) as { run_id: string; node_key: string; owner_epoch: number; status: string } | undefined;
      if (!attempt || attempt.run_id !== input.runId) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
      if (attempt.owner_epoch !== input.ownerEpoch) throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      if (attempt.status !== "started") throwSchedulerStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
      const event = attemptResultEvent(input, String(attempt.node_key));
      const instanceEvent = instanceResultEvent(input, String(attempt.node_key), event);
      const memberEvent = this.groupMemberResultEventForNode(input.runId, String(attempt.node_key), input.result);
      const events = [event, instanceEvent, ...(memberEvent ? [memberEvent] : [])];
      applySchedulerEvents(createSchedulerProjection(input.runId), [...this.schedulerEvents(input.runId), ...events]);
      const sequence = this.nextSequence(input.runId);
      let sequenceOffset = 0;
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.runId, sequence + sequenceOffset, event.type, String(attempt.node_key), encodeSchedulerPayload(event.payload), now, input.idempotencyKey);
      sequenceOffset += 1;
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.runId, sequence + sequenceOffset, instanceEvent.type, String(attempt.node_key), encodeSchedulerPayload(instanceEvent.payload), now, derivedIdempotencyKey(input.idempotencyKey, "instance"));
      sequenceOffset += 1;
      if (memberEvent) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(input.runId, sequence + sequenceOffset, memberEvent.type, String(attempt.node_key), encodeSchedulerPayload(memberEvent.payload), now, derivedIdempotencyKey(input.idempotencyKey, "member"));
      }
      this.syncSchedulerProjectionTables(input.runId, now);
      this.syncPublicRunProjection(input.runId, now);
      this.db.exec("COMMIT");
      return this.loadRunSnapshot(input.runId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryConsumeSignal(input: SignalConsumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.consumeSignal(input));
  }

  consumeSignal(input: SignalConsumeInput): SchedulerSnapshot {
    const snapshot = this.loadRunSnapshot(input.runId);
    const wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status === "consumed" && wait.commandIdempotencyKey === input.commandIdempotencyKey && stableJson(wait.payload) === stableJson(input.payload)) {
      return snapshot;
    }
    if (wait.status === "consumed" && wait.commandIdempotencyKey === input.commandIdempotencyKey) {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal consume idempotency key '${input.idempotencyKey}' conflicts with different payload.` });
    }
    if (wait.status === "consumed") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' has already consumed a different payload.` });
    }
    if (wait.status !== "awaiting") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' is already ${wait.status}.` });
    }
    if (snapshot.projection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
    const payloadDigest = createHash("sha256").update(stableJson(input.payload)).digest("hex");
    const events: SchedulerEvent[] = [
      {
        type: "signal.consumed",
        payload: {
          nodeKey: input.nodeKey,
          payload: input.payload,
          payloadDigest,
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
      events,
    });
  }

  tryPauseRun(input: SchedulerPauseInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.pauseRun(input));
  }

  pauseRun(input: SchedulerPauseInput): SchedulerSnapshot {
    const replay = this.replayIntentIdempotency(input.runId, input.idempotencyKey);
    if (replay) return replay;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status === "paused") return snapshot;
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: input.reason === undefined ? {} : { reason: input.reason } },
    ];
    const requeuedMemberKeys = new Set<string>();
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
      for (const member of ancestorGroupMembersForNode(snapshot.projection, attempt.nodeKey)) {
        if (member.status !== "running" || requeuedMemberKeys.has(member.memberKey)) continue;
        requeuedMemberKeys.add(member.memberKey);
        events.push({
          type: "group.member_requeued",
          payload: {
            memberKey: member.memberKey,
            reason: "paused",
            readinessSequence: member.readinessSequence,
          },
        });
      }
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      events,
    });
  }

  tryResumeRun(input: SchedulerResumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.resumeRun(input));
  }

  resumeRun(input: SchedulerResumeInput): SchedulerSnapshot {
    const replay = this.replayIntentIdempotency(input.runId, input.idempotencyKey);
    if (replay) return replay;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "paused") {
      throwSchedulerStoreError({ type: "invalid-control-state", runId: input.runId, command: "resume", status: snapshot.projection.run.status, message: `Cannot resume run from ${snapshot.projection.run.status}.` });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      events: [{ type: "control.resumed", payload: {} }],
    });
  }

  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retryRun(input));
  }

  retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot {
    const replay = this.replayIntentIdempotency(input.runId, input.idempotencyKey);
    if (replay) return replay;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, status: snapshot.projection.run.status, message: `Cannot retry run from ${snapshot.projection.run.status}.` });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      events: [{ type: "control.run_retry_requested", payload: {} }],
    });
  }

  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retry(input));
  }

  retry(input: SchedulerRetryInput): SchedulerSnapshot {
    const idempotencyKey = input.idempotencyKey;
    const replay = this.replayIntentIdempotency(input.runId, idempotencyKey);
    if (replay) return replay;
    const snapshot = this.loadRunSnapshot(input.runId);
    const instance = snapshot.projection.instances[input.targetKey];
    const frame = snapshot.projection.frames[input.targetKey];
    if (!instance && !frame) throwSchedulerStoreError({ type: "missing-retry-target", runId: input.runId, targetKey: input.targetKey, message: `Retry target '${input.targetKey}' was not found.` });
    if (frame && !instance) {
      if (frame.status !== "failed") {
        throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey: input.targetKey, status: frame.status, message: `Frame '${input.targetKey}' cannot be retried from ${frame.status}.` });
      }
      if (frame.frameKind !== "node" && frame.frameKind !== "loop") {
        throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey: input.targetKey, status: frame.status, message: `Frame '${input.targetKey}' is not a retryable public node frame.` });
      }
      const events: SchedulerEvent[] = [{ type: "frame.retry_requested", payload: { frameKey: input.targetKey, source: "control" } }];
      for (const member of ancestorGroupMembersForFrame(snapshot.projection, frame.parentFrameKey)) {
        if (member.status !== "failed") {
          throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey: input.targetKey, status: member.status, message: `Group member '${member.memberKey}' cannot be retried from ${member.status}.` });
        }
        events.push({
          type: "group.member_retry_requested",
          payload: {
            memberKey: member.memberKey,
            readinessSequence: member.readinessSequence,
            source: "control",
          },
        });
      }
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey,
        events,
      });
    }
    if (!instance) throwSchedulerStoreError({ type: "missing-retry-target", runId: input.runId, targetKey: input.targetKey, message: `Retry target '${input.targetKey}' was not found.` });
    if (instance.status !== "failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey: input.targetKey, status: instance.status, message: `Node instance '${input.targetKey}' cannot be retried from ${instance.status}.` });
    }
    const events: SchedulerEvent[] = [
      {
        type: "instance.retry_requested",
        payload: {
          nodeKey: input.targetKey,
          ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
          source: "control",
        },
      },
    ];
    const members = ancestorGroupMembersForNode(snapshot.projection, input.targetKey);
    for (const member of members) {
      if (member.status !== "failed") {
        throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, targetKey: input.targetKey, status: member.status, message: `Group member '${member.memberKey}' cannot be retried from ${member.status}.` });
      }
      events.push({
        type: "group.member_retry_requested",
        payload: {
          memberKey: member.memberKey,
          readinessSequence: member.readinessSequence,
          source: "control",
        },
      });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey,
      events,
    });
  }

  tryCancel(input: SchedulerCancelInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.cancel(input));
  }

  cancel(input: SchedulerCancelInput): SchedulerSnapshot {
    const replay = this.replayIntentIdempotency(input.runId, input.idempotencyKey);
    if (replay) return replay;
    const snapshot = this.loadRunSnapshot(input.runId);
    const targetKey = input.targetKey ?? "root";
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
      events,
    });
  }

  tryMarkExpiredOwnerAttemptsSuperseded(runId: string, ownerEpoch: number): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.markExpiredOwnerAttemptsSuperseded(runId, ownerEpoch));
  }

  markExpiredOwnerAttemptsSuperseded(runId: string, ownerEpoch: number): SchedulerSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwnerEpochExpired(runId, ownerEpoch);
      const attempts = this.db.prepare("SELECT attempt_id, node_key FROM node_attempts WHERE run_id = ? AND owner_epoch = ? AND status = 'started'").all(runId, ownerEpoch) as Array<{ attempt_id: string; node_key: string }>;
      for (const attempt of attempts) {
        const projection = applySchedulerEvents(createSchedulerProjection(runId), this.schedulerEvents(runId));
        const instance = projection.instances[attempt.node_key];
        const members = ancestorGroupMembersForNode(projection, attempt.node_key).filter(member => member.status === "running");
        const events: SchedulerEvent[] = [
          { type: "attempt.superseded", payload: { attemptId: attempt.attempt_id, cancelReason: "superseded" } },
          ...(instance && (instance.status === "running" || instance.status === "awaiting")
            ? [{ type: "instance.requeued", payload: { nodeKey: instance.nodeKey, reason: "superseded", ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }) } } satisfies SchedulerEvent]
            : []),
          ...members.map(member => ({ type: "group.member_requeued", payload: { memberKey: member.memberKey, reason: "superseded", readinessSequence: member.readinessSequence } }) satisfies SchedulerEvent),
        ];
        applySchedulerEvents(createSchedulerProjection(runId), [...this.schedulerEvents(runId), ...events]);
        const sequence = this.nextSequence(runId);
        for (const [index, event] of events.entries()) {
          this.db.prepare(`
            INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(runId, sequence + index, event.type, eventNodeKey(event) ?? attempt.node_key, encodeSchedulerPayload(event.payload), now, `supersede:${runId}:${attempt.attempt_id}:${index}`);
        }
      }
      this.syncSchedulerProjectionTables(runId, now);
      this.syncPublicRunProjection(runId, now);
      this.db.exec("COMMIT");
      return this.loadRunSnapshot(runId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private schedulerEvents(runId: string): SchedulerEvent[] {
    return schedulerEvents(this.db, runId);
  }

  private currentVersion(runId: string): number {
    return this.nextSequence(runId) - 1;
  }

  private nextSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as CountRow | undefined;
    return row?.count ?? 1;
  }

  private requireOwnerEpoch(runId: string, ownerEpoch: number): void {
    const row = this.db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
    const now = new Date().toISOString();
    if (!row || row.owner_epoch !== ownerEpoch || row.released_at !== null || row.lease_expires_at <= now) {
      throwSchedulerStoreError({ type: "owner-epoch-inactive", runId, ownerEpoch, message: `Run '${runId}' scheduler owner epoch is not active.` });
    }
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
    const payload = decodeSchedulerPayload(row.payload_json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId: row.run_id, message: `Scheduler idempotency key '${idempotencyKey}' conflicts with non-scheduler event.` });
    }
    return { run_id: row.run_id, type: row.type, payload };
  }

  private groupMemberStartedEventsForNode(runId: string, nodeKey: string): Array<Extract<SchedulerEvent, { type: "group.member_started" }>> {
    const projection = applySchedulerEvents(createSchedulerProjection(runId), this.schedulerEvents(runId));
    return ancestorGroupMembersForNode(projection, nodeKey)
      .filter(member => member.status === "ready")
      .map(member => ({ type: "group.member_started", payload: { memberKey: member.memberKey } }));
  }

  private groupMemberResultEventForNode(runId: string, nodeKey: string, result: AttemptCommitInput["result"]): Extract<SchedulerEvent, { type: "group.member_completed" | "group.member_failed" | "group.member_cancelled" }> | undefined {
    const projection = applySchedulerEvents(createSchedulerProjection(runId), this.schedulerEvents(runId));
    const member = projection.groupMembers[nodeKey];
    if (!member || member.status !== "running") return undefined;
    if (result.status === "completed") {
      return { type: "group.member_completed", payload: { memberKey: member.memberKey, completionSequence: this.nextSequence(runId), ...(result.output === undefined ? {} : { output: result.output }) } };
    }
    if (result.status === "cancelled") return { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason: result.reason } };
    return { type: "group.member_failed", payload: { memberKey: member.memberKey, error: { reason: result.reason }, terminalReason: result.status === "timed_out" ? "timed_out" : result.reason } };
  }

  private replayAppendIdempotency(commit: SchedulerCommit): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT event_count, event_digest
      FROM scheduler_commits
      WHERE run_id = ? AND idempotency_key = ?
    `).get(commit.runId, commit.idempotencyKey) as { event_count: number; event_digest: string } | undefined;
    if (!row) return undefined;
    if (row.event_count !== commit.events.length || row.event_digest !== schedulerCommitDigest(commit.events)) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: commit.idempotencyKey, runId: commit.runId, message: `Scheduler commit idempotency key '${commit.idempotencyKey}' conflicts with different events.` });
    }
    return this.loadRunSnapshot(commit.runId);
  }

  private replayIntentIdempotency(runId: string, idempotencyKey: string): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT run_id
      FROM scheduler_commits
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as { run_id: string } | undefined;
    if (!row) return undefined;
    if (row.run_id !== runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId, message: `Scheduler intent idempotency key '${idempotencyKey}' conflicts with another run.` });
    return this.loadRunSnapshot(runId);
  }

  private syncSchedulerProjectionTables(runId: string, now: string): void {
    const projection = applySchedulerEvents(createSchedulerProjection(runId), this.schedulerEvents(runId));
    const existingAttempts = new Map((this.db.prepare("SELECT attempt_id, started_at, finished_at FROM node_attempts WHERE run_id = ?").all(runId) as Array<{ attempt_id: string; started_at: string; finished_at: string | null }>)
      .map(row => [row.attempt_id, row]));
    const existingSignalWaits = new Map((this.db.prepare("SELECT node_key, consumed_at, timed_out_at FROM signal_waits WHERE run_id = ?").all(runId) as Array<{ node_key: string; consumed_at: string | null; timed_out_at: string | null }>)
      .map(row => [row.node_key, row]));
    this.db.prepare("DELETE FROM scheduler_frames WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM node_instances WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM node_attempts WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM group_members WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM signal_waits WHERE run_id = ?").run(runId);

    for (const frame of Object.values(projection.frames)) {
      this.db.prepare(`
        INSERT INTO scheduler_frames (
          run_id, frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
          terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        frame.instancePath === undefined ? null : stableJson(frame.instancePath as unknown as JsonValue),
        stableJson(frame.scope),
        frame.loop === undefined ? null : stableJson(frame.loop),
        frame.result === undefined ? null : stableJson(frame.result),
        frame.error === undefined ? null : stableJson(frame.error),
        now,
        now,
      );
    }

    for (const instance of Object.values(projection.instances)) {
      this.db.prepare(`
        INSERT INTO node_instances (
          run_id, node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
          readiness_sequence, output_json, error_json, accepted_attempt_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.parentFrameKey ?? null,
        stableJson(instance.instancePath as unknown as JsonValue),
        instance.status,
        instance.statusReason ?? null,
        instance.readinessSequence ?? null,
        instance.output === undefined ? null : stableJson(instance.output),
        instance.error === undefined ? null : stableJson(instance.error),
        instance.acceptedAttemptId ?? null,
        now,
        now,
      );
    }

    for (const attempt of Object.values(projection.attempts)) {
      const existing = existingAttempts.get(attempt.attemptId);
      this.db.prepare(`
        INSERT INTO node_attempts (
          run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch, status, deadline_at,
          started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.runId,
        attempt.attemptId,
        attempt.nodeKey,
        attempt.nodeId,
        attempt.attemptNo,
        attempt.ownerEpoch,
        attempt.status,
        attempt.deadlineAt ?? null,
        existing?.started_at ?? now,
        attempt.status === "started" ? null : existing?.finished_at ?? now,
        attempt.result === undefined ? null : stableJson(attempt.result),
        attempt.error === undefined ? null : stableJson(attempt.error),
        attempt.terminalReason ?? null,
        attempt.cancelReason ?? null,
      );
    }

    for (const member of Object.values(projection.groupMembers)) {
      this.db.prepare(`
        INSERT INTO group_members (
          run_id, group_key, member_key, member_kind, branch_id, item_key, item_index, item_json, child_frame_key,
          status, readiness_sequence, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        member.runId,
        member.groupKey,
        member.memberKey,
        member.memberKind,
        member.branchId ?? null,
        member.itemKey === undefined ? null : String(member.itemKey),
        member.itemIndex ?? null,
        member.item === undefined ? null : stableJson(member.item),
        member.childFrameKey ?? null,
        member.status,
        member.readinessSequence,
        member.completionSequence ?? null,
        member.acceptedRank ?? null,
        member.terminalReason ?? null,
        member.output === undefined ? null : stableJson(member.output),
        member.error === undefined ? null : stableJson(member.error),
        now,
        now,
      );
    }

    for (const wait of Object.values(projection.signalWaits)) {
      const existing = existingSignalWaits.get(wait.nodeKey);
      this.db.prepare(`
        INSERT INTO signal_waits (
          run_id, node_key, node_id, status, payload_json, payload_digest, command_idempotency_key,
          deadline_at, consumed_at, timed_out_at, terminal_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        wait.runId,
        wait.nodeKey,
        wait.nodeId,
        wait.status,
        wait.payload === undefined ? null : stableJson(wait.payload),
        wait.payloadDigest ?? null,
        wait.commandIdempotencyKey ?? null,
        wait.deadlineAt ?? null,
        wait.status === "consumed" ? existing?.consumed_at ?? now : null,
        wait.status === "timed_out" ? existing?.timed_out_at ?? now : null,
        wait.terminalReason ?? null,
      );
    }
  }

  private syncPublicRunProjection(runId: string, now: string): void {
    const schedulerEvents = this.schedulerEvents(runId);
    const projection = applySchedulerEvents(createSchedulerProjection(runId), schedulerEvents);
    const current = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    const hasTargetedRetry = schedulerEvents.some(event => event.type === "instance.retry_requested" || event.type === "frame.retry_requested");
    if (current?.status === "failed" && projection.run.status === "pending" && Object.keys(projection.frames).length === 0) {
      this.db.prepare("UPDATE runs SET status = 'pending', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM node_states WHERE run_id = ?").run(runId);
      return;
    }
    if (!current || current.status === "completed" || current.status === "canceled" || (current.status === "failed" && !hasTargetedRetry)) return;
    this.syncPublicNodeStates(projection, now);
    const root = projection.frames.root;
    if (projection.run.status === "completed") {
      const output = root?.result ?? {};
      this.db.prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = ? WHERE run_id = ?").run(stableJson(output), runId);
      this.insertPublicRunEvent(runId, "run.completed", { output }, now, `scheduler-public:completed:${runId}:${rootTerminalEventCount(this.schedulerEvents(runId), "frame.completed")}`);
      return;
    }
    if (projection.run.status === "failed") {
      const error = root?.error ?? { reason: root?.terminalReason ?? "scheduler_failed" };
      this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.failed", error, now, `scheduler-public:failed:${runId}:${rootTerminalEventCount(this.schedulerEvents(runId), "frame.failed")}`);
      return;
    }
    if (projection.run.status === "canceled") {
      this.db.prepare("UPDATE runs SET status = 'canceled', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.canceled", { reason: root?.terminalReason ?? "operator_cancelled" }, now, `scheduler-public:canceled:${runId}:${rootTerminalEventCount(this.schedulerEvents(runId), "frame.cancelled")}`);
      return;
    }
    if (projection.run.status === "paused") {
      this.db.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(now, runId);
      return;
    }
    const hasAwaiting = Object.values(projection.instances).some(instance => instance.status === "awaiting")
      || Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
    const status = hasAwaiting ? "awaiting" : "pending";
    if (current.status === "failed") {
      this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      return;
    }
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(status, now, runId);
  }

  private syncPublicNodeStates(projection: ReturnType<typeof createSchedulerProjection>, now: string): void {
    const nodeKeys = Object.keys(projection.instances);
    const dynamicNodeIds = [...new Set(Object.values(projection.instances)
      .filter(instance => instance.nodeKey !== instance.nodeId)
      .map(instance => instance.nodeId))];
    if (dynamicNodeIds.length > 0) {
      const placeholders = dynamicNodeIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key = node_id AND node_id IN (${placeholders})`).run(projection.run.runId, ...dynamicNodeIds);
    }
    const historicalNodeKeys = schedulerEvents(this.db, projection.run.runId)
      .filter(event => event.type === "instance.ready")
      .map(event => event.payload.nodeKey)
      .filter(nodeKey => !nodeKeys.includes(nodeKey));
    if (historicalNodeKeys.length > 0) {
      const placeholders = historicalNodeKeys.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key IN (${placeholders})`).run(projection.run.runId, ...historicalNodeKeys);
    }
    for (const instance of Object.values(projection.instances)) {
      this.db.prepare(`
        INSERT INTO node_states (run_id, node_key, node_id, status, output_json, error_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          status = excluded.status,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          updated_at = excluded.updated_at
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.status,
        instance.output === undefined ? null : stableJson(instance.output),
        instance.error === undefined ? null : stableJson(instance.error),
        now,
        now,
      );
    }
  }

  private insertPublicRunEvent(runId: string, type: "run.completed" | "run.failed" | "run.canceled", payload: JsonValue, now: string, idempotencyKey: string): void {
    const existing = this.db.prepare("SELECT id FROM run_events WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return;
    this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(runId, this.nextSequence(runId), type, stableJson(payload), now, idempotencyKey);
  }
}

function schedulerEvents(db: DatabaseSync, runId: string): SchedulerEvent[] {
  const rows = db.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<{ type: string; payload_json: string }>;
  return rows.flatMap(row => {
    const payload = decodeSchedulerPayload(row.payload_json);
    return payload && isSchedulerEventType(row.type) ? [{ type: row.type, payload } as SchedulerEvent] : [];
  });
}

function schedulerEventsForReplay(db: DatabaseSync, runId: string): { events: SchedulerEvent[]; issues: string[] } {
  const rows = db.prepare("SELECT sequence, type, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<{ sequence: number; type: string; payload_json: string }>;
  const events: SchedulerEvent[] = [];
  const issues: string[] = [];
  for (const row of rows) {
    const decoded = decodeSchedulerPayloadForReplay(row.payload_json);
    if (decoded.status === "legacy") continue;
    if (decoded.status === "invalid") {
      issues.push(`Scheduler event '${row.type}' at sequence ${row.sequence} has an invalid scheduler envelope.`);
      continue;
    }
    if (!isSchedulerEventType(row.type)) {
      issues.push(`Scheduler event '${row.type}' at sequence ${row.sequence} has an unknown scheduler event type.`);
      continue;
    }
    if (decoded.status !== "event") continue;
    events.push({ type: row.type, payload: decoded.payload } as SchedulerEvent);
  }
  return { events, issues };
}

function decodeSchedulerPayloadForReplay(payloadJson: string): { status: "event"; payload: Record<string, unknown> } | { status: "legacy" | "invalid" } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payloadJson) as unknown;
  } catch {
    return { status: "invalid" };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { status: "legacy" };
  if (!("schedulerEventVersion" in envelope)) return { status: "legacy" };
  const payload = (envelope as { payload?: unknown }).payload;
  if ((envelope as { schedulerEventVersion?: unknown }).schedulerEventVersion !== 1 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: "invalid" };
  }
  return { status: "event", payload: payload as Record<string, unknown> };
}

function publicStatusFromSchedulerProjection(projection: SchedulerProjection): RunStatus {
  if (projection.run.status === "completed" || projection.run.status === "failed" || projection.run.status === "paused" || projection.run.status === "canceled") return projection.run.status;
  const awaiting = Object.values(projection.instances).some(instance => instance.status === "awaiting")
    || Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
  return awaiting ? "awaiting" : "pending";
}

function rootTerminalEventCount(events: readonly SchedulerEvent[], type: "frame.completed" | "frame.failed" | "frame.cancelled"): number {
  return events.filter(event => event.type === type && event.payload.frameKey === "root").length;
}

function compareSchedulerProjectionTables(db: DatabaseSync, runId: string, projection: SchedulerProjection): string[] {
  return [
    compareSchedulerProjectionTable("scheduler_frames", () => readSchedulerFrames(db, runId), schedulerFramesProjection(projection)),
    compareSchedulerProjectionTable("node_instances", () => readNodeInstances(db, runId), nodeInstancesProjection(projection)),
    compareSchedulerProjectionTable("node_attempts", () => readNodeAttempts(db, runId), nodeAttemptsProjection(projection)),
    compareSchedulerProjectionTable("group_members", () => readGroupMembers(db, runId), groupMembersProjection(projection)),
    compareSchedulerProjectionTable("signal_waits", () => readSignalWaits(db, runId), signalWaitsProjection(projection)),
  ].filter(issue => issue !== undefined);
}

function compareSchedulerProjectionTable(table: string, readActual: () => Record<string, unknown>, expected: Record<string, unknown>): string | undefined {
  try {
    return sameStableJson(readActual(), expected)
      ? undefined
      : `Scheduler projection table '${table}' does not match scheduler event stream.`;
  } catch (error) {
    return `Scheduler projection table '${table}' could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function schedulerFramesProjection(projection: SchedulerProjection): Record<string, unknown> {
  return Object.fromEntries(Object.values(projection.frames).map(frame => [frame.frameKey, withoutUndefined({
    parentFrameKey: frame.parentFrameKey,
    nodeKey: frame.nodeKey,
    nodeId: frame.nodeId,
    frameKind: frame.frameKind,
    status: frame.status,
    strategy: frame.strategy,
    terminalReason: frame.terminalReason,
    instancePath: frame.instancePath,
    scope: frame.scope,
    loop: frame.loop,
    result: frame.result,
    error: frame.error,
  })]));
}

function readSchedulerFrames(db: DatabaseSync, runId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
      terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json
    FROM scheduler_frames
    WHERE run_id = ?
    ORDER BY frame_key
  `).all(runId) as Array<Record<string, string | null>>;
  return Object.fromEntries(rows.map(row => [String(row.frame_key), withoutUndefined({
    parentFrameKey: nullableString(row.parent_frame_key),
    nodeKey: nullableString(row.node_key),
    nodeId: nullableString(row.node_id),
    frameKind: String(row.frame_kind),
    status: String(row.status),
    strategy: nullableString(row.strategy),
    terminalReason: nullableString(row.terminal_reason),
    instancePath: parseOptionalJson(row.instance_path_json),
    scope: parseRequiredJson(row.scope_json, "scheduler_frames.scope_json"),
    loop: parseOptionalJson(row.loop_json),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
  })]));
}

function nodeInstancesProjection(projection: SchedulerProjection): Record<string, unknown> {
  return Object.fromEntries(Object.values(projection.instances).map(instance => [instance.nodeKey, withoutUndefined({
    nodeId: instance.nodeId,
    parentFrameKey: instance.parentFrameKey,
    instancePath: instance.instancePath,
    status: instance.status,
    statusReason: instance.statusReason,
    readinessSequence: instance.readinessSequence,
    output: instance.output,
    error: instance.error,
    acceptedAttemptId: instance.acceptedAttemptId,
  })]));
}

function readNodeInstances(db: DatabaseSync, runId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
      readiness_sequence, output_json, error_json, accepted_attempt_id
    FROM node_instances
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | number | null>>;
  return Object.fromEntries(rows.map(row => [String(row.node_key), withoutUndefined({
    nodeId: String(row.node_id),
    parentFrameKey: nullableString(row.parent_frame_key),
    instancePath: parseRequiredJson(row.instance_path_json, "node_instances.instance_path_json"),
    status: String(row.status),
    statusReason: nullableString(row.status_reason),
    readinessSequence: nullableNumber(row.readiness_sequence),
    output: parseOptionalJson(row.output_json),
    error: parseOptionalJson(row.error_json),
    acceptedAttemptId: nullableString(row.accepted_attempt_id),
  })]));
}

function nodeAttemptsProjection(projection: SchedulerProjection): Record<string, unknown> {
  return Object.fromEntries(Object.values(projection.attempts).map(attempt => [attempt.attemptId, withoutUndefined({
    nodeKey: attempt.nodeKey,
    nodeId: attempt.nodeId,
    attemptNo: attempt.attemptNo,
    ownerEpoch: attempt.ownerEpoch,
    status: attempt.status,
    deadlineAt: attempt.deadlineAt,
    result: attempt.result,
    error: attempt.error,
    terminalReason: attempt.terminalReason,
    cancelReason: attempt.cancelReason,
  })]));
}

function readNodeAttempts(db: DatabaseSync, runId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT attempt_id, node_key, node_id, attempt_no, owner_epoch, status, deadline_at,
      result_json, error_json, terminal_reason, cancel_reason
    FROM node_attempts
    WHERE run_id = ?
    ORDER BY attempt_id
  `).all(runId) as Array<Record<string, string | number | null>>;
  return Object.fromEntries(rows.map(row => [String(row.attempt_id), withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    attemptNo: Number(row.attempt_no),
    ownerEpoch: Number(row.owner_epoch),
    status: String(row.status),
    deadlineAt: nullableString(row.deadline_at),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
    terminalReason: nullableString(row.terminal_reason),
    cancelReason: nullableString(row.cancel_reason),
  })]));
}

function groupMembersProjection(projection: SchedulerProjection): Record<string, unknown> {
  return Object.fromEntries(Object.values(projection.groupMembers).map(member => [member.memberKey, withoutUndefined({
    groupKey: member.groupKey,
    memberKind: member.memberKind,
    branchId: member.branchId,
    itemKey: member.itemKey === undefined ? undefined : String(member.itemKey),
    itemIndex: member.itemIndex,
    item: member.item,
    childFrameKey: member.childFrameKey,
    status: member.status,
    readinessSequence: member.readinessSequence,
    completionSequence: member.completionSequence,
    acceptedRank: member.acceptedRank,
    terminalReason: member.terminalReason,
    output: member.output,
    error: member.error,
  })]));
}

function readGroupMembers(db: DatabaseSync, runId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT group_key, member_key, member_kind, branch_id, item_key, item_index, item_json, child_frame_key,
      status, readiness_sequence, completion_sequence, accepted_rank, terminal_reason, output_json, error_json
    FROM group_members
    WHERE run_id = ?
    ORDER BY member_key
  `).all(runId) as Array<Record<string, string | number | null>>;
  return Object.fromEntries(rows.map(row => [String(row.member_key), withoutUndefined({
    groupKey: String(row.group_key),
    memberKind: String(row.member_kind),
    branchId: nullableString(row.branch_id),
    itemKey: nullableString(row.item_key),
    itemIndex: nullableNumber(row.item_index),
    item: parseOptionalJson(row.item_json),
    childFrameKey: nullableString(row.child_frame_key),
    status: String(row.status),
    readinessSequence: Number(row.readiness_sequence),
    completionSequence: nullableNumber(row.completion_sequence),
    acceptedRank: nullableNumber(row.accepted_rank),
    terminalReason: nullableString(row.terminal_reason),
    output: parseOptionalJson(row.output_json),
    error: parseOptionalJson(row.error_json),
  })]));
}

function signalWaitsProjection(projection: SchedulerProjection): Record<string, unknown> {
  return Object.fromEntries(Object.values(projection.signalWaits).map(wait => [wait.nodeKey, withoutUndefined({
    nodeId: wait.nodeId,
    status: wait.status,
    payload: wait.payload,
    payloadDigest: wait.payloadDigest,
    commandIdempotencyKey: wait.commandIdempotencyKey,
    deadlineAt: wait.deadlineAt,
    terminalReason: wait.terminalReason,
  })]));
}

function readSignalWaits(db: DatabaseSync, runId: string): Record<string, unknown> {
  const rows = db.prepare(`
    SELECT node_key, node_id, status, payload_json, payload_digest, command_idempotency_key,
      deadline_at, terminal_reason
    FROM signal_waits
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return Object.fromEntries(rows.map(row => [String(row.node_key), withoutUndefined({
    nodeId: String(row.node_id),
    status: String(row.status),
    payload: parseOptionalJson(row.payload_json),
    payloadDigest: nullableString(row.payload_digest),
    commandIdempotencyKey: nullableString(row.command_idempotency_key),
    deadlineAt: nullableString(row.deadline_at),
    terminalReason: nullableString(row.terminal_reason),
  })]));
}

function readRunDynamicFrames(db: DatabaseSync, runId: string): RunDynamicFrame[] {
  const rows = db.prepare(`
    SELECT frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
      terminal_reason, instance_path_json, result_json, error_json
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
    strategy: nullableString(row.strategy),
    terminalReason: nullableString(row.terminal_reason),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
  }) as RunDynamicFrame);
}

function readRunDynamicNodeInstances(db: DatabaseSync, runId: string): RunDynamicNodeInstance[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
      output_json, error_json, accepted_attempt_id
    FROM node_instances
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    parentFrameKey: nullableString(row.parent_frame_key),
    instancePath: parseOptionalJson(row.instance_path_json),
    status: String(row.status),
    statusReason: nullableString(row.status_reason),
    output: parseOptionalJson(row.output_json),
    error: parseOptionalJson(row.error_json),
    acceptedAttemptId: nullableString(row.accepted_attempt_id),
  }) as RunDynamicNodeInstance);
}

function readRunDynamicAttempts(db: DatabaseSync, runId: string): RunDynamicAttempt[] {
  const rows = db.prepare(`
    SELECT attempt_id, node_key, node_id, attempt_no, status, deadline_at,
      result_json, error_json, terminal_reason, cancel_reason
    FROM node_attempts
    WHERE run_id = ?
    ORDER BY attempt_id
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => withoutUndefined({
    attemptId: String(row.attempt_id),
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    attemptNo: Number(row.attempt_no),
    status: String(row.status),
    deadlineAt: nullableString(row.deadline_at),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
    terminalReason: nullableString(row.terminal_reason),
    cancelReason: nullableString(row.cancel_reason),
  }) as RunDynamicAttempt);
}

function readRunDynamicGroupMembers(db: DatabaseSync, runId: string): RunDynamicGroupMember[] {
  const rows = db.prepare(`
    SELECT group_key, member_key, member_kind, branch_id, item_key, item_index, item_json, child_frame_key,
      status, completion_sequence, accepted_rank, terminal_reason, output_json, error_json
    FROM group_members
    WHERE run_id = ?
    ORDER BY member_key
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => withoutUndefined({
    groupKey: String(row.group_key),
    memberKey: String(row.member_key),
    memberKind: String(row.member_kind),
    branchId: nullableString(row.branch_id),
    itemKey: nullableString(row.item_key),
    itemIndex: nullableNumber(row.item_index),
    item: parseOptionalJson(row.item_json),
    childFrameKey: nullableString(row.child_frame_key),
    status: String(row.status),
    completionSequence: nullableNumber(row.completion_sequence),
    acceptedRank: nullableNumber(row.accepted_rank),
    terminalReason: nullableString(row.terminal_reason),
    output: parseOptionalJson(row.output_json),
    error: parseOptionalJson(row.error_json),
  }) as RunDynamicGroupMember);
}

function readRunDynamicSignalWaits(db: DatabaseSync, runId: string): RunDynamicSignalWait[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, status, deadline_at, terminal_reason
    FROM signal_waits
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    status: String(row.status),
    deadlineAt: nullableString(row.deadline_at),
    terminalReason: nullableString(row.terminal_reason),
  }) as RunDynamicSignalWait);
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

function sameStableJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function parseOptionalJson(value: unknown): unknown {
  return value === null || value === undefined ? undefined : JSON.parse(String(value));
}

function parseRequiredJson(value: unknown, field: string): unknown {
  if (value === null || value === undefined) throw new Error(`${field} is missing.`);
  return JSON.parse(String(value));
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
    return { type: "attempt.timed_out", payload: { attemptId: input.attemptId, error: { reason: input.result.reason, nodeKey } } };
  }
  if (input.result.status === "cancelled") {
    return { type: "attempt.cancelled", payload: { attemptId: input.attemptId, cancelReason: input.result.reason } };
  }
  return { type: "attempt.failed", payload: { attemptId: input.attemptId, error: { reason: input.result.reason, nodeKey }, terminalReason: input.result.reason } };
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
    && (payload.deadlineAt ?? undefined) === input.deadlineAt;
}

function encodeSchedulerPayload(payload: object): string {
  return stableJson({ schedulerEventVersion: 1, payload });
}

function decodeSchedulerPayload(payloadJson: string): Record<string, unknown> | undefined {
  const envelope = JSON.parse(payloadJson) as unknown;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  const payload = (envelope as { schedulerEventVersion?: unknown; payload?: unknown }).payload;
  if ((envelope as { schedulerEventVersion?: unknown }).schedulerEventVersion !== 1 || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as Record<string, unknown>;
}

function schedulerCommitDigest(events: SchedulerEvent[]): string {
  return createHash("sha256").update(stableJson(events as unknown as JsonValue)).digest("hex");
}

function schedulerEventIdempotencyKey(runId: string, commitKey: string, index: number): string {
  const digest = createHash("sha256").update(commitKey).digest("hex");
  return `scheduler-event:${runId}:${digest}:${index}`;
}

function derivedIdempotencyKey(idempotencyKey: string, suffix: string): string {
  return `${idempotencyKey}:${suffix}`;
}

function isSchedulerEventType(type: string): type is SchedulerEvent["type"] {
  return [
    "control.paused",
    "control.resumed",
    "control.run_retry_requested",
    "frame.started",
    "frame.completed",
    "frame.failed",
    "frame.cancelled",
    "frame.retry_requested",
    "frame.loop_advanced",
    "instance.ready",
    "instance.started",
    "instance.awaiting",
    "instance.requeued",
    "instance.retry_requested",
    "instance.completed",
    "instance.failed",
    "instance.cancelled",
    "attempt.started",
    "attempt.completed",
    "attempt.failed",
    "attempt.timed_out",
    "attempt.cancelled",
    "attempt.superseded",
    "group.started",
    "group.member_ready",
    "group.member_started",
    "group.member_requeued",
    "group.member_retry_requested",
    "group.member_completed",
    "group.member_failed",
    "group.member_cancelled",
    "group.completed",
    "group.failed",
    "group.cancelled",
    "branch.decided",
    "signal.awaiting",
    "signal.consumed",
    "signal.timed_out",
    "signal.cancelled",
  ].includes(type);
}

function openDatabase(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, readOnly });
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supervisor_lease (
      workspace_realpath TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      pid INTEGER,
      endpoint TEXT,
      auth_token_hash TEXT,
      heartbeat_at TEXT,
      protocol_version INTEGER NOT NULL,
      package_version TEXT NOT NULL,
      node_version TEXT NOT NULL,
      exec_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_generation INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      workflow_entry TEXT NOT NULL,
      ir_digest TEXT NOT NULL,
      source_graph_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      workflow_ir_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      agent_overrides_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      lock_json TEXT NOT NULL,
      package_lock_digest TEXT,
      run_dir TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS node_states (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      released_at TEXT,
      reason TEXT
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
      owner_id TEXT,
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
      item_key TEXT,
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
      payload_digest TEXT,
      command_idempotency_key TEXT,
      deadline_at TEXT,
      consumed_at TEXT,
      timed_out_at TEXT,
      terminal_reason TEXT,
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

    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (1, datetime('now'));
  `);
  addColumnIfMissing(db, "commands", "owner_generation", "INTEGER");
  addColumnIfMissing(db, "scheduler_frames", "instance_path_json", "TEXT");
  addColumnIfMissing(db, "scheduler_frames", "loop_json", "TEXT");
  addColumnIfMissing(db, "node_instances", "instance_path_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "group_members", "item_json", "TEXT");
  addColumnIfMissing(db, "group_members", "child_frame_key", "TEXT");
  addColumnIfMissing(db, "group_members", "completion_sequence", "INTEGER");
  addColumnIfMissing(db, "run_inputs", "agent_overrides_json", "TEXT NOT NULL DEFAULT '{}'");
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function parseAgentOverrides(json: string | null | undefined): AgentOverrideMap {
  if (!json) return {};
  const value = JSON.parse(json) as JsonValue;
  return normalizeAgentOverrideShape(value, undefined);
}

export function validateAgentOverrides(ir: WorkflowIR, input: AgentOverrideMap | undefined): AgentOverrideMap {
  return normalizeAgentOverrides(ir, input);
}

function normalizeAgentOverrides(ir: WorkflowIR, input: AgentOverrideMap | undefined, inherited: AgentOverrideMap = {}): AgentOverrideMap {
  const base = Object.fromEntries(Object.entries(inherited).filter(([name]) => ir.agents[name])) as AgentOverrideMap;
  if (input === undefined) return base;
  const incoming = normalizeAgentOverrideShape(input as JsonValue, ir);
  const merged = Object.fromEntries(Object.entries(incoming).map(([name, override]) => {
    const previous = base[name] ?? {};
    const declared = ir.agents[name]!;
    return [name, mergeAgentOverride(declared, previous, override)];
  }));
  return { ...base, ...merged };
}

function normalizeAgentOverrideShape(input: JsonValue, ir: WorkflowIR | undefined): AgentOverrideMap {
  if (!isJsonRecord(input)) throw new Error("Agent overrides must be a JSON object keyed by declared agent name.");
  return Object.fromEntries(Object.entries(input).map(([name, value]) => {
    if (ir && !ir.agents[name]) throw new Error(`Agent override '${name}' does not reference a declared agent.`);
    if (!isJsonRecord(value)) throw new Error(`Agent override '${name}' must be a JSON object.`);
    if ("options" in value) throw new Error(`Agent override '${name}' must not use options.`);
    if ("policy" in value) throw new Error(`Agent override '${name}' must use permissionMode, not policy.`);
    if ("kind" in value) throw new Error(`Agent override '${name}' must not include kind.`);
    const allowedKeys = new Set(["use", "command", "model", "permissionMode", "agentMode", "cwd", "env"]);
    const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`Agent override '${name}' must not include '${unknownKey}'.`);
    const hasUse = value.use !== undefined;
    const hasCommand = value.command !== undefined;
    if (hasUse && hasCommand) throw new Error(`Agent override '${name}' must not specify both use and command.`);
    const override = stripUndefined({
      use: optionalNonEmptyString(value.use, `Agent override '${name}' use`),
      command: optionalNonEmptyString(value.command, `Agent override '${name}' command`),
      model: optionalString(value.model, `Agent override '${name}' model`),
      permissionMode: optionalPermissionMode(value.permissionMode, `Agent override '${name}' permissionMode`),
      agentMode: optionalNonEmptyString(value.agentMode, `Agent override '${name}' agentMode`),
      cwd: optionalString(value.cwd, `Agent override '${name}' cwd`),
      env: optionalStringRecord(value.env, `Agent override '${name}' env`),
    }) as AgentOverrideSpec;
    return [name, override];
  }));
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
  return stripUndefined(merged) as AgentOverrideSpec;
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
    cwd: override.cwd === undefined ? definition.cwd : valueToExprIR(override.cwd),
    env: override.env === undefined ? definition.env : Object.fromEntries(Object.entries(override.env).map(([key, value]) => [key, valueToExprIR(value)])),
  };
  if (override.command !== undefined) return stripUndefined({ kind: "agent_command", command: override.command, ...shared }) as AgentDefinitionIR;
  if (override.use !== undefined) return stripUndefined({ kind: "agent_definition", use: override.use, ...shared }) as AgentDefinitionIR;
  return stripUndefined({ ...definition, ...shared }) as AgentDefinitionIR;
}

function agentIdentity(definition: AgentDefinitionIR, override: AgentOverrideSpec): { kind: "use" | "command"; value: string } {
  if (override.command !== undefined) return { kind: "command", value: override.command };
  if (override.use !== undefined) return { kind: "use", value: override.use };
  return definition.kind === "agent_command"
    ? { kind: "command", value: definition.command }
    : { kind: "use", value: definition.use };
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`${label} must be a string.`);
}

function optionalNonEmptyString(value: JsonValue | undefined, label: string): string | undefined {
  const out = optionalString(value, label);
  if (out !== undefined && out.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return out;
}

function optionalPermissionMode(value: JsonValue | undefined, label: string): AgentOverrideSpec["permissionMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "approve-reads" || value === "approve-all" || value === "deny-all") return value;
  throw new Error(`${label} must be approve-reads, approve-all, or deny-all.`);
}

function optionalStringRecord(value: JsonValue | undefined, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) throw new Error(`${label} must be a JSON object with string values.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, optionalString(item, `${label}.${key}`)!]));
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function toRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as RunStatus,
    workflowEntry: String(row.workflow_entry),
    irDigest: String(row.ir_digest),
    sourceGraphDigest: String(row.source_graph_digest),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPendingCommand(row: Record<string, unknown>): PendingControlCommand {
  const type = parseControlCommandType(row.type);
  const status = parseControlCommandStatus(row.status);
  const payload = parseCommandPayload(type, status, JSON.parse(String(row.payload_json)) as JsonValue);
  const command = {
    id: String(row.id),
    ...(row.run_id === null ? {} : { runId: String(row.run_id) }),
    type,
    status,
    idempotencyKey: String(row.idempotency_key),
    payload,
  };
  if (type !== "shutdown" && typeof command.runId !== "string") throw new Error(`Command '${command.id}' has no run id.`);
  if (type === "shutdown" && command.runId !== undefined) throw new Error(`Shutdown command '${command.id}' must not have a run id.`);
  return command as PendingControlCommand;
}

function parseControlCommandType(value: unknown): ControlCommandType {
  if (value === "pause" || value === "resume" || value === "retry" || value === "fork" || value === "signal" || value === "cancel" || value === "shutdown") return value;
  throw new Error(`Unsupported command type '${String(value)}'.`);
}

function parseControlCommandStatus(value: unknown): ControlCommandStatus {
  if (value === "pending" || value === "running" || value === "applied" || value === "failed") return value;
  throw new Error(`Unsupported command status '${String(value)}'.`);
}

function parseCommandPayload(type: ControlCommandType, status: ControlCommandStatus, value: JsonValue): CommandPayload<ControlCommandType> | AppliedCommandPayload | FailedCommandPayload {
  if (!isJsonRecord(value)) throw new Error(`Command '${type}' payload must be a JSON object.`);
  if (status === "applied") return appliedCommandPayload(value);
  if (status === "failed") return failedCommandPayload(value);
  switch (type) {
    case "pause": return pauseCommandPayload(value);
    case "resume": return emptyCommandPayload(type, value);
    case "retry": return retryCommandPayload(value);
    case "cancel": return cancelCommandPayload(value);
    case "fork": return forkCommandPayload(value);
    case "signal": return signalCommandPayload(value);
    case "shutdown": return emptyCommandPayload(type, value);
  }
}

function pauseCommandPayload(value: Record<string, JsonValue>): PauseCommandPayload {
  rejectUnknownCommandPayloadKeys("pause", value, ["reason"]);
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("Pause command payload.reason must be a string.");
  return value.reason === undefined ? {} : { reason: value.reason };
}

function retryCommandPayload(value: Record<string, JsonValue>): RetryCommandPayload {
  rejectUnknownCommandPayloadKeys("retry", value, ["target"]);
  if (value.target !== undefined && typeof value.target !== "string") throw new Error("Retry command payload.target must be a string.");
  return value.target === undefined ? {} : { target: value.target };
}

function cancelCommandPayload(value: Record<string, JsonValue>): CancelCommandPayload {
  rejectUnknownCommandPayloadKeys("cancel", value, ["target"]);
  if (value.target !== undefined && typeof value.target !== "string") throw new Error("Cancel command payload.target must be a string.");
  return value.target === undefined ? {} : { target: value.target };
}

function forkCommandPayload(value: Record<string, JsonValue>): ForkCommandPayload {
  rejectUnknownCommandPayloadKeys("fork", value, ["prepared", "input", "agentOverrides"]);
  return {
    ...(value.prepared === undefined ? {} : { prepared: value.prepared }),
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.agentOverrides === undefined ? {} : { agentOverrides: value.agentOverrides }),
  };
}

function signalCommandPayload(value: Record<string, JsonValue>): SignalCommandPayload {
  rejectUnknownCommandPayloadKeys("signal", value, ["node", "payload"]);
  if (typeof value.node !== "string" || value.node.length === 0) throw new Error("Signal command payload.node must be a non-empty string.");
  return { node: value.node, ...(value.payload === undefined ? {} : { payload: value.payload }) };
}

function emptyCommandPayload(type: ControlCommandType, value: Record<string, JsonValue>): EmptyCommandPayload {
  rejectUnknownCommandPayloadKeys(type, value, []);
  return {};
}

function appliedCommandPayload(value: Record<string, JsonValue>): AppliedCommandPayload {
  rejectUnknownCommandPayloadKeys("applied command", value, ["status", "forkRunId", "targetKey"]);
  if (typeof value.status !== "string") throw new Error("Applied command payload.status must be a string.");
  if (value.forkRunId !== undefined && typeof value.forkRunId !== "string") throw new Error("Applied command payload.forkRunId must be a string.");
  if (value.targetKey !== undefined && typeof value.targetKey !== "string") throw new Error("Applied command payload.targetKey must be a string.");
  return {
    status: value.status,
    ...(value.forkRunId === undefined ? {} : { forkRunId: value.forkRunId }),
    ...(value.targetKey === undefined ? {} : { targetKey: value.targetKey }),
  };
}

function failedCommandPayload(value: Record<string, JsonValue>): FailedCommandPayload {
  rejectUnknownCommandPayloadKeys("failed command", value, ["type", "message"]);
  if (typeof value.type !== "string") throw new Error("Failed command payload.type must be a string.");
  if (typeof value.message !== "string") throw new Error("Failed command payload.message must be a string.");
  return { type: value.type, message: value.message };
}

function rejectUnknownCommandPayloadKeys(label: string, value: Record<string, JsonValue>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknownKey = Object.keys(value).find(key => !allowedSet.has(key));
  if (unknownKey) throw new Error(`Command ${label} payload must not include '${unknownKey}'.`);
}

function collectNodeIds(scope: ScopeIR): string[] {
  const ids: string[] = [];
  for (const node of scope.nodes) {
    ids.push(node.id);
    switch (node.kind) {
      case "if":
        ids.push(...collectNodeIds(node.then));
        if (node.else) ids.push(...collectNodeIds(node.else));
        break;
      case "switch":
        for (const c of node.cases) ids.push(...collectNodeIds(c.then));
        if (node.default) ids.push(...collectNodeIds(node.default));
        break;
      case "parallel":
        for (const branch of Object.values(node.branches)) ids.push(...collectNodeIds(branch.scope));
        break;
      case "fanout":
        ids.push(...collectNodeIds(node.do));
        break;
      case "loop":
        ids.push(...collectNodeIds(node.do));
        break;
    }
  }
  return ids;
}

function inheritableCompletedNodeKeys(ir: WorkflowIR, completed: Set<string>): Set<string> {
  const ancestors = nodeAncestors(ir.root);
  return new Set([...completed].filter(nodeKey => (ancestors.get(nodeKey) ?? []).every(parent => completed.has(parent))));
}

function nodeAncestors(scope: ScopeIR, parents: string[] = []): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of scope.nodes) {
    out.set(node.id, parents);
    const childParents = [...parents, node.id];
    switch (node.kind) {
      case "if":
        mergeAncestors(out, nodeAncestors(node.then, childParents));
        if (node.else) mergeAncestors(out, nodeAncestors(node.else, childParents));
        break;
      case "switch":
        for (const c of node.cases) mergeAncestors(out, nodeAncestors(c.then, childParents));
        if (node.default) mergeAncestors(out, nodeAncestors(node.default, childParents));
        break;
      case "parallel":
        for (const branch of Object.values(node.branches)) mergeAncestors(out, nodeAncestors(branch.scope, childParents));
        break;
      case "fanout":
      case "loop":
        mergeAncestors(out, nodeAncestors(node.do, childParents));
        break;
    }
  }
  return out;
}

function nodeSignatures(scope: ScopeIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of scope.nodes) {
    out.set(node.id, stableJson(node));
    switch (node.kind) {
      case "if":
        mergeSignatures(out, nodeSignatures(node.then));
        if (node.else) mergeSignatures(out, nodeSignatures(node.else));
        break;
      case "switch":
        for (const c of node.cases) mergeSignatures(out, nodeSignatures(c.then));
        if (node.default) mergeSignatures(out, nodeSignatures(node.default));
        break;
      case "parallel":
        for (const branch of Object.values(node.branches)) mergeSignatures(out, nodeSignatures(branch.scope));
        break;
      case "fanout":
      case "loop":
        mergeSignatures(out, nodeSignatures(node.do));
        break;
    }
  }
  return out;
}

function mergeSignatures(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) target.set(key, value);
}

function mergeAncestors(target: Map<string, string[]>, source: Map<string, string[]>): void {
  for (const [key, value] of source) target.set(key, value);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function assertJsonValue(value: unknown, path: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${path} is not JSON-serializable.`);
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function sortJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function safeParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function rebuildTerminalProjection(events: Array<{ type: string; payload_json: string }>): { status?: RunStatus; output?: JsonValue } {
  const last = events.at(-1);
  if (!last) return {};
  if (last.type === "run.completed") {
    const payload = safeParseJson(last.payload_json);
    return { status: "completed", ...(payload.ok ? { output: (payload.value as { output?: JsonValue }).output } : {}) };
  }
  if (last.type === "run.failed") return { status: "failed" };
  return {};
}

function evaluateRecordedOutputs(outputs: Record<string, ExprIR>, nodes: Record<string, unknown>, input: JsonValue, meta: Record<string, string>): JsonValue {
  return assertJsonValue(Object.fromEntries(Object.entries(outputs).map(([key, expr]) => [
    key,
    evaluateExpr(expr, {
      input,
      meta,
      nodes: Object.fromEntries(Object.entries(nodes).map(([nodeKey, output]) => [nodeKey, { status: "completed", output }])),
    }),
  ])), "replay output");
}

function forkCompletedOutputJson(args: {
  outputs: Record<string, ExprIR>;
  completedOutputRows: Array<{ nodeKey: string; nodeId: string; output: unknown }>;
  inheritableNodeKeys: Set<string>;
  inputJson: string;
  meta: Record<string, string>;
  sourceRunId: string;
  forkRunId: string;
  artifactIdMap: Record<string, string>;
}): string {
  const nodes = completedOutputMap(args.completedOutputRows
    .filter(row => args.inheritableNodeKeys.has(row.nodeKey))
    .map(row => ({
      ...row,
      output: rewriteArtifactValue(assertJsonValue(row.output, `fork node '${row.nodeKey}' output`), args.sourceRunId, args.forkRunId, args.artifactIdMap),
    })));
  const output = evaluateRecordedOutputs(args.outputs, nodes, JSON.parse(args.inputJson) as JsonValue, args.meta);
  return rewriteArtifactRefs(stableJson(output), args.sourceRunId, args.forkRunId, args.artifactIdMap);
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

function rewriteArtifactRefs(json: string, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): string {
  const value = JSON.parse(json) as JsonValue;
  return stableJson(rewriteArtifactValue(value, sourceRunId, forkRunId, artifactIds));
}

function rewriteArtifactValue(value: JsonValue, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): JsonValue {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds));
  if (value.kind === "artifact" && typeof value.uri === "string") {
    const prefix = `artifact://${sourceRunId}/`;
    if (value.uri.startsWith(prefix)) {
      const sourceArtifactId = value.uri.slice(prefix.length);
      const forkArtifactId = artifactIds[sourceArtifactId];
      if (!forkArtifactId) throw new Error(`Missing fork artifact id for '${sourceArtifactId}'.`);
      return { ...value, uri: `artifact://${forkRunId}/${forkArtifactId}` };
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds),
  ])) as JsonValue;
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

async function verifyCopiedArtifacts(runDir: string, artifacts: ArtifactRow[]): Promise<void> {
  for (const artifact of artifacts) {
    const relativePath = String(artifact.relative_path);
    let bytes: Buffer;
    try {
      bytes = await readContainedFile(runDir, relativePath);
    } catch (error) {
      if (error instanceof PathEscapeError) throw new Error(`Fork artifact '${String(artifact.id)}' has invalid relative path.`);
      throw error;
    }
    const expectedSize = Number(artifact.size);
    const expectedDigest = String(artifact.digest);
    const actualDigest = digest(bytes);
    if (bytes.byteLength !== expectedSize || actualDigest !== expectedDigest) {
      throw new Error(`Fork artifact '${String(artifact.id)}' failed copy verification.`);
    }
  }
}

async function pruneNonInheritedArtifacts(runDir: string, artifacts: ArtifactRow[]): Promise<void> {
  const artifactDir = join(runDir, "artifacts");
  const keep = new Set(artifacts.map(artifact => String(artifact.relative_path)));
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch {
    return;
  }
  await Promise.all(entries.map(entry => pruneArtifactEntry(runDir, join("artifacts", entry), keep)));
}

async function pruneArtifactEntry(runDir: string, relativePath: string, keep: Set<string>): Promise<boolean> {
  const absolutePath = join(runDir, relativePath);
  const info = await lstat(absolutePath);
  if (!info.isDirectory()) {
    if (keep.has(relativePath)) return false;
    await rm(absolutePath, { force: true });
    return true;
  }
  const children = await readdir(absolutePath);
  const removed = await Promise.all(children.map(child => pruneArtifactEntry(runDir, join(relativePath, child), keep)));
  if (removed.every(Boolean)) {
    await rm(absolutePath, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function writePreparedRunFiles(runDir: string, prepared: ForkPreparedWorkflow): Promise<void> {
  await writeFile(join(runDir, "workflow.ir.json"), prepared.irJson);
  await writeFile(join(runDir, "lock.json"), `${JSON.stringify(prepared.lock, null, 2)}\n`);
}

async function verifyFrozenRunFiles(runDir: string, irDigest: string, lockJson: string, workflowIrJson: string): Promise<void> {
  const irBytes = await readContainedFile(runDir, "workflow.ir.json");
  if (digest(irBytes) !== irDigest) throw new Error("Fork workflow.ir.json failed copy verification.");
  if (stableJson(JSON.parse(irBytes.toString("utf8"))) !== stableJson(JSON.parse(workflowIrJson))) throw new Error("Fork workflow.ir.json does not match frozen runtime state.");
  const lockBytes = await readContainedFile(runDir, "lock.json");
  if (stableJson(JSON.parse(lockBytes.toString("utf8"))) !== stableJson(JSON.parse(lockJson))) throw new Error("Fork lock.json failed copy verification.");
}

async function readContainedFile(root: string, relativePath: string): Promise<Buffer> {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, relativePath);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}/`)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) throw new PathEscapeError(`Path '${relativePath}' is a symbolic link.`);
  if (!info.isFile()) throw new PathEscapeError(`Path '${relativePath}' is not a file.`);
  const real = await realpath(absolutePath);
  const realRoot = await realpath(rootPath);
  if (!real.startsWith(`${realRoot}/`)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  return readFile(absolutePath);
}

function readFileSyncContained(root: string, relativePath: string): Buffer {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, relativePath);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}/`)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  const info = lstatSync(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new PathEscapeError(`Path '${relativePath}' is not a regular file.`);
  const real = realpathSync(absolutePath);
  const realRoot = realpathSync(rootPath);
  if (!real.startsWith(`${realRoot}/`)) throw new PathEscapeError(`Path '${relativePath}' escapes run directory.`);
  return readFileSync(absolutePath);
}

class PathEscapeError extends Error {}

function containedRunDir(cwd: string, runDir: string): string {
  const runsRoot = resolve(cwd, ".acpus", "runs");
  const absolute = resolve(cwd, runDir);
  const name = absolute.slice(runsRoot.length + 1);
  if (!absolute.startsWith(`${runsRoot}/`) || !name.startsWith("run_") || name.includes("/")) {
    throw new Error(`Run directory '${runDir}' is outside .acpus/runs.`);
  }
  return absolute;
}

async function isStalePath(path: string, olderThanMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs >= olderThanMs;
  } catch {
    return false;
  }
}

function summarizeWorkflowForEvent(ir: WorkflowIR): {
  name: string;
  irVersion: number;
  nodeCount: number;
  outputKeys: string[];
  diagnostics: { total: number; errors: number; warnings: number; infos: number };
} {
  return {
    name: ir.name,
    irVersion: ir.irVersion,
    nodeCount: countNodes(ir.root),
    outputKeys: Object.keys(ir.outputs).sort(),
    diagnostics: {
      total: ir.diagnostics.length,
      errors: ir.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
      warnings: ir.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
      infos: ir.diagnostics.filter(diagnostic => diagnostic.severity === "info").length,
    },
  };
}

function countNodes(scope: ScopeIR): number {
  let total = scope.nodes.length;
  for (const node of scope.nodes) {
    if (node.kind === "if") {
      total += countNodes(node.then);
      if (node.else) total += countNodes(node.else);
    } else if (node.kind === "switch") {
      for (const c of node.cases) total += countNodes(c.then);
      if (node.default) total += countNodes(node.default);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) total += countNodes(branch.scope);
    } else if (node.kind === "fanout") {
      total += countNodes(node.do);
    } else if (node.kind === "loop") {
      total += countNodes(node.do);
    }
  }
  return total;
}

function throwSchedulerStoreError(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function newRunId(): string {
  const suffix = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12);
  return `run_${new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${suffix}`;
}
