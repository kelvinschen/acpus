import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentDefinitionIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import type { ExprIR, JsonValue } from "@acpus/expression/ir";
import { valueToExprIR } from "@acpus/expression/ir";
import { ArtifactRewriteError, rewriteArtifactValue } from "../artifacts/rewrite.js";
import { compactUndefined, parseAgentOverrideMap } from "../control/agent-overrides.js";
import { evaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import type { HookJournalEntry } from "../hooks/journal.js";
import { applySchedulerEvents, applyTimestampedSchedulerEvents, cancellationEventsForFrame, cancellationEventsForNode, createSchedulerProjection, type TimestampedSchedulerEvent } from "../scheduler/transitions.js";
import { ancestorGroupMembersForFrame, ancestorGroupMembersForNode } from "../scheduler/membership.js";
import { ForkSeedPlanError, planTargetedForkSeed, type ForkSeedPlan } from "../scheduler/fork-seed.js";
import type { SchedulerEvent } from "../scheduler/events.js";
import { SchedulerStoreException, schedulerStoreResult, type RunOwnerClaim, type SchedulerCancelInput, type SchedulerCommit, type SchedulerSnapshot, type SchedulerStorePort, type AttemptStartInput, type AttemptCommitInput, type SignalConsumeInput, type SchedulerPauseInput, type SchedulerResumeInput, type SchedulerRetryInput, type SchedulerRunRetryInput, type SchedulerStoreError, type SchedulerStoreResult } from "../scheduler/store-port.js";
import type { InstancePath } from "../scheduler/types.js";
import { drainDerivedTransitions } from "../scheduler/advance.js";
import { continueRootEvents } from "../scheduler/materialize.js";
import { decodeSchedulerPayload, isSchedulerEventType } from "../scheduler/event-codec.js";
import { decodeCommittedRuntimeEventRow, type CommittedRuntimeEventRow } from "../hooks/events.js";

export type RunStatus = "pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled";

const RUNNABLE_RUNS_WHERE = `
  status = 'pending'
  AND NOT EXISTS (
    SELECT 1
    FROM node_states
    WHERE node_states.run_id = runs.id
      AND node_states.status = 'pending'
      AND node_states.error_json IS NOT NULL
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
  admitRun(input: AdmitRunInput): Promise<RunRecord>;
  completeRun(input: CompleteRunInput): RunRecord;
  persistCompletedNodes(input: PersistCompletedNodesInput): RunRecord;
  blockRun(input: BlockRunInput): RunRecord;
  failRun(input: FailRunInput): RunRecord;
  awaitSignal(input: AwaitSignalInput): RunRecord;
  getSignalPayloads(runId: string): Record<string, unknown>;
  getCompletedNodeOutputs(runId: string): Record<string, unknown>;
  getFrozenRun(runId: string): FrozenRun | undefined;
  claimDaemon(input: ClaimDaemonInput): DaemonLease;
  heartbeatDaemon(input: HeartbeatDaemonInput): boolean;
  setDaemonIdleState(input: DaemonIdleStateInput): boolean;
  releaseDaemon(input: HeartbeatDaemonInput): boolean;
  listRunnableRuns(): RunRecord[];
  listDaemonWork(now?: Date): DaemonWork;
  forkRun(runId: string, options?: ControlOptions): Promise<ForkRunRecord>;
  cleanupRunDirectories(options?: CleanupRunDirectoriesOptions): Promise<CleanupRunDirectoriesResult>;
  writeHookJournal(entry: HookJournalEntry): void;
  getHookJournal(runId: string): HookJournalEntry[];
  pruneHookJournal(cutoff: Date): number;
  getLastRunEventSequence(runId: string): number;
  getCommittedRuntimeEventsAfter(runId: string, sequence: number): CommittedRuntimeEventRow[];
  getRunDir(runId: string): string | undefined;
  registerArtifact(input: RegisterArtifactInput): void;
  writeExecutionMetadata(input: WriteExecutionMetadataInput): void;
  getRun(runId: string): RunDetails | undefined;
  listRuns(): RunRecord[];
  getRuntimeDiagnostics(): RuntimeDiagnostics;
};

export type DaemonWork = {
  startableRuns: RunRecord[];
  idleBlockers: number;
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

export type ForkRunRecord = RunRecord & {
  forkCreated: boolean;
};

export type RunDetails = RunRecord & {
  input: JsonValue;
  output?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  hooks: HookJournalEntry[];
  eventCount: number;
  nodeCount: number;
  execution: RunExecutionState;
  dynamic?: RunDynamicDetails;
};

export type RunExecutionState = {
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
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicSignalWait = {
  nodeKey: string;
  nodeId: string;
  status: string;
  deadlineAt?: string;
  timeoutMessage?: string;
  timeoutRemainingMs?: number;
  renderedPrompt?: string;
  terminalReason?: string;
  createdAt: string;
  updatedAt: string;
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

export type FrozenRun = {
  ir: WorkflowIR;
  input: JsonValue;
  agentOverrides: AgentOverrideMap;
  meta: Record<string, string>;
};

export type ClaimDaemonInput = {
  workspaceRealpath: string;
  pid: number;
  protocolVersion: number;
  packageVersion: string;
  nodeVersion: string;
  execPath: string;
  idleStopMs: number;
};

export type HeartbeatDaemonInput = {
  workspaceRealpath: string;
  generation: number;
};

export type DaemonIdleStateInput = HeartbeatDaemonInput & {
  idleSinceAt?: string;
  idleStopMs: number;
};

export type DaemonLease = {
  workspaceRealpath: string;
  generation: number;
  pid: number;
  heartbeatAt: string;
};

export type ControlOptions = {
  requestId?: string;
  prepared?: ForkPreparedWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  target?: string;
  unsafeReuse?: boolean;
};

export type ForkPreparedWorkflow = {
  workflowPath: string;
  irJson: string;
  irDigest: string;
  sourceGraphDigest: string;
  packageLockDigest?: string;
  lock: RunWorkflowLockArtifact;
};

export type CleanupRunDirectoriesOptions = {
  olderThanMs?: number;
  removeOrphanedRuns?: boolean;
};

export type CleanupRunDirectoriesResult = {
  staged: number;
  orphaned: number;
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
  const path = join(cwd, localStateRoot, "state", "runtime.db");
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
  private schedulerPort?: SqliteSchedulerStorePort;

  constructor(private readonly db: DatabaseSync, private readonly cwd: string) {}

  get scheduler(): SchedulerStorePort {
    return this.schedulerStore();
  }

  private schedulerStore(): SqliteSchedulerStorePort {
    this.schedulerPort ??= new SqliteSchedulerStorePort(this.db, this.cwd);
    return this.schedulerPort;
  }

  close(): void {
    this.db.close();
  }

  async admitRun(input: AdmitRunInput): Promise<RunRecord> {
    const runId = newRunId();
    const now = new Date().toISOString();
    const workflowEntry = relative(input.cwd, input.prepared.workflowPath);
    const runDir = join(input.cwd, localStateRoot, "runs", runId);
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

  listRunnableRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
      FROM runs
      WHERE ${RUNNABLE_RUNS_WHERE}
      ORDER BY created_at ASC
    `).all().map(toRunRecord);
  }

  listDaemonWork(now: Date = new Date()): DaemonWork {
    const nowIso = now.toISOString();
    const startableRuns = this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
      FROM runs
      WHERE (${RUNNABLE_RUNS_WHERE}) OR (${DUE_SIGNAL_WAIT_WHERE})
      ORDER BY created_at ASC
    `).all(nowIso).map(toRunRecord);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs
      WHERE (${RUNNABLE_RUNS_WHERE}) OR (${TIMED_SIGNAL_WAIT_WHERE})
    `).get() as CountRow;
    return { startableRuns, idleBlockers: Number(row.count) };
  }

  private countRunnableRuns(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs
      WHERE ${RUNNABLE_RUNS_WHERE}
    `).get() as CountRow;
    return Number(row.count);
  }

  async forkRun(runId: string, options: ControlOptions = {}): Promise<ForkRunRecord> {
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
          throw new Error(`Fork request '${options.requestId}' conflicts with a different fork input.`);
        }
        return { ...this.requireRun(existing.run_id), forkCreated: false };
      }
    }
    const matchingFork = (this.db.prepare(`
      SELECT run_id, payload_json
      FROM run_events
      WHERE type = 'run.forked'
    `).all() as Array<{ run_id: string; payload_json: string }>)
      .find(row => (JSON.parse(row.payload_json) as Record<string, unknown>).requestFingerprint === requestFingerprint);
    if (matchingFork) return { ...this.requireRun(matchingFork.run_id), forkCreated: false };
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
    const sourceIr = JSON.parse(input.workflow_ir_json) as WorkflowIR;
    const sourceEffectiveIr = withAgentOverrides(sourceIr, sourceAgentOverrides);
    const forkEffectiveIr = withAgentOverrides(forkIr, forkAgentOverrides);
    const forkInputJson = options.input === undefined ? input.input_json : stableJson(options.input);
    const forkLockJson = options.prepared ? stableJson(options.prepared.lock) : input.lock_json;
    const forkPackageLockDigest = options.prepared?.packageLockDigest ?? input.package_lock_digest ?? null;
    const forkName = options.prepared ? forkIr.name : source.name;
    const forkWorkflowEntry = options.prepared ? relative(this.cwd, options.prepared.workflowPath) : source.workflowEntry;
    const forkIrDigest = options.prepared?.irDigest ?? source.irDigest;
    const forkSourceGraphDigest = options.prepared?.sourceGraphDigest ?? source.sourceGraphDigest;
    const forkId = newRunId();
    const now = new Date().toISOString();
    const replacement = Boolean(options.prepared || options.input !== undefined || options.target !== undefined || options.agentOverrides !== undefined || options.unsafeReuse === true);
    const targetedReplacement = replacement;
    const forkStatus = source.status === "completed" && !replacement ? "completed" : "pending";
    const sourceRunDir = input.run_dir ? containedRunDir(this.cwd, input.run_dir) : undefined;
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
    const seedPlan = targetedReplacement
      ? planTargetedForkSeed({
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
          sourceProjection: this.scheduler.loadRunSnapshot(runId).projection,
          inputChanged: options.input !== undefined,
          unsafeReuse: options.unsafeReuse === true,
          ...(options.target === undefined ? {} : { target: options.target }),
        }).match(
          value => value,
          failure => {
            throw new ForkSeedPlanError(failure);
          },
        )
      : undefined;
    const inheritableNodeKeys = seedPlan?.inheritedNodeKeys ?? (options.input !== undefined ? new Set<string>() : source.status === "completed"
      ? knownCompletedNodeKeys
      : inheritableCompletedNodeKeys(forkIr, knownCompletedNodeKeys));
    const nodeRows = this.db.prepare("SELECT node_key, node_id, status, output_json, error_json, attempt FROM node_states WHERE run_id = ?").all(runId) as Array<Record<string, unknown>>;
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
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
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
      `).run(forkId, stableJson({ sourceRunId: runId, requestFingerprint, ...(options.target === undefined ? {} : { target: options.target }), ...(options.unsafeReuse === true ? { unsafeReuse: true } : {}), ...(Object.keys(forkAgentOverrides).length > 0 ? { agentOverrides: forkAgentOverrides } : {}) }), now, forkRequestKey ?? `fork:${forkId}:${runId}`);
      if (forkStatus === "completed" && forkOutputJson) {
        this.db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, 2, 'run.completed', NULL, ?, ?, ?)
        `).run(forkId, stableJson({ output: JSON.parse(forkOutputJson) as JsonValue }), now, `complete:${forkId}`);
      }
      if (targetedReplacement && seedPlan) {
        this.schedulerStore().insertForkSeedEventsInTransaction({
          runId: forkId,
          sourceRunId: runId,
          artifactIdMap,
          plan: seedPlan,
          now,
        });
      } else {
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
      if (transactionStarted) this.db.exec("ROLLBACK");
      await rm(stagedForkRunPath, { recursive: true, force: true });
      await rm(forkRunPath, { recursive: true, force: true });
      if (error instanceof ArtifactRewriteError) {
        throw new ForkSeedPlanError({
          type: "artifact-rewrite-failure",
          artifactId: error.artifactId,
          message: error.message,
        });
      }
      throw error;
    }
    return { ...this.requireRun(forkId), forkCreated: true };
  }

  async cleanupRunDirectories(options: CleanupRunDirectoriesOptions = {}): Promise<CleanupRunDirectoriesResult> {
    const runsDir = join(this.cwd, localStateRoot, "runs");
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
      const relativePath = join(localStateRoot, "runs", entry);
      if (removeOrphanedRuns && runIdPattern.test(entry) && !validRunDirs.has(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        orphaned += 1;
      }
    }
    return { staged, orphaned };
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

  getLastRunEventSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?").get(runId) as { sequence: number } | undefined;
    return Number(row?.sequence ?? 0);
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
      hooks: isTerminalRunStatus(run.status) ? this.getHookJournal(runId) : [],
      eventCount,
      nodeCount,
      execution: this.getRunExecutionState(run),
      ...(dynamic ? { dynamic } : {}),
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
    if (daemon?.pid !== null && daemon?.pid !== undefined && !isProcessAlive(daemon.pid)) {
      return { state: "stale", lastStatus: run.status, reason: "daemon_pid_dead", ...(daemon.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ...(lease ? { ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at } : {}) };
    }
    if (lease && Date.parse(lease.lease_expires_at) <= now) {
      return { state: "stale", lastStatus: run.status, reason: "run_lease_expired", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at };
    }
    if (lease) return { state: "active", lastStatus: run.status, reason: "run_lease_active", ...(daemon?.heartbeat_at ? { daemonHeartbeatAt: daemon.heartbeat_at } : {}), ownerId: lease.owner_id, leaseExpiresAt: lease.lease_expires_at };
    if (daemon?.heartbeat_at) return { state: "inactive", lastStatus: run.status, reason: "daemon_alive", daemonHeartbeatAt: daemon.heartbeat_at };
    return { state: "inactive", lastStatus: run.status, reason: "no_liveness_evidence" };
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

  listRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
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
    const duplicate = this.duplicateAppendIdempotency(commit);
    if (duplicate) return duplicate;
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

  insertForkSeedEventsInTransaction(input: {
    runId: string;
    sourceRunId: string;
    artifactIdMap: Record<string, string>;
    plan: ForkSeedPlan;
    now: string;
  }): void {
    if (input.plan.events.length === 0) return;
    const events = input.plan.events.map(event => ({
      ...event,
      payload: rewriteArtifactValue(event.payload as JsonValue, input.sourceRunId, input.runId, input.artifactIdMap),
    }) as SchedulerEvent);
    applySchedulerEvents(createSchedulerProjection(input.runId), events);
    const currentVersion = this.currentVersion(input.runId);
    const commitKey = `fork-seed:${input.runId}`;
    this.db.prepare(`
      INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.runId, commitKey, events.length, schedulerCommitDigest(events), input.now);
    let sequence = currentVersion + 1;
    for (const [index, event] of events.entries()) {
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.runId, sequence, event.type, eventNodeKey(event), encodeSchedulerPayload(event.payload), input.now, schedulerEventIdempotencyKey(input.runId, commitKey, index));
      sequence += 1;
    }
    this.syncSchedulerProjectionTables(input.runId, input.now);
    this.syncPublicRunProjection(input.runId, input.now);
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
    const now = input.now ?? new Date();
    let snapshot = this.loadRunSnapshot(input.runId);
    let wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status === "consumed" && stableJson(wait.payload) === stableJson(input.payload)) {
      return snapshot;
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
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.drainDueSignalTimeouts(input.runId, input.ownerEpoch, now);
    if (snapshot.projection.run.status === "paused") return snapshot;
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: input.reason === undefined ? {} : { reason: input.reason } },
    ];
    for (const wait of Object.values(snapshot.projection.signalWaits).filter(wait => wait.status === "awaiting" && wait.deadlineAt !== undefined)) {
      const deadlineAt = wait.deadlineAt;
      if (deadlineAt === undefined) continue;
      events.push({
        type: "signal.timeout_paused",
        payload: {
          nodeKey: wait.nodeKey,
          remainingMs: Math.max(0, new Date(deadlineAt).getTime() - now.getTime()),
        },
      });
    }
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
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "paused") {
      return snapshot;
    }
    const events: SchedulerEvent[] = [{ type: "control.resumed", payload: {} }];
    for (const wait of Object.values(snapshot.projection.signalWaits).filter(wait => wait.status === "awaiting" && wait.timeoutRemainingMs !== undefined)) {
      const timeoutRemainingMs = wait.timeoutRemainingMs;
      if (timeoutRemainingMs === undefined) continue;
      events.push({
        type: "signal.timeout_resumed",
        payload: {
          nodeKey: wait.nodeKey,
          deadlineAt: new Date(now.getTime() + timeoutRemainingMs).toISOString(),
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

  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retryRun(input));
  }

  retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot {
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey);
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
      events: [{ type: "control.run_retry_requested", payload: {} }],
    });
  }

  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retry(input));
  }

  retry(input: SchedulerRetryInput): SchedulerSnapshot {
    const idempotencyKey = input.idempotencyKey;
    const duplicate = this.duplicateIntentIdempotency(input.runId, idempotencyKey);
    if (duplicate) return duplicate;
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
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey);
    if (duplicate) return duplicate;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (input.targetKey === undefined && snapshot.projection.run.status === "canceled") return snapshot;
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

  private timestampedSchedulerEvents(runId: string): TimestampedSchedulerEvent[] {
    return timestampedSchedulerEvents(this.db, runId);
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

  private drainDueSignalTimeouts(runId: string, ownerEpoch: number, now: Date): SchedulerSnapshot {
    const frozen = this.loadFrozenRun(runId);
    return drainDerivedTransitions(
      this,
      runId,
      { runId, ownerEpoch },
      () => now,
      snapshot => continueRootEvents(frozen.ir, snapshot.projection, rootScope(frozen)),
      () => undefined,
    );
  }

  private loadFrozenRun(runId: string): FrozenRun {
    const row = this.db.prepare(`
      SELECT runs.id, runs.name, runs.workflow_entry, run_inputs.workflow_ir_json, run_inputs.input_json, run_inputs.agent_overrides_json
      FROM run_inputs
      JOIN runs ON runs.id = run_inputs.run_id
      WHERE run_inputs.run_id = ?
    `).get(runId) as (RunInputRow & { id: string; name: string; workflow_entry: string }) | undefined;
    if (!row?.workflow_ir_json) throw new Error(`Run '${runId}' has no frozen workflow.`);
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

  private duplicateAppendIdempotency(commit: SchedulerCommit): SchedulerSnapshot | undefined {
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

  private duplicateIntentIdempotency(runId: string, idempotencyKey: string): SchedulerSnapshot | undefined {
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
    const { projection, timings } = applyTimestampedSchedulerEvents(runId, this.timestampedSchedulerEvents(runId));
    const existingSignalWaits = new Map((this.db.prepare("SELECT node_key, consumed_at, timed_out_at, created_at FROM signal_waits WHERE run_id = ?").all(runId) as Array<{ node_key: string; consumed_at: string | null; timed_out_at: string | null; created_at: string | null }>)
      .map(row => [row.node_key, row]));
    this.db.prepare("DELETE FROM scheduler_frames WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM node_instances WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM node_attempts WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM group_members WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM signal_waits WHERE run_id = ?").run(runId);

    for (const frame of Object.values(projection.frames)) {
      const timing = timings.frame.get(frame.frameKey);
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
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const instance of Object.values(projection.instances)) {
      const timing = timings.instance.get(instance.nodeKey);
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
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const attempt of Object.values(projection.attempts)) {
      const timing = timings.attempt.get(attempt.attemptId);
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
        timing?.createdAt ?? now,
        attempt.status === "started" ? null : timing?.updatedAt ?? now,
        attempt.result === undefined ? null : stableJson(attempt.result),
        attempt.error === undefined ? null : stableJson(attempt.error),
        attempt.terminalReason ?? null,
        attempt.cancelReason ?? null,
      );
    }

    for (const member of Object.values(projection.groupMembers)) {
      const timing = timings.member.get(member.memberKey);
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
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const wait of Object.values(projection.signalWaits)) {
      const existing = existingSignalWaits.get(wait.nodeKey);
      const timing = timings.signal.get(wait.nodeKey);
      this.db.prepare(`
        INSERT INTO signal_waits (
          run_id, node_key, node_id, status, payload_json, payload_digest, command_idempotency_key,
          deadline_at, timeout_message, timeout_remaining_ms, rendered_prompt, consumed_at, timed_out_at, terminal_reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        wait.runId,
        wait.nodeKey,
        wait.nodeId,
        wait.status,
        wait.payload === undefined ? null : stableJson(wait.payload),
        wait.payloadDigest ?? null,
        wait.commandIdempotencyKey ?? null,
        wait.deadlineAt ?? null,
        wait.timeoutMessage ?? null,
        wait.timeoutRemainingMs ?? null,
        wait.renderedPrompt ?? null,
        wait.status === "consumed" ? timing?.updatedAt ?? existing?.consumed_at ?? now : null,
        wait.status === "timed_out" ? timing?.updatedAt ?? existing?.timed_out_at ?? now : null,
        wait.terminalReason ?? null,
        timing?.createdAt ?? existing?.created_at ?? now,
        timing?.updatedAt ?? now,
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
    if (!isSchedulerEventType(row.type)) return [];
    return [{ type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) } as SchedulerEvent];
  });
}

function timestampedSchedulerEvents(db: DatabaseSync, runId: string): TimestampedSchedulerEvent[] {
  const rows = db.prepare("SELECT type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<{ type: string; payload_json: string; created_at: string }>;
  return rows.flatMap(row => {
    if (!isSchedulerEventType(row.type)) return [];
    return [{ event: { type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) } as SchedulerEvent, createdAt: row.created_at }];
  });
}

function rootTerminalEventCount(events: readonly SchedulerEvent[], type: "frame.completed" | "frame.failed" | "frame.cancelled"): number {
  return events.filter(event => event.type === type && event.payload.frameKey === "root").length;
}

function readRunDynamicFrames(db: DatabaseSync, runId: string): RunDynamicFrame[] {
  const rows = db.prepare(`
    SELECT frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
      terminal_reason, instance_path_json, result_json, error_json, created_at, updated_at
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }) as RunDynamicNodeInstance);
}

function readRunDynamicAttempts(db: DatabaseSync, runId: string): RunDynamicAttempt[] {
  const rows = db.prepare(`
    SELECT attempt_id, node_key, node_id, attempt_no, status, deadline_at,
      started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
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
    startedAt: String(row.started_at),
    finishedAt: nullableString(row.finished_at),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
    terminalReason: nullableString(row.terminal_reason),
    cancelReason: nullableString(row.cancel_reason),
  }) as RunDynamicAttempt);
}

function readRunDynamicGroupMembers(db: DatabaseSync, runId: string): RunDynamicGroupMember[] {
  const rows = db.prepare(`
    SELECT group_key, member_key, member_kind, branch_id, item_key, item_index, item_json, child_frame_key,
      status, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }) as RunDynamicGroupMember);
}

function readRunDynamicSignalWaits(db: DatabaseSync, runId: string): RunDynamicSignalWait[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, status, deadline_at,
      timeout_message, timeout_remaining_ms, rendered_prompt, terminal_reason, created_at, updated_at
    FROM signal_waits
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    status: String(row.status),
    deadlineAt: nullableString(row.deadline_at),
    timeoutMessage: nullableString(row.timeout_message),
    timeoutRemainingMs: nullableNumber(row.timeout_remaining_ms),
    renderedPrompt: nullableString(row.rendered_prompt),
    terminalReason: nullableString(row.terminal_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
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

function openDatabase(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, readOnly });
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS commands;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

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
      timeout_message TEXT,
      timeout_remaining_ms INTEGER,
      rendered_prompt TEXT,
      consumed_at TEXT,
      timed_out_at TEXT,
      terminal_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
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

    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (1, datetime('now'));
  `);
  addColumnIfMissing(db, "scheduler_frames", "instance_path_json", "TEXT");
  addColumnIfMissing(db, "scheduler_frames", "loop_json", "TEXT");
  addColumnIfMissing(db, "node_instances", "instance_path_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "group_members", "item_json", "TEXT");
  addColumnIfMissing(db, "group_members", "child_frame_key", "TEXT");
  addColumnIfMissing(db, "group_members", "completion_sequence", "INTEGER");
  addColumnIfMissing(db, "run_inputs", "agent_overrides_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "daemon_lease", "idle_since_at", "TEXT");
  addColumnIfMissing(db, "daemon_lease", "idle_stop_ms", "INTEGER");
  addColumnIfMissing(db, "signal_waits", "rendered_prompt", "TEXT");
  addColumnIfMissing(db, "signal_waits", "timeout_message", "TEXT");
  addColumnIfMissing(db, "signal_waits", "timeout_remaining_ms", "INTEGER");
  addColumnIfMissing(db, "signal_waits", "created_at", "TEXT");
  addColumnIfMissing(db, "signal_waits", "updated_at", "TEXT");
  addColumnIfMissing(db, "hook_journal", "trigger_order", "INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE signal_waits SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now')) WHERE created_at IS NULL OR updated_at IS NULL;");
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

function parseAgentOverrides(json: string | null | undefined): AgentOverrideMap {
  if (!json) return {};
  return parseAgentOverrideMap(JSON.parse(json) as unknown);
}

export function validateAgentOverrides(ir: WorkflowIR, input: AgentOverrideMap | undefined): AgentOverrideMap {
  return normalizeAgentOverrides(ir, input);
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
    cwd: override.cwd === undefined ? definition.cwd : valueToExprIR(override.cwd),
    env: override.env === undefined ? definition.env : Object.fromEntries(Object.entries(override.env).map(([key, value]) => [key, valueToExprIR(value)])),
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM";
  }
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

function evaluateRecordedOutputs(outputs: Record<string, ExprIR>, nodes: Record<string, unknown>, input: JsonValue, meta: Record<string, string>): JsonValue {
  return assertJsonValue(Object.fromEntries(Object.entries(outputs).map(([key, expr]) => [
    key,
    evaluateExpr(expr, {
      input,
      meta,
      nodes: Object.fromEntries(Object.entries(nodes).map(([nodeKey, output]) => [nodeKey, { status: "completed", output }])),
    }),
  ])), "fork output");
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

function forkRequestFingerprint(runId: string, options: ControlOptions): string {
  return stableJson({
    runId,
    ...(options.prepared === undefined ? {} : {
      prepared: {
        workflowPath: options.prepared.workflowPath,
        irDigest: options.prepared.irDigest,
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
  const runsRoot = resolve(cwd, localStateRoot, "runs");
  const absolute = resolve(cwd, runDir);
  const name = absolute.slice(runsRoot.length + 1);
  if (!absolute.startsWith(`${runsRoot}/`) || !runIdPattern.test(name) || name.includes("/")) {
    throw new Error(`Run directory '${runDir}' is outside ${localStateRoot}/runs.`);
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

function rootScope(frozen: FrozenRun): EvaluationScope {
  return {
    input: frozen.input,
    nodes: {},
    meta: frozen.meta,
    fanout: {},
    loop: {},
  };
}

function throwSchedulerStoreError(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
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
