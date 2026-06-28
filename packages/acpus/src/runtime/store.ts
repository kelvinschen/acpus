import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { JsonValue, WorkflowIR } from "@acpus/core";

const require = createRequire(import.meta.url);

export type RunStatus = "queued" | "running" | "awaiting_signal" | "paused" | "succeeded" | "failed" | "cancelled";
export type NodeStatus = "pending" | "running" | "awaiting_signal" | "succeeded" | "failed" | "skipped";
export type CommandStatus = "pending" | "applied" | "rejected";

export type StoredRun = {
  runId: string;
  workflowName: string;
  status: RunStatus;
  admittedAt: string;
  startedAt?: string;
  endedAt?: string;
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  irDigest: string;
  sourceGraphDigest?: string;
  workspaceDir: string;
  runDir: string;
};

export type RunAdmission = {
  runId: string;
  ir: WorkflowIR;
  input: JsonValue;
  lockMetadata: JsonValue;
  taskBundleMetadata: JsonValue;
};

export type StoredNodeState = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  kind: string;
  status: NodeStatus;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
  output?: JsonValue;
  error?: JsonValue;
  metadata?: JsonValue;
};

export type ArtifactRow = {
  id: number;
  artifactId: string;
  runId: string;
  nodeKey: string;
  nodeId: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
  createdAt: string;
};

export type PendingCommand = {
  id: number;
  runId: string;
  commandType: string;
  payload: JsonValue;
  status: CommandStatus;
  createdAt: string;
  idempotencyKey?: string;
};

type StatementLike = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type DatabaseLike = {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
};

type DatabaseSyncConstructor = new (path: string) => DatabaseLike;

const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

export class RuntimeStore {
  readonly dbPath: string;
  readonly db: DatabaseLike;

  static open(workspaceDir: string): RuntimeStore {
    const stateDir = join(workspaceDir, ".acpus", "state");
    mkdirSync(stateDir, { recursive: true });
    return new RuntimeStore(join(stateDir, "runtime.db"));
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS supervisor_lease (
        workspace_realpath TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        pid INTEGER,
        endpoint TEXT,
        auth_token_hash TEXT,
        heartbeat_at TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        package_version TEXT NOT NULL,
        node_version TEXT NOT NULL,
        exec_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        ir_digest TEXT NOT NULL,
        source_graph_digest TEXT,
        workspace_dir TEXT NOT NULL,
        run_dir TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_admissions (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        ir_json TEXT NOT NULL,
        lock_json TEXT NOT NULL,
        task_bundles_json TEXT NOT NULL,
        input_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        node_key TEXT,
        attempt INTEGER,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS run_events_idempotency
        ON run_events(run_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS node_states (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        node_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        output_json TEXT,
        error_json TEXT,
        metadata_json TEXT,
        PRIMARY KEY (run_id, node_key)
      );

      CREATE INDEX IF NOT EXISTS node_states_run_status
        ON node_states(run_id, status);

      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        node_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        media_type TEXT,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        command_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        idempotency_key TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS commands_idempotency
        ON commands(run_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      INSERT INTO schema_version(id, version, applied_at)
      VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(id) DO UPDATE SET version = excluded.version;
    `);
  }

  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  admitRun(args: {
    runId: string;
    workflowName: string;
    input: JsonValue;
    ir: WorkflowIR;
    irDigest: string;
    sourceGraphDigest?: string;
    lockMetadata: JsonValue;
    taskBundleMetadata: JsonValue;
    workspaceDir: string;
    runDir: string;
  }): StoredRun {
    const admittedAt = now();
    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO runs(run_id, workflow_name, status, admitted_at, input_json, ir_digest, source_graph_digest, workspace_dir, run_dir)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        args.runId,
        args.workflowName,
        admittedAt,
        encodeJson(args.input),
        args.irDigest,
        args.sourceGraphDigest ?? null,
        args.workspaceDir,
        args.runDir,
      );
      this.db.prepare(`
        INSERT INTO run_admissions(run_id, ir_json, lock_json, task_bundles_json, input_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        args.runId,
        encodeJson(args.ir as unknown as JsonValue),
        encodeJson(args.lockMetadata),
        encodeJson(args.taskBundleMetadata),
        encodeJson(args.input),
      );
      this.appendEvent(args.runId, "run.admitted", {
        workflowName: args.workflowName,
        irDigest: args.irDigest,
        sourceGraphDigest: args.sourceGraphDigest ?? null,
      });
    });
    const run = this.getRun(args.runId);
    if (!run) throw new Error(`Failed to read admitted run ${args.runId}.`);
    return run;
  }

  getAdmission(runId: string): RunAdmission | undefined {
    const row = this.db.prepare("SELECT * FROM run_admissions WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId,
      ir: decodeJson(row.ir_json as string) as unknown as WorkflowIR,
      input: decodeJson(row.input_json as string),
      lockMetadata: decodeJson(row.lock_json as string),
      taskBundleMetadata: decodeJson(row.task_bundles_json as string),
    };
  }

  getRun(runId: string): StoredRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(limit = 50): StoredRun[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY admitted_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  updateRunStatus(runId: string, status: RunStatus, payload: JsonValue = null): void {
    const ts = now();
    const startedAt = status === "running" ? ts : undefined;
    const endedAt = isTerminal(status) ? ts : undefined;
    this.withTransaction(() => {
      this.db.prepare(`
        UPDATE runs
        SET status = ?,
            started_at = COALESCE(started_at, ?),
            ended_at = COALESCE(?, ended_at)
        WHERE run_id = ?
      `).run(status, startedAt ?? null, endedAt ?? null, runId);
      this.appendEvent(runId, `run.${status}`, payload);
    });
  }

  completeRun(runId: string, output: JsonValue): void {
    const ts = now();
    this.withTransaction(() => {
      this.db.prepare("UPDATE runs SET status = 'succeeded', output_json = ?, ended_at = ? WHERE run_id = ?").run(encodeJson(output), ts, runId);
      this.appendEvent(runId, "run.succeeded", { output });
    });
  }

  failRun(runId: string, error: JsonValue, status: RunStatus = "failed"): void {
    const ts = now();
    this.withTransaction(() => {
      this.db.prepare("UPDATE runs SET status = ?, error_json = ?, ended_at = ? WHERE run_id = ?").run(status, encodeJson(error), ts, runId);
      this.appendEvent(runId, `run.${status}`, { error });
    });
  }

  appendEvent(runId: string, type: string, payload: JsonValue = null, options: { nodeKey?: string; attempt?: number; idempotencyKey?: string } = {}): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO run_events(run_id, type, node_key, attempt, ts, payload_json, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      type,
      options.nodeKey ?? null,
      options.attempt ?? null,
      now(),
      encodeJson(payload),
      options.idempotencyKey ?? null,
    );
  }

  getNodeState(runId: string, nodeKey: string): StoredNodeState | undefined {
    const row = this.db.prepare("SELECT * FROM node_states WHERE run_id = ? AND node_key = ?").get(runId, nodeKey) as Record<string, unknown> | undefined;
    return row ? rowToNodeState(row) : undefined;
  }

  listNodeStates(runId: string): StoredNodeState[] {
    const rows = this.db.prepare("SELECT * FROM node_states WHERE run_id = ? ORDER BY node_key ASC").all(runId) as Record<string, unknown>[];
    return rows.map(rowToNodeState);
  }

  setNodeState(state: StoredNodeState): void {
    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO node_states(run_id, node_key, node_id, kind, status, attempt, started_at, ended_at, output_json, error_json, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          kind = excluded.kind,
          status = excluded.status,
          attempt = excluded.attempt,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          metadata_json = excluded.metadata_json
      `).run(
        state.runId,
        state.nodeKey,
        state.nodeId,
        state.kind,
        state.status,
        state.attempt,
        state.startedAt ?? null,
        state.endedAt ?? null,
        state.output === undefined ? null : encodeJson(state.output),
        state.error === undefined ? null : encodeJson(state.error),
        state.metadata === undefined ? null : encodeJson(state.metadata),
      );
      this.appendEvent(state.runId, `node.${state.status}`, {
        nodeId: state.nodeId,
        kind: state.kind,
        output: state.output ?? null,
        error: state.error ?? null,
        metadata: state.metadata ?? null,
      }, { nodeKey: state.nodeKey, attempt: state.attempt });
    });
  }

  insertArtifact(args: {
    artifactId: string;
    runId: string;
    nodeKey: string;
    nodeId: string;
    attempt: number;
    mediaType?: string;
    digest: string;
    size: number;
    relativePath: string;
  }): void {
    this.db.prepare(`
      INSERT INTO artifacts(artifact_id, run_id, node_key, node_id, attempt, media_type, digest, size, relative_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.artifactId,
      args.runId,
      args.nodeKey,
      args.nodeId,
      args.attempt,
      args.mediaType ?? null,
      args.digest,
      args.size,
      args.relativePath,
      now(),
    );
  }

  listArtifacts(runId: string): ArtifactRow[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id ASC").all(runId) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  }

  addCommand(runId: string, commandType: string, payload: JsonValue = null, idempotencyKey = randomUUID()): number {
    this.db.prepare(`
      INSERT OR IGNORE INTO commands(run_id, command_type, payload_json, status, created_at, idempotency_key)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(runId, commandType, encodeJson(payload), now(), idempotencyKey);
    const row = this.db.prepare("SELECT id FROM commands WHERE run_id = ? AND idempotency_key = ?").get(runId, idempotencyKey) as { id?: number } | undefined;
    return Number(row?.id ?? 0);
  }

  pendingCommands(runId: string, commandTypes?: string[]): PendingCommand[] {
    const sql = commandTypes?.length
      ? `SELECT * FROM commands WHERE run_id = ? AND status = 'pending' AND command_type IN (${commandTypes.map(() => "?").join(", ")}) ORDER BY id ASC`
      : "SELECT * FROM commands WHERE run_id = ? AND status = 'pending' ORDER BY id ASC";
    const rows = this.db.prepare(sql).all(runId, ...(commandTypes ?? [])) as Record<string, unknown>[];
    return rows.map(rowToCommand);
  }

  markCommandApplied(commandId: number): void {
    this.db.prepare("UPDATE commands SET status = 'applied', applied_at = ? WHERE id = ?").run(now(), commandId);
  }

  takeSignalPayload(runId: string, nodeId: string, nodeKey: string): JsonValue | undefined {
    const commands = this.pendingCommands(runId, ["signal"]);
    for (const command of commands) {
      const payload = isObject(command.payload) ? command.payload : {};
      const targetNodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
      const targetNodeKey = typeof payload.nodeKey === "string" ? payload.nodeKey : undefined;
      if (targetNodeId === nodeId || targetNodeKey === nodeKey) {
        this.markCommandApplied(command.id);
        return (payload.payload ?? null) as JsonValue;
      }
    }
    return undefined;
  }

  nextControlCommand(runId: string): PendingCommand | undefined {
    return this.pendingCommands(runId, ["pause", "cancel", "shutdown", "resume"])[0];
  }

  retry(runId: string, nodeKey?: string): void {
    this.withTransaction(() => {
      if (nodeKey) {
        this.db.prepare("DELETE FROM node_states WHERE run_id = ? AND (node_key = ? OR node_key LIKE ?) AND status != 'succeeded'").run(runId, nodeKey, `${nodeKey}/%`);
      } else {
        this.db.prepare("DELETE FROM node_states WHERE run_id = ? AND status IN ('failed', 'running', 'awaiting_signal')").run(runId);
      }
      this.db.prepare("UPDATE runs SET status = 'queued', ended_at = NULL, error_json = NULL WHERE run_id = ?").run(runId);
      this.appendEvent(runId, "run.retry_requested", nodeKey ? { nodeKey } : null);
    });
  }
}

export function runtimeId(prefix = "run"): string {
  return `${prefix}_${new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "")}_${randomUUID().slice(0, 8)}`;
}

export function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function now(): string {
  return new Date().toISOString();
}

function rowToRun(row: Record<string, unknown>): StoredRun {
  const run: StoredRun = {
    runId: String(row.run_id),
    workflowName: String(row.workflow_name),
    status: row.status as RunStatus,
    admittedAt: String(row.admitted_at),
    input: decodeJson(String(row.input_json)),
    irDigest: String(row.ir_digest),
    workspaceDir: String(row.workspace_dir),
    runDir: String(row.run_dir),
  };
  if (row.started_at) run.startedAt = String(row.started_at);
  if (row.ended_at) run.endedAt = String(row.ended_at);
  if (row.output_json) run.output = decodeJson(String(row.output_json));
  if (row.error_json) run.error = decodeJson(String(row.error_json));
  if (row.source_graph_digest) run.sourceGraphDigest = String(row.source_graph_digest);
  return run;
}

function rowToNodeState(row: Record<string, unknown>): StoredNodeState {
  const state: StoredNodeState = {
    runId: String(row.run_id),
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    kind: String(row.kind),
    status: row.status as NodeStatus,
    attempt: Number(row.attempt),
  };
  if (row.started_at) state.startedAt = String(row.started_at);
  if (row.ended_at) state.endedAt = String(row.ended_at);
  if (row.output_json) state.output = decodeJson(String(row.output_json));
  if (row.error_json) state.error = decodeJson(String(row.error_json));
  if (row.metadata_json) state.metadata = decodeJson(String(row.metadata_json));
  return state;
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRow {
  const artifact: ArtifactRow = {
    id: Number(row.id),
    artifactId: String(row.artifact_id),
    runId: String(row.run_id),
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    attempt: Number(row.attempt),
    digest: String(row.digest),
    size: Number(row.size),
    relativePath: String(row.relative_path),
    createdAt: String(row.created_at),
  };
  if (row.media_type) artifact.mediaType = String(row.media_type);
  return artifact;
}

function rowToCommand(row: Record<string, unknown>): PendingCommand {
  const command: PendingCommand = {
    id: Number(row.id),
    runId: String(row.run_id),
    commandType: String(row.command_type),
    payload: decodeJson(String(row.payload_json)),
    status: row.status as CommandStatus,
    createdAt: String(row.created_at),
  };
  if (row.idempotency_key) command.idempotencyKey = String(row.idempotency_key);
  return command;
}

function encodeJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function decodeJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
