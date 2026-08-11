import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { isPreparedRunWorkflow, type PreparedRunWorkflow } from "../admission/prepared-workflow.js";
import type { AgentOverrideMap } from "../control/agent-overrides.js";
import type { RunDetails } from "../store/store.js";

export const DAEMON_PROTOCOL_VERSION = 3;

export type DaemonStatus = {
  status: "ok";
  pid: number;
  generation: number;
  protocolVersion: number;
  packageVersion: string;
};

export type DaemonAdmitRunInput = {
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
};

type DaemonAdmitRunRequest = { method: "admitRun" } & DaemonAdmitRunInput;

export type DaemonRequest = {
  method: "status";
} | {
  method: "shutdown";
} | {
  method: "control";
  control: DaemonControlIntent;
} | DaemonAdmitRunRequest;

export type DaemonControlResult =
  | { type: "pause"; state: "applied"; run: RunDetails }
  | { type: "resume"; state: "applied"; run: RunDetails }
  | { type: "retry"; state: "applied"; run: RunDetails; target?: string }
  | { type: "cancel"; state: "applied"; run: RunDetails; target?: string }
  | {
    type: "steer";
    state: "applied";
    run: RunDetails;
    steerId: string;
    requestedTarget: string;
    target: string;
    fencedAttemptId: string;
    continuation: "queued";
  }
  | { type: "fork"; state: "applied"; sourceRunId: string; run: RunDetails }
  | {
    type: "signal";
    state: "consumed";
    requestedTarget: string;
    target: string;
    validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
    run: RunDetails;
  };

export type DaemonControlIntent =
  | { requestId: string; type: "pause" | "resume"; runId: string }
  | { requestId: string; type: "retry" | "cancel"; runId: string; target?: string }
  | { requestId: string; type: "steer"; runId: string; target: string; instruction: string }
  | { requestId: string; type: "fork"; runId: string; target?: string; prepared?: PreparedRunWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap }
  | { requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue };

export type DaemonResponse =
  | { ok: true; result: DaemonStatus | DaemonShutdownResult | RunDetails | DaemonControlResult }
  | { ok: false; error: { code: DaemonErrorCode; message: string; ambiguity?: true } };

const DAEMON_ERROR_CODES = ["INVALID_REQUEST", "RUN_NOT_FOUND", "RUN_NOT_CONTROLLABLE", "CONTROL_CONFLICT", "EXECUTION_UNAVAILABLE", "STORE_BUSY", "STORE_ERROR", "INTERNAL_ERROR"] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export type DaemonShutdownResult = {
  status: "shutdown";
};

export type DaemonHandlerFailure = { code: DaemonErrorCode; message: string; ambiguity?: true };

export type DaemonClientFailure =
  | { type: "rejected"; code: DaemonErrorCode; message: string; ambiguity?: true }
  | { type: "transport"; reason: "not-found" | "refused" | "timeout" | "io"; method: DaemonRequest["method"]; errno?: string; message: string }
  | { type: "protocol"; stage: "envelope" | "result"; method: DaemonRequest["method"]; message: string };

export function parseDaemonRequest(raw: string):
  | { ok: true; value: DaemonRequest }
  | { ok: false; response: DaemonResponse } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isPlainRecord(value) || typeof value.method !== "string") {
      return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request.") };
    }
    if (value.method === "status" || value.method === "shutdown") {
      return hasExactKeys(value, ["method"])
        ? { ok: true, value: { method: value.method } }
        : { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request.") };
    }
    if (value.method === "admitRun") {
      if (!isAdmitRunRequest(value)) {
        return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon admission request.") };
      }
      return { ok: true, value };
    }
    if (value.method !== "control" || !hasExactKeys(value, ["method", "control"]) || !isControlIntent(value.control)) {
      return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Unsupported daemon method.") };
    }
    return { ok: true, value: { method: "control", control: value.control } };
  } catch {
    return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request JSON.") };
  }
}

export function appliedDaemonResponse(result: Extract<DaemonResponse, { ok: true }>["result"]): DaemonResponse {
  return { ok: true, result };
}

export function failedDaemonResponse(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonResponse {
  return { ok: false, error: { code, message, ...(ambiguity ? { ambiguity } : {}) } };
}

export function describeDaemonRequest(request: DaemonRequest): string {
  if (request.method === "admitRun") return "run admission";
  if (request.method === "control") return `${request.control.type} control for run '${request.control.runId}'`;
  return request.method;
}

export function daemonFailureMessage(request: DaemonRequest, code: DaemonErrorCode): string {
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  if (request.method === "status") return "Daemon status is unavailable.";
  if (request.method === "admitRun") return "Run admission failed.";
  if (request.method === "control") return `Control '${request.control.type}' could not be applied to run '${request.control.runId}'.`;
  return "Daemon shutdown failed.";
}

export function isDaemonStatus(value: unknown): value is DaemonStatus {
  return isPlainRecord(value)
    && hasExactKeys(value, ["status", "pid", "generation", "protocolVersion", "packageVersion"])
    && value.status === "ok"
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && Number.isInteger(value.generation) && Number(value.generation) > 0
    && Number.isInteger(value.protocolVersion) && Number(value.protocolVersion) > 0
    && typeof value.packageVersion === "string";
}

export function isDaemonShutdownResult(value: unknown): value is DaemonShutdownResult {
  return isPlainRecord(value) && hasExactKeys(value, ["status"]) && value.status === "shutdown";
}

export function isRunDetails(value: unknown): value is RunDetails {
  if (!isPlainRecord(value)
    || !hasExactKeys(
      value,
      [
        "id",
        "name",
        "status",
        "workflowEntry",
        "sourceGraphDigest",
        "createdAt",
        "updatedAt",
        "progressVersion",
        "input",
        "hooks",
        "eventCount",
        "nodeCount",
        "execution",
      ],
      ["progressUpdatedAt", "output", "agentOverrides", "fork", "dynamic"],
    )
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || !isRunStatus(value.status)
    || typeof value.workflowEntry !== "string"
    || typeof value.sourceGraphDigest !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !isNonNegativeInteger(value.progressVersion)
    || (value.progressUpdatedAt !== undefined && typeof value.progressUpdatedAt !== "string")
    || !isJsonValue(value.input)
    || (value.output !== undefined && !isJsonValue(value.output))
    || (value.agentOverrides !== undefined && (!isPlainRecord(value.agentOverrides) || !isJsonValue(value.agentOverrides)))
    || (value.fork !== undefined && !isRunForkInfo(value.fork))
    || !Array.isArray(value.hooks)
    || !isJsonValue(value.hooks)
    || !isNonNegativeInteger(value.eventCount)
    || !isNonNegativeInteger(value.nodeCount)
    || !isRunExecutionState(value.execution)
    || (value.dynamic !== undefined && (!isPlainRecord(value.dynamic) || !isJsonValue(value.dynamic)))) {
    return false;
  }
  return true;
}

export function isDaemonControlResult(
  value: unknown,
  expectedType: DaemonControlIntent["type"],
): value is DaemonControlResult {
  if (!isPlainRecord(value) || value.type !== expectedType || !isRunDetails(value.run)) return false;
  if (value.type === "pause" || value.type === "resume") {
    return hasExactKeys(value, ["type", "state", "run"]) && value.state === "applied";
  }
  if (value.type === "retry" || value.type === "cancel") {
    return hasExactKeys(value, ["type", "state", "run"], ["target"])
      && value.state === "applied"
      && (value.target === undefined || typeof value.target === "string" && value.target.length > 0);
  }
  if (value.type === "steer") {
    return hasExactKeys(value, ["type", "state", "run", "steerId", "requestedTarget", "target", "fencedAttemptId", "continuation"])
      && value.state === "applied"
      && value.continuation === "queued"
      && typeof value.steerId === "string" && value.steerId.length > 0
      && typeof value.requestedTarget === "string" && value.requestedTarget.length > 0
      && typeof value.target === "string" && value.target.length > 0
      && typeof value.fencedAttemptId === "string" && value.fencedAttemptId.length > 0;
  }
  if (value.type === "fork") {
    return hasExactKeys(value, ["type", "state", "sourceRunId", "run"])
      && value.state === "applied"
      && typeof value.sourceRunId === "string";
  }
  return value.type === "signal"
    && hasExactKeys(value, ["type", "state", "requestedTarget", "target", "validation", "run"])
    && value.state === "consumed"
    && typeof value.requestedTarget === "string"
    && typeof value.target === "string"
    && isSignalValidation(value.validation);
}

export function isDaemonResponse(value: unknown): value is DaemonResponse {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "result"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]) || !isPlainRecord(value.error)) return false;
  return hasExactKeys(value.error, ["code", "message"], ["ambiguity"])
    && DAEMON_ERROR_CODES.includes(value.error.code as DaemonErrorCode)
    && typeof value.error.message === "string"
    && (value.error.ambiguity === undefined || value.error.ambiguity === true);
}

function isRunStatus(value: unknown): value is RunDetails["status"] {
  return value === "pending"
    || value === "running"
    || value === "paused"
    || value === "awaiting"
    || value === "failed"
    || value === "completed"
    || value === "canceled";
}

function isRunExecutionState(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(
      value,
      ["state", "lastStatus"],
      ["reason", "daemonHeartbeatAt", "ownerId", "leaseExpiresAt"],
    )
    || typeof value.state !== "string"
    || !["active", "inactive", "stale", "terminal", "unknown"].includes(value.state)
    || !isRunStatus(value.lastStatus)
    || (value.reason !== undefined && (typeof value.reason !== "string" || ![
        "terminal",
        "daemon_heartbeat_expired",
        "daemon_pid_dead",
        "run_lease_expired",
        "run_lease_active",
        "daemon_alive",
        "no_liveness_evidence",
      ].includes(value.reason)))) {
    return false;
  }
  return [value.daemonHeartbeatAt, value.ownerId, value.leaseExpiresAt]
    .every(field => field === undefined || typeof field === "string");
}

function isRunForkInfo(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["sourceRunId"], ["target"])
    && typeof value.sourceRunId === "string"
    && (value.target === undefined || typeof value.target === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isSignalValidation(value: unknown): value is Extract<DaemonControlResult, { type: "signal" }>["validation"] {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "raw-string") return hasExactKeys(value, ["kind"]);
  return value.kind === "schema"
    && hasExactKeys(value, ["kind", "schemaSummary"])
    && typeof value.schemaSummary === "string";
}

function isControlIntent(value: unknown): value is DaemonControlIntent {
  if (!isPlainRecord(value) || typeof value.requestId !== "string" || typeof value.type !== "string" || typeof value.runId !== "string") return false;
  if (value.type === "pause" || value.type === "resume") return hasExactKeys(value, ["requestId", "type", "runId"]);
  if (value.type === "retry" || value.type === "cancel") {
    return hasExactKeys(value, ["requestId", "type", "runId"], ["target"])
      && (value.target === undefined || typeof value.target === "string" && value.target.length > 0);
  }
  if (value.type === "steer") {
    return hasExactKeys(value, ["requestId", "type", "runId", "target", "instruction"])
      && value.requestId.length > 0
      && typeof value.target === "string"
      && value.target.trim().length > 0
      && typeof value.instruction === "string"
      && value.instruction.trim().length > 0;
  }
  if (value.type === "signal") {
    return hasExactKeys(value, ["requestId", "type", "runId", "nodeId", "payload"])
      && typeof value.nodeId === "string"
      && isJsonValue(value.payload);
  }
  if (value.type !== "fork"
    || !hasExactKeys(value, ["requestId", "type", "runId"], ["target", "prepared", "input", "agentOverrides"])) return false;
  return (value.target === undefined || typeof value.target === "string" && value.target.length > 0)
    && (value.prepared === undefined || isPreparedRunWorkflow(value.prepared))
    && (value.input === undefined || isJsonValue(value.input))
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides));
}

function isAdmitRunRequest(value: Record<string, unknown>): value is DaemonAdmitRunRequest {
  return value.method === "admitRun"
    && hasExactKeys(value, ["method", "prepared", "input"], ["agentOverrides"])
    && isPreparedRunWorkflow(value.prepared)
    && hasOwn(value, "input")
    && isJsonValue(value.input)
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}
