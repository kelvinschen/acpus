import fs from "node:fs/promises";
import path from "node:path";
import { runDir } from "../run-index/paths.js";
import { RuntimeErrorCodes, type RunIndex } from "../run-index/read-write.js";

export const RUN_DIAGNOSTICS_VIEW_VERSION = "acpus.diagnostics/v1";

const RUN_LEVEL_RUNTIME_CODES = new Set<string>([
  RuntimeErrorCodes.EVENT_APPEND_LOCK_TIMEOUT,
  RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT,
  RuntimeErrorCodes.OUTPUT_REPAIR_FAILED,
  RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT,
  RuntimeErrorCodes.FANOUT_ITEM_BLOCKED,
  RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
  RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED,
  RuntimeErrorCodes.FANOUT_LANE_RESULT_MISMATCH,
  RuntimeErrorCodes.NO_MATCHING_LANES,
  RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
  RuntimeErrorCodes.FANOUT_STAGE_STUCK_PENDING_BATCH,
  RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
  RuntimeErrorCodes.LOOP_EXHAUSTED,
  RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED,
  RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED,
  RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING,
  RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
  RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
  RuntimeErrorCodes.AGENT_TURN_FAILED,
  RuntimeErrorCodes.AGENT_TURN_CANCELLED,
  RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
  RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
  RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY,
  RuntimeErrorCodes.GATE_CONDITION_FAILED,
  RuntimeErrorCodes.GATE_VERDICT_BLOCKED,
  RuntimeErrorCodes.GATE_VERDICT_FAILED,
  RuntimeErrorCodes.GATE_VERDICT_UNKNOWN
]);

export const RunDiagnosticCodes = {
  SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT: "SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT"
} as const;

export type RunDiagnosticSource = "run_index" | "stage_output" | "attempt" | "event_tail";

export type RunDiagnostic = {
  id: string;
  code?: string;
  stageId?: string;
  itemId?: string;
  attemptId?: string;
  status?: string;
  summary: string;
  path?: string;
  source: RunDiagnosticSource;
};

export type RunDiagnosticEvent = {
  at?: string;
  type?: string;
  stageId?: string;
  itemId?: string;
  attemptId?: string;
  errorCode?: string;
  summary?: string;
};

export type RunDiagnosticsView = {
  version: typeof RUN_DIAGNOSTICS_VIEW_VERSION;
  generatedAt: string;
  run: {
    logicalRunId: string;
    workflowName: string;
    status: RunIndex["status"];
    blockedReason?: string;
    gateVerdict?: RunIndex["gateVerdict"];
    runDir: string;
  };
  diagnostics: RunDiagnostic[];
  eventTail: RunDiagnosticEvent[];
};

export type BuildRunDiagnosticsOptions = {
  eventTailLimit?: number;
  eventTailMaxBytes?: number;
};

const DEFAULT_EVENT_TAIL_LIMIT = 50;
const DEFAULT_EVENT_TAIL_MAX_BYTES = 256 * 1024;

export async function buildRunDiagnosticsView(
  cwd: string,
  index: RunIndex,
  options: BuildRunDiagnosticsOptions = {}
): Promise<RunDiagnosticsView> {
  const dir = runDir(index.logicalRunId, cwd);
  const eventTail = await readEventTail(path.join(dir, "events.ndjson"), {
    limit: options.eventTailLimit ?? DEFAULT_EVENT_TAIL_LIMIT,
    maxBytes: options.eventTailMaxBytes ?? DEFAULT_EVENT_TAIL_MAX_BYTES
  });
  const diagnostics = [
    ...await buildRuntimeDiagnostics(dir, index),
    ...buildEventTailDiagnostics(path.join(dir, "events.ndjson"), eventTail)
  ];
  return {
    version: RUN_DIAGNOSTICS_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      logicalRunId: index.logicalRunId,
      workflowName: index.workflowName,
      status: index.status,
      blockedReason: index.blockedReason,
      gateVerdict: index.gateVerdict,
      runDir: dir
    },
    diagnostics,
    eventTail
  };
}

export async function readNdjsonTail(filePath: string, maxLines: number, maxBytes = DEFAULT_EVENT_TAIL_MAX_BYTES): Promise<string[]> {
  if (maxLines <= 0 || maxBytes <= 0) return [];
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) return [];
    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    handle = await fs.open(filePath, "r");
    await handle.read(buffer, 0, bytesToRead, start);
    let lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1);
    return lines.filter((line) => line.trim().length > 0).slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readEventTail(filePath: string, options: { limit: number; maxBytes: number }): Promise<RunDiagnosticEvent[]> {
  const lines = await readNdjsonTail(filePath, options.limit, options.maxBytes);
  return lines.map(parseEventLine).filter((event): event is RunDiagnosticEvent => event !== undefined);
}

async function buildRuntimeDiagnostics(dir: string, index: RunIndex): Promise<RunDiagnostic[]> {
  const diagnostics: RunDiagnostic[] = [];
  if (index.blockedReason && isRunLevelRuntimeCode(index.blockedReason)) {
    diagnostics.push(runtimeDiagnostic({
      code: index.blockedReason,
      path: path.join(dir, "run.json"),
      summary: runLevelBlockedSummary(index),
      source: "run_index"
    }));
  }

  for (const stage of Object.values(index.stages)) {
    if (!stage.fanout && (stage.blockedReason === RuntimeErrorCodes.AGENT_RUNTIME_ERROR || stage.blockedReason === RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY)) {
      const outputPath = stage.outputPath ? path.join(dir, stage.outputPath) : path.join(dir, "outputs", `${stage.stageId}.json`);
      const code = stage.blockedReason;
      diagnostics.push(runtimeDiagnostic({
        code,
        stageId: stage.stageId,
        path: outputPath,
        summary: code === RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY ? "Agent stage stale recovery exhausted runtime retry." : "Agent runtime failed after one retry.",
        source: "run_index"
      }));
    }

    if (!stage.fanout) continue;
    const hasRunningItems = stage.fanout.items.some((item) => item.status === "running");
    const queuedItems = stage.fanout.items.filter((item) => item.status === "pending" || item.status === "ready");
    if (stage.status === "running" && !hasRunningItems && queuedItems.length > 0) {
      diagnostics.push(runtimeDiagnostic({
        code: RuntimeErrorCodes.FANOUT_STAGE_STUCK_PENDING_BATCH,
        stageId: stage.stageId,
        path: path.join(dir, "run.json"),
        summary: `Fanout stage ${stage.stageId} is running with no running items and ${queuedItems.length} queued item(s).`,
        source: "run_index"
      }));
    }

    for (const item of stage.fanout.items) {
      const outputPath = item.outputPath ? path.join(dir, item.outputPath) : path.join(dir, "outputs", stage.stageId, `${safeFileName(item.id)}.json`);
      if (item.status === "running" && await fileExists(outputPath)) {
        diagnostics.push(runtimeDiagnostic({
          code: RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
          stageId: stage.stageId,
          itemId: item.id,
          path: outputPath,
          summary: `Fanout item ${stage.stageId}/${item.id} is running in run.json but has an output file.`,
          source: "stage_output"
        }));
      }
      if (item.errorCode) {
        diagnostics.push(runtimeDiagnostic({
          code: item.errorCode,
          stageId: stage.stageId,
          itemId: item.id,
          path: outputPath,
          summary: item.errorMessage ?? item.blockedReason ?? item.errorCode,
          source: "run_index"
        }));
      }
    }
  }

  const recoveryVerdictDiagnostic = buildRecoverySucceededWithBlockedVerdictDiagnostic(dir, index);
  if (recoveryVerdictDiagnostic) diagnostics.push(recoveryVerdictDiagnostic);
  return diagnostics;
}

function buildEventTailDiagnostics(eventPath: string, eventTail: RunDiagnosticEvent[]): RunDiagnostic[] {
  const diagnostics: RunDiagnostic[] = [];
  for (const event of eventTail) {
    const lockContention = event.summary?.includes("Lock file is already being held")
      || event.errorCode === RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT
      || event.errorCode === RuntimeErrorCodes.EVENT_APPEND_LOCK_TIMEOUT;
    if (!lockContention) continue;
    diagnostics.push(runtimeDiagnostic({
      code: event.errorCode ?? "LOCK_CONTENTION",
      stageId: event.stageId,
      itemId: event.itemId,
      attemptId: event.attemptId,
      path: eventPath,
      summary: "Runtime lock contention was observed in recent events.",
      source: "event_tail",
      status: "blocked"
    }));
  }
  return diagnostics;
}

function buildRecoverySucceededWithBlockedVerdictDiagnostic(dir: string, index: RunIndex): RunDiagnostic | undefined {
  if (!isBlockedGateVerdictCode(index.blockedReason) || !index.gateVerdict) return undefined;
  const recoveredFanoutStages = Object.values(index.stages).filter((stage) => {
    if (!stage.fanout) return false;
    if (stage.fanout.items.some((item) => item.status === "running" || item.status === "pending" || item.status === "ready")) return false;
    return stage.fanout.items.some((item) =>
      item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
      || item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
      || item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED
      || item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT
      || item.errorCode === RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH
    );
  });
  if (recoveredFanoutStages.length === 0) return undefined;
  const stageIds = recoveredFanoutStages.map((stage) => stage.stageId);
  return {
    id: `runtime-${RunDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT}-run-all`,
    code: RunDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT,
    status: "completed",
    summary: `Scheduler recovery completed for fanout stage(s) ${stageIds.join(", ")}, but workflow gate verdict remains ${index.gateVerdict}.`,
    path: path.join(dir, "run.json"),
    source: "run_index"
  };
}

function runtimeDiagnostic(input: {
  code: string;
  summary: string;
  source: RunDiagnosticSource;
  path?: string;
  stageId?: string;
  itemId?: string;
  attemptId?: string;
  status?: string;
}): RunDiagnostic {
  return {
    id: `runtime-${input.code}-${input.stageId ?? "run"}-${input.itemId ?? input.attemptId ?? "all"}`,
    code: input.code,
    stageId: input.stageId,
    itemId: input.itemId,
    attemptId: input.attemptId,
    status: input.status ?? "blocked",
    summary: input.summary,
    path: input.path,
    source: input.source
  };
}

function isRunLevelRuntimeCode(value: string): boolean {
  return RUN_LEVEL_RUNTIME_CODES.has(value);
}

function isBlockedGateVerdictCode(value: string | undefined): boolean {
  return value === RuntimeErrorCodes.GATE_VERDICT_BLOCKED
    || value === RuntimeErrorCodes.GATE_VERDICT_FAILED
    || value === RuntimeErrorCodes.GATE_VERDICT_UNKNOWN;
}

function runLevelBlockedSummary(index: RunIndex): string {
  if (index.blockedReason === RuntimeErrorCodes.AGENT_RUNTIME_ERROR) return "Agent runtime failed after one retry.";
  if (index.blockedReason === RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY) return "Agent stage stale recovery exhausted runtime retry.";
  if (index.blockedReason === RuntimeErrorCodes.FANOUT_ITEM_BLOCKED) return "Fanout stage blocked because one or more items did not complete.";
  if (index.blockedReason === RuntimeErrorCodes.GATE_CONDITION_FAILED) return "Program gate condition failed.";
  if (index.gateVerdict === "blocked") return "Gate returned verdict=blocked.";
  if (index.gateVerdict === "failed") return "Gate returned verdict=failed.";
  return "Gate returned verdict=unknown.";
}

function parseEventLine(line: string): RunDiagnosticEvent | undefined {
  const raw = safeJson(line);
  const record = objectRecord(raw);
  if (!record) return undefined;
  const errorCode = stringField(record, "errorCode") ?? stringField(record, "code");
  return {
    at: stringField(record, "at"),
    type: stringField(record, "type"),
    stageId: stringField(record, "stageId"),
    itemId: stringField(record, "itemId"),
    attemptId: stringField(record, "attemptId"),
    errorCode,
    summary: stringField(record, "summary") ?? stringField(record, "error") ?? stringField(record, "errorMessage")
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function safeFileName(value: string): string {
  return String(value || "item").replace(/[^A-Za-z0-9_.-]/g, "_");
}
