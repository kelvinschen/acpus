import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExprIR, JsonValue, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import { evaluateExpr } from "../evaluation/evaluator.js";

export type RunStatus = "pending" | "running" | "paused" | "awaiting" | "failed" | "completed" | "canceled";

export type RuntimeStore = {
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
  submitCommand(input: SubmitCommandInput): PendingControlCommand;
  getCommand(commandId: string): PendingControlCommand | undefined;
  claimCommand(commandId: string, options?: ClaimCommandOptions): boolean;
  recoverStaleCommands(options?: RecoverStaleCommandsOptions): number;
  listPendingCommands(): PendingControlCommand[];
  listRunnableRuns(): RunRecord[];
  finishCommand(input: FinishCommandInput): void;
  pauseRun(runId: string, options?: ControlOptions): RunRecord;
  resumeRun(runId: string, options?: ControlOptions): RunRecord;
  retryRun(runId: string, options?: ControlOptions): RunRecord;
  retryNode(runId: string, nodeKey: string, options?: ControlOptions): RunRecord;
  forkRun(runId: string, options?: ControlOptions): Promise<RunRecord>;
  cleanupRunDirectories(options?: CleanupRunDirectoriesOptions): Promise<CleanupRunDirectoriesResult>;
  getRunDir(runId: string): string | undefined;
  registerArtifact(input: RegisterArtifactInput): void;
  getRun(runId: string): RunDetails | undefined;
  listRuns(): RunRecord[];
};

export type AdmitRunInput = {
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  cwd: string;
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
  taskBundles: Record<string, { digest: string; path: string }>;
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
  eventCount: number;
  nodeCount: number;
  taskBundleCount: number;
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

export type ControlCommand = {
  id: string;
  runId?: string;
  type: string;
  status: "pending" | "running" | "applied" | "failed";
  idempotencyKey: string;
};

export type PendingControlCommand = ControlCommand & {
  payload: JsonValue;
};

export type SubmitCommandInput = {
  runId?: string;
  type: string;
  payload?: JsonValue;
  idempotencyKey: string;
};

export type FinishCommandInput = {
  id: string;
  status: "applied" | "failed";
  payload?: JsonValue;
};

export type ControlOptions = {
  commandId?: string;
  prepared?: ForkPreparedWorkflow;
  input?: JsonValue;
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
  lock_json?: string;
  output_json: string | null;
  task_bundle_count: number;
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
  return new SqliteRuntimeStore(openDatabase(path, readOnly), cwd);
}

class SqliteRuntimeStore implements RuntimeStore {
  constructor(private readonly db: DatabaseSync, private readonly cwd: string) {}

  close(): void {
    this.db.close();
  }

  async admitRun(input: AdmitRunInput): Promise<RunRecord> {
    const runId = newRunId();
    const now = new Date().toISOString();
    const workflowEntry = relative(input.cwd, input.prepared.workflowPath);
    const runDir = join(input.cwd, ".acpus", "runs", runId);
    const bundleDir = join(runDir, "task-bundles");
    try {
      await mkdir(bundleDir, { recursive: true });
      await writeFile(join(runDir, "workflow.ir.json"), input.prepared.irJson);
      await writeFile(join(runDir, "lock.json"), `${JSON.stringify(input.prepared.lock, null, 2)}\n`);
      for (const bundle of Object.values(input.prepared.ir.assets.taskBundles)) {
        await writeFile(join(bundleDir, `${bundle.id}.mjs`), bundle.source ?? "");
      }

      const eventPayload = {
        workflow: summarizeWorkflowForEvent(input.prepared.ir),
        input: input.input,
        lock: input.prepared.lock,
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO runs (id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
        `).run(runId, input.prepared.ir.name, workflowEntry, input.prepared.irDigest, input.prepared.sourceGraphDigest, now, now);
        this.db.prepare(`
          INSERT INTO run_inputs (
            run_id, workflow_ir_json, input_json, lock_json, task_bundle_count, package_lock_digest, run_dir, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          input.prepared.irJson,
          stableJson(input.input),
          stableJson(input.prepared.lock),
          Object.keys(input.prepared.ir.assets.taskBundles).length,
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
      SELECT node_key, output_json
      FROM node_states
      WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
    `).all(runId);
    return Object.fromEntries(rows.map(row => [String(row.node_key), JSON.parse(String(row.output_json)) as unknown]));
  }

  getCompletedNodeOutputs(runId: string): Record<string, unknown> {
    const rows = this.db.prepare(`
      SELECT node_key, output_json
      FROM node_states
      WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
    `).all(runId);
    return Object.fromEntries(rows.map(row => [String(row.node_key), JSON.parse(String(row.output_json)) as unknown]));
  }

  getFrozenRun(runId: string): FrozenRun | undefined {
    const row = this.db.prepare(`
      SELECT workflow_ir_json, input_json
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!row?.workflow_ir_json) return undefined;
    return {
      ir: JSON.parse(row.workflow_ir_json) as WorkflowIR,
      input: JSON.parse(row.input_json) as JsonValue,
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
    const actual = evaluateRecordedOutputs(frozen.ir.outputs, this.getCompletedNodeOutputs(runId), frozen.input);
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
    return {
      id: String(row.id),
      ...(row.run_id === null ? {} : { runId: String(row.run_id) }),
      type: String(row.type),
      status: String(row.status) as ControlCommand["status"],
      idempotencyKey: String(row.idempotency_key),
      payload: JSON.parse(String(row.payload_json)) as JsonValue,
    };
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

  retryNode(runId: string, nodeKey: string, options: ControlOptions = {}): RunRecord {
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
      const node = this.db.prepare(`
        UPDATE node_states
        SET status = 'pending', output_json = NULL, error_json = NULL, updated_at = ?
        WHERE run_id = ? AND node_key = ? AND status = 'failed'
      `).run(now, runId, nodeKey);
      if (node.changes !== 1) throw new Error(`Node '${nodeKey}' is not failed for run '${runId}'.`);
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, ?, 'node.retried', ?, ?, ?, ?)
      `).run(runId, nextSequence, nodeKey, stableJson({ nodeKey }), now, `retry:${runId}:${nodeKey}:${nextSequence}`);
      if (options.commandId) this.finishCommandInTransaction(options.commandId, "applied", { status: "pending", nodeKey }, now);
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
      SELECT workflow_ir_json, input_json, lock_json, output_json, task_bundle_count, package_lock_digest, run_dir
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input?.workflow_ir_json || !input.lock_json) throw new Error(`Run '${runId}' has no frozen input.`);
    const forkIrJson = options.prepared?.irJson ?? input.workflow_ir_json;
    if (options.prepared && digest(Buffer.from(forkIrJson)) !== options.prepared.irDigest) throw new Error("Fork prepared workflow IR digest does not match payload.");
    const forkIr = JSON.parse(forkIrJson) as WorkflowIR;
    const forkInputJson = options.input === undefined ? input.input_json : stableJson(options.input);
    const forkLockJson = options.prepared ? stableJson(options.prepared.lock) : input.lock_json;
    const forkTaskBundleCount = options.prepared ? Object.keys(forkIr.assets.taskBundles).length : input.task_bundle_count;
    const forkPackageLockDigest = options.prepared?.packageLockDigest ?? input.package_lock_digest ?? null;
    const forkName = options.prepared ? forkIr.name : source.name;
    const forkWorkflowEntry = options.prepared ? relative(this.cwd, options.prepared.workflowPath) : source.workflowEntry;
    const forkIrDigest = options.prepared?.irDigest ?? source.irDigest;
    const forkSourceGraphDigest = options.prepared?.sourceGraphDigest ?? source.sourceGraphDigest;
    const forkId = newRunId();
    const now = new Date().toISOString();
    const replacement = Boolean(options.prepared || options.input !== undefined);
    const forkStatus = source.status === "completed" && !replacement ? "completed" : "pending";
    const sourceRunDir = input.run_dir ? containedRunDir(this.cwd, input.run_dir) : undefined;
    const forkRunDir = join(".acpus", "runs", forkId);
    const forkRunPath = join(this.cwd, forkRunDir);
    const stagedForkRunPath = join(this.cwd, ".acpus", "runs", `.staging-${forkId}`);
    const completedNodeKeys = new Set(this.db.prepare(`
      SELECT node_key
      FROM node_states
      WHERE run_id = ? AND status = 'completed'
    `).all(runId).map(row => String(row.node_key)));
    const sourceIr = JSON.parse(input.workflow_ir_json) as WorkflowIR;
    const sourceNodeSignatures = nodeSignatures(sourceIr.root);
    const forkNodeSignatures = nodeSignatures(forkIr.root);
    const irNodeKeys = new Set(forkNodeSignatures.keys());
    const knownCompletedNodeKeys = new Set([...completedNodeKeys].filter(nodeKey => forkNodeSignatures.get(nodeKey) === sourceNodeSignatures.get(nodeKey)));
    const inheritableNodeKeys = options.input !== undefined ? new Set<string>() : source.status === "completed"
      ? knownCompletedNodeKeys
      : inheritableCompletedNodeKeys(forkIr, knownCompletedNodeKeys);
    const artifacts = this.db.prepare(`
      SELECT id, node_key, attempt, media_type, digest, size, relative_path
      FROM artifacts
      WHERE run_id = ?
    `).all(runId).filter(artifact => inheritableNodeKeys.has(String(artifact.node_key))) as ArtifactRow[];
    const artifactIdMap = Object.fromEntries(artifacts.map(artifact => [
      String(artifact.id),
      `artifact_${randomUUID()}`,
    ]));
    if (sourceRunDir) {
      try {
        await mkdir(dirname(stagedForkRunPath), { recursive: true });
        await cp(sourceRunDir, stagedForkRunPath, { recursive: true });
        await pruneNonInheritedArtifacts(stagedForkRunPath, inheritableNodeKeys);
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
          run_id, workflow_ir_json, input_json, output_json, lock_json, task_bundle_count, package_lock_digest, run_dir, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        forkId,
        forkIrJson,
        forkInputJson,
        source.status === "completed" && !replacement && input.output_json ? rewriteArtifactRefs(input.output_json, runId, forkId, artifactIdMap) : null,
        forkLockJson,
        forkTaskBundleCount,
        forkPackageLockDigest,
        forkRunDir,
        now,
      );
      this.db.prepare(`
        INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
        VALUES (?, 1, 'run.forked', NULL, ?, ?, ?)
      `).run(forkId, stableJson({ sourceRunId: runId }), now, `fork:${forkId}:${runId}`);
      const rows = this.db.prepare("SELECT node_key, node_id, status, output_json, error_json, attempt FROM node_states WHERE run_id = ?").all(runId);
      const insertedNodeKeys = new Set<string>();
      for (const row of rows) {
        if (!irNodeKeys.has(String(row.node_key))) continue;
        insertedNodeKeys.add(String(row.node_key));
        this.db.prepare(`
          INSERT INTO node_states (run_id, node_key, node_id, status, output_json, error_json, attempt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          forkId,
          String(row.node_key),
          String(row.node_id),
          inheritableNodeKeys.has(String(row.node_key)) ? "completed" : "pending",
          inheritableNodeKeys.has(String(row.node_key)) && row.output_json ? rewriteArtifactRefs(String(row.output_json), runId, forkId, artifactIdMap) : null,
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

  getRun(runId: string): RunDetails | undefined {
    const run = this.getRunRecord(runId);
    if (!run) return undefined;
    const input = this.db.prepare(`
      SELECT input_json, output_json, task_bundle_count
      FROM run_inputs
      WHERE run_id = ?
    `).get(runId) as RunInputRow | undefined;
    if (!input) return undefined;
    const eventCount = this.count("run_events", runId);
    const nodeCount = this.count("node_states", runId);
    return {
      ...run,
      input: JSON.parse(input.input_json) as JsonValue,
      ...(input.output_json ? { output: JSON.parse(input.output_json) as JsonValue } : {}),
      eventCount,
      nodeCount,
      taskBundleCount: input.task_bundle_count,
    };
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
    const rebuilt = rebuildTerminalProjection(terminalEvents);
    if (rebuilt.status && rebuilt.status !== run.status) {
      issues.push(`Run '${runId}' status does not match terminal event stream.`);
    }
    if (rebuilt.output !== undefined) {
      const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
      const persistedOutput = row?.output_json ? safeParseJson(row.output_json) : undefined;
      if (!persistedOutput?.ok || JSON.stringify(sortJson(persistedOutput.value)) !== JSON.stringify(sortJson(rebuilt.output))) {
        issues.push(`Run '${runId}' output projection does not match terminal event stream.`);
      }
    }
    if (completed.length > 0 && failed.length > 0) issues.push(`Run '${runId}' has conflicting terminal events.`);
    if (run.status === "completed") {
      if (completed.length !== 1) issues.push(`Completed run '${runId}' must have exactly one run.completed event.`);
      if (failed.length > 0) issues.push(`Completed run '${runId}' must not have run.failed events.`);
      const row = this.db.prepare("SELECT output_json FROM run_inputs WHERE run_id = ?").get(runId) as { output_json: string | null } | undefined;
      if (!row?.output_json) issues.push(`Completed run '${runId}' has no persisted output.`);
      const completedEvent = completed[0];
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
      if (failed.length !== 1) issues.push(`Failed run '${runId}' must have exactly one run.failed event.`);
      if (completed.length > 0) issues.push(`Failed run '${runId}' must not have run.completed events.`);
      const failedEvent = failed[0];
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
    if ((run.status === "pending" || run.status === "awaiting" || run.status === "paused") && terminalEvents.length > 0) {
      issues.push(`Non-terminal run '${runId}' has terminal events.`);
    }
    return { issues };
  }

  listRuns(): RunRecord[] {
    return this.db.prepare(`
      SELECT id, name, status, workflow_entry, ir_digest, source_graph_digest, created_at, updated_at
      FROM runs
      ORDER BY created_at DESC
    `).all().map(toRunRecord);
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
      output_json TEXT,
      lock_json TEXT NOT NULL,
      task_bundle_count INTEGER NOT NULL,
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
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
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
  return {
    id: String(row.id),
    ...(row.run_id === null ? {} : { runId: String(row.run_id) }),
    type: String(row.type),
    status: String(row.status) as ControlCommand["status"],
    idempotencyKey: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload_json)) as JsonValue,
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

function evaluateRecordedOutputs(outputs: Record<string, ExprIR>, nodes: Record<string, unknown>, input: JsonValue): JsonValue {
  return assertJsonValue(Object.fromEntries(Object.entries(outputs).map(([key, expr]) => [
    key,
    evaluateExpr(expr, {
      input,
      nodes: Object.fromEntries(Object.entries(nodes).map(([nodeKey, output]) => [nodeKey, { status: "completed", output }])),
    }),
  ])), "replay output");
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

async function pruneNonInheritedArtifacts(runDir: string, completedNodeKeys: Set<string>): Promise<void> {
  const artifactDir = join(runDir, "artifacts");
  let nodeDirs: string[];
  try {
    nodeDirs = await readdir(artifactDir);
  } catch {
    return;
  }
  await Promise.all(nodeDirs.map(async nodeKey => {
    if (!completedNodeKeys.has(nodeKey)) await rm(join(artifactDir, nodeKey), { recursive: true, force: true });
  }));
}

async function writePreparedRunFiles(runDir: string, prepared: ForkPreparedWorkflow): Promise<void> {
  await writeFile(join(runDir, "workflow.ir.json"), prepared.irJson);
  await writeFile(join(runDir, "lock.json"), `${JSON.stringify(prepared.lock, null, 2)}\n`);
  const bundleDir = join(runDir, "task-bundles");
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  for (const bundle of Object.values((JSON.parse(prepared.irJson) as WorkflowIR).assets.taskBundles)) {
    await writeFile(join(bundleDir, `${bundle.id}.mjs`), bundle.source ?? "");
  }
}

async function verifyFrozenRunFiles(runDir: string, irDigest: string, lockJson: string, workflowIrJson: string): Promise<void> {
  const irBytes = await readContainedFile(runDir, "workflow.ir.json");
  if (digest(irBytes) !== irDigest) throw new Error("Fork workflow.ir.json failed copy verification.");
  if (stableJson(JSON.parse(irBytes.toString("utf8"))) !== stableJson(JSON.parse(workflowIrJson))) throw new Error("Fork workflow.ir.json does not match frozen runtime state.");
  const lockBytes = await readContainedFile(runDir, "lock.json");
  if (stableJson(JSON.parse(lockBytes.toString("utf8"))) !== stableJson(JSON.parse(lockJson))) throw new Error("Fork lock.json failed copy verification.");
  const ir = JSON.parse(irBytes.toString("utf8")) as WorkflowIR;
  for (const bundle of Object.values(ir.assets.taskBundles)) {
    const bytes = await readContainedFile(runDir, join("task-bundles", `${bundle.id}.mjs`));
    if (digest(bytes) !== bundle.digest) throw new Error(`Fork task bundle '${bundle.id}' failed copy verification.`);
  }
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

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function newRunId(): string {
  const suffix = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12);
  return `run_${new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${suffix}`;
}
