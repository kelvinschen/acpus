import fs from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { runDir } from "./paths.js";

export const RuntimeErrorCodes = {
  EVENT_APPEND_LOCK_TIMEOUT: "EVENT_APPEND_LOCK_TIMEOUT",
  RUN_INDEX_LOCK_TIMEOUT: "RUN_INDEX_LOCK_TIMEOUT",
  AGENT_RUNTIME_ERROR: "AGENT_RUNTIME_ERROR",
  AGENT_TURN_CANCELLED: "AGENT_TURN_CANCELLED",
  AGENT_TURN_FAILED: "AGENT_TURN_FAILED",
  AGENT_STAGE_STALE_RECOVERY: "AGENT_STAGE_STALE_RECOVERY",
  OUTPUT_REPAIR_FAILED: "OUTPUT_REPAIR_FAILED",
  FANOUT_ITEM_RUNTIME_ERROR: "FANOUT_ITEM_RUNTIME_ERROR",
  FANOUT_ITEM_STALE_RECOVERY: "FANOUT_ITEM_STALE_RECOVERY",
  FANOUT_ITEM_BLOCKED: "FANOUT_ITEM_BLOCKED",
  FANOUT_ITEM_CASCADE_BLOCKED: "FANOUT_ITEM_CASCADE_BLOCKED",
  FANOUT_LANE_SELECTION_FAILED: "FANOUT_LANE_SELECTION_FAILED",
  FANOUT_LANE_RESULT_MISMATCH: "FANOUT_LANE_RESULT_MISMATCH",
  NO_MATCHING_LANES: "NO_MATCHING_LANES",
  FANOUT_ITEM_UNSTARTED_TIMEOUT: "FANOUT_ITEM_UNSTARTED_TIMEOUT",
  MISSING_FANOUT_ITEM_OUTPUT: "MISSING_FANOUT_ITEM_OUTPUT",
  FANOUT_STAGE_STUCK_PENDING_BATCH: "FANOUT_STAGE_STUCK_PENDING_BATCH",
  RUN_INDEX_OUTPUT_MISMATCH: "RUN_INDEX_OUTPUT_MISMATCH",
  GATE_CONDITION_FAILED: "GATE_CONDITION_FAILED",
  GATE_VERDICT_BLOCKED: "GATE_VERDICT_BLOCKED",
  GATE_VERDICT_FAILED: "GATE_VERDICT_FAILED",
  GATE_VERDICT_UNKNOWN: "GATE_VERDICT_UNKNOWN",
  LOOP_EXHAUSTED: "LOOP_EXHAUSTED",
  LOOP_BODY_STAGE_BLOCKED: "LOOP_BODY_STAGE_BLOCKED",
  LOOP_BODY_STAGE_FAILED: "LOOP_BODY_STAGE_FAILED",
  LOOP_BODY_OUTPUT_MISSING: "LOOP_BODY_OUTPUT_MISSING",
  VARIABLE_RESOLUTION_FAILED: "VARIABLE_RESOLUTION_FAILED"
} as const;

export type RuntimeErrorCode = (typeof RuntimeErrorCodes)[keyof typeof RuntimeErrorCodes];

export class RuntimePersistenceError extends Error {
  readonly code: RuntimeErrorCode;
  readonly metadata: Record<string, unknown>;

  constructor(code: RuntimeErrorCode, message: string, metadata: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = "RuntimePersistenceError";
    this.code = code;
    this.metadata = metadata;
    this.cause = cause;
  }
}

export type AttemptStatus =
  | "pending"
  | "running"
  | "raw_received"
  | "parsing"
  | "repairing"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";

export type StageStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "diagnosed_blocked"
  | "failed"
  | "cancelled";

export type WorkerStatus = "starting" | "running" | "stale" | "exited" | "failed";

export type RunWorkerState = {
  pid: number;
  generation: number;
  status: WorkerStatus;
  startedAt: string;
  heartbeatAt: string;
  exitedAt?: string;
  exitCode?: number | null;
};

export type AttemptIndexEntry = {
  id: string;
  stageId: string;
  itemId?: string;
  groupId?: string;
  laneId?: string;
  kind: "attempt" | "repair" | "diagnostic";
  status: AttemptStatus;
  path: string;
  startedAt?: string;
  endedAt?: string;
  blockedReason?: string;
  parseErrorCode?: string;
  rawPreview?: string;
  promptPreview?: string;
  sessionKey?: string;
  requestId?: string;
  stopReason?: string;
  runtimeErrorCode?: string;
  runtimeRetryOf?: string;
  runtimeRetryOrdinal?: number;
  runtimeRetryReason?: string;
  agent?: string;
  roleMode?: string;
  runtimeDisposeInvoked?: boolean;
};

export type StageIndexEntry = {
  stageId: string;
  status: StageStatus;
  attempts: string[];
  outputPath?: string;
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  skippedReason?: string;
  runtimeRetryOf?: string;
  runtimeRetryOrdinal?: number;
  fanout?: {
    totalItems: number;
    completedItems: number;
    blockedItems: number;
    allowPartial: boolean;
    failedItems?: number;
    skippedItems?: number;
    workUnits?: number;
    items: Array<{
      id: string;
      index: number;
      status: StageStatus;
      outputPath?: string;
      blockedReason?: string;
      attemptId?: string;
      startedAt?: string;
      completedAt?: string;
      errorCode?: string;
      errorMessage?: string;
      runtimeRetryOf?: string;
      runtimeRetryOrdinal?: number;
      skippedReason?: string;
      groups?: Array<{
        id: string;
        mode: "all" | "oneOf";
        status: StageStatus;
        lanes: Array<{
          id: string;
          roleName: string;
          status: StageStatus;
          outputPath?: string;
          blockedReason?: string;
          attemptId?: string;
          startedAt?: string;
          completedAt?: string;
          errorCode?: string;
          errorMessage?: string;
          runtimeRetryOf?: string;
          runtimeRetryOrdinal?: number;
        }>;
      }>;
    }>;
  };
  loop?: {
    maxRounds: number;
    currentRound?: number;
    bodyOutputStageId: string;
    rounds: Array<{
      round: number;
      status: StageStatus;
      startedAt?: string;
      completedAt?: string;
      outputPath?: string;
      bodyOutputStageId: string;
      bodyOutput?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
      stages: Record<string, {
        stageId: string;
        status: StageStatus;
        attempts: string[];
        outputPath?: string;
        blockedReason?: string;
        startedAt?: string;
        completedAt?: string;
        fanout?: StageIndexEntry["fanout"];
      }>;
    }>;
  };
};

export type RunIndex = {
  schemaVersion: "acpx-workflow-orchestrator.run/v2";
  logicalRunId: string;
  workflowName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  source?: {
    kind: "draft" | "saved" | "spec";
    path?: string;
    sha256?: string;
  };
  stages: Record<string, StageIndexEntry>;
  attempts: Record<string, AttemptIndexEntry>;
  agentUsage: {
    planned: number;
    actual: number;
    repairCalls: number;
    recoveryCalls: number;
  };
  worker?: RunWorkerState;
  gateVerdict?: "pass" | "pass_with_warnings" | "blocked" | "failed" | "unknown";
  blockedReason?: string;
  resumePolicy?: {
    fanout?: Record<string, {
      allowPartial?: boolean;
      maxItems?: number;
      skipItemIndexes?: number[];
    }>;
  };
};

export async function writeRunIndex(cwd: string, index: RunIndex): Promise<void> {
  const dir = runDir(index.logicalRunId, cwd);
  await fs.mkdir(dir, { recursive: true });
  const release = await lockRunIndex(dir, {
    operation: "writeRunIndex",
    targetPath: path.join(dir, "run.json"),
    logicalRunId: index.logicalRunId
  });
  try {
    const filePath = path.join(dir, "run.json");
    const tmpPath = `${filePath}.tmp`;
    const updated = { ...index, updatedAt: new Date().toISOString() };
    await fs.writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await release();
  }
}

export async function updateRunIndex(cwd: string, logicalRunId: string, update: (index: RunIndex) => RunIndex | Promise<RunIndex>): Promise<RunIndex> {
  const dir = runDir(logicalRunId, cwd);
  await fs.mkdir(dir, { recursive: true });
  const release = await lockRunIndex(dir, {
    operation: "updateRunIndex",
    targetPath: path.join(dir, "run.json"),
    logicalRunId
  });
  try {
    const filePath = path.join(dir, "run.json");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as RunIndex;
    const current = normalizeRunIndex(parsed);
    const next = await update(current);
    const updated = { ...next, updatedAt: new Date().toISOString() };
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
    return normalizeRunIndex(updated);
  } finally {
    await release();
  }
}

export async function readRunIndex(cwd: string, logicalRunId: string): Promise<RunIndex> {
  const filePath = path.join(runDir(logicalRunId, cwd), "run.json");
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as RunIndex;
  return normalizeRunIndex(parsed);
}

function normalizeRunIndex(parsed: RunIndex): RunIndex {
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion ?? "acpx-workflow-orchestrator.run/v2",
    stages: parsed.stages ?? {},
    attempts: parsed.attempts ?? {}
  };
}

export async function appendEvent(cwd: string, logicalRunId: string, event: Record<string, unknown>): Promise<void> {
  const dir = runDir(logicalRunId, cwd);
  const eventPath = path.join(dir, "events.ndjson");
  const key = eventPath;
  const previous = eventWriteQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(eventPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
    } catch (error) {
      throw enrichPersistenceError(error, RuntimeErrorCodes.EVENT_APPEND_LOCK_TIMEOUT, {
        operation: "appendEvent",
        targetPath: eventPath,
        logicalRunId,
        stageId: event.stageId,
        itemId: event.itemId,
        attemptId: event.attemptId,
        eventType: event.type
      });
    }
  });
  eventWriteQueues.set(key, queued);
  try {
    await queued;
  } finally {
    if (eventWriteQueues.get(key) === queued) eventWriteQueues.delete(key);
  }
}

const eventWriteQueues = new Map<string, Promise<void>>();

async function lockRunIndex(dir: string, metadata: Record<string, unknown>): Promise<() => Promise<void>> {
  try {
    return await lock(dir, {
      retries: { retries: 10, factor: 1.4, minTimeout: 25, maxTimeout: 250, randomize: true },
      realpath: false
    });
  } catch (error) {
    throw enrichPersistenceError(error, RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT, metadata);
  }
}

function enrichPersistenceError(
  error: unknown,
  code: RuntimeErrorCode,
  metadata: Record<string, unknown>
): RuntimePersistenceError {
  if (error instanceof RuntimePersistenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimePersistenceError(code, `${code}: ${message}`, metadata, error);
}
