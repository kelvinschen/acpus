import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { isPreparedRunWorkflow, type PreparedRunWorkflow } from "../admission/prepared-workflow.js";
import type { AgentOverrideMap } from "../control/agent-overrides.js";
import type { InspectionObservation } from "../inspection/types.js";
import { RUNTIME_LAYOUT_VERSION } from "../runtime-layout.js";
import { RUNTIME_STORAGE_VERSION } from "../storage/database.js";
import type { RunDetails } from "../store/store.js";

export const DAEMON_PROTOCOL_VERSION = 4;
export const RUNTIME_ABI_VERSION = 1;

export type RuntimeAuthorityIdentity = {
  workspaceKey: string;
  runtimeAbi: typeof RUNTIME_ABI_VERSION;
  layoutVersion: typeof RUNTIME_LAYOUT_VERSION;
  storageVersion: typeof RUNTIME_STORAGE_VERSION;
  authorityId: string;
  storeBinding: `sha256:${string}`;
  leaseGeneration: number;
};

export type DaemonStatus = {
  status: "ok";
  pid: number;
  leaseGeneration: number;
  protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  packageVersion: string;
  authority: RuntimeAuthorityIdentity;
};

export type DaemonPredecessorStatus = {
  status: "ok";
  pid: number;
  generation: number;
  protocolVersion: 3;
  packageVersion: string;
};

export type DaemonStatusProbe =
  | { kind: "current"; status: DaemonStatus }
  | { kind: "predecessor"; status: DaemonPredecessorStatus }
  | { kind: "unknown"; protocolVersion?: number };

export type DaemonRunObservationUntil = "admitted" | "subject-terminal" | "decision-boundary";

export type DaemonSubmitAndObserveInput = {
  expectedAuthority: RuntimeAuthorityIdentity;
  requestId: string;
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
  until: DaemonRunObservationUntil;
};

type DaemonSubmitAndObserveRequest = {
  method: "submitAndObserve";
} & DaemonSubmitAndObserveInput;

export type DaemonRunStreamFrame =
  | { kind: "admitted"; authority: RuntimeAuthorityIdentity; run: RunDetails }
  | { kind: "observation"; observation: InspectionObservation }
  | {
    kind: "error";
    phase: "authority" | "admission" | "observation";
    outcome: "not-admitted" | "admitted" | "unknown";
    runId?: string;
    error: { code: DaemonErrorCode; message: string };
  };

export type DaemonRequest = {
  method: "status";
} | {
  method: "shutdown";
} | {
  method: "control";
  control: DaemonControlIntent;
} | DaemonSubmitAndObserveRequest;

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
  | { ok: true; result: DaemonStatus | DaemonShutdownResult | DaemonControlResult }
  | { ok: false; error: { code: DaemonErrorCode; message: string; ambiguity?: true } };

const DAEMON_ERROR_CODES = ["INVALID_REQUEST", "AUTHORITY_MISMATCH", "RUN_NOT_FOUND", "RUN_NOT_CONTROLLABLE", "CONTROL_CONFLICT", "EXECUTION_UNAVAILABLE", "STORE_BUSY", "STORE_ERROR", "INTERNAL_ERROR"] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export type DaemonShutdownResult = {
  status: "shutdown";
};

export type DaemonHandlerFailure = { code: DaemonErrorCode; message: string; ambiguity?: true };

export type DaemonClientFailure =
  | { type: "rejected"; code: DaemonErrorCode; message: string; ambiguity?: true }
  | { type: "transport"; reason: "not-found" | "refused" | "timeout" | "io"; method: DaemonRequest["method"]; errno?: string; message: string }
  | { type: "protocol"; stage: "envelope" | "result"; method: DaemonRequest["method"]; message: string };

export type DaemonRunStreamClientFailure =
  | {
    type: "transport";
    reason: "not-found" | "refused" | "io";
    method: "submitAndObserve";
    outcome: "not-admitted" | "admitted" | "unknown";
    runId?: string;
    errno?: string;
    message: string;
  }
  | {
    type: "protocol";
    stage: "frame" | "stream";
    reason: "malformed" | "unexpected" | "truncated";
    method: "submitAndObserve";
    outcome: "not-admitted" | "admitted" | "unknown";
    runId?: string;
    message: string;
  };

export function parseDaemonRequest(raw: string):
  | { ok: true; value: DaemonRequest }
  | { ok: false; response: DaemonResponse; stream: boolean } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isPlainRecord(value) || typeof value.method !== "string") {
      return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request."), stream: false };
    }
    if (value.method === "status" || value.method === "shutdown") {
      return hasExactKeys(value, ["method"])
        ? { ok: true, value: { method: value.method } }
        : { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request."), stream: false };
    }
    if (value.method === "submitAndObserve") {
      if (!isSubmitAndObserveRequest(value)) {
        return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon submission request."), stream: true };
      }
      return { ok: true, value };
    }
    if (value.method !== "control" || !hasExactKeys(value, ["method", "control"]) || !isControlIntent(value.control)) {
      return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Unsupported daemon method."), stream: false };
    }
    return { ok: true, value: { method: "control", control: value.control } };
  } catch {
    return { ok: false, response: failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request JSON."), stream: false };
  }
}

export function appliedDaemonResponse(result: Extract<DaemonResponse, { ok: true }>["result"]): DaemonResponse {
  return { ok: true, result };
}

export function failedDaemonResponse(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonResponse {
  return { ok: false, error: { code, message, ...(ambiguity ? { ambiguity } : {}) } };
}

export function describeDaemonRequest(request: DaemonRequest): string {
  if (request.method === "submitAndObserve") return "run submission";
  if (request.method === "control") return `${request.control.type} control for run '${request.control.runId}'`;
  return request.method;
}

export function daemonFailureMessage(request: DaemonRequest, code: DaemonErrorCode): string {
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  if (request.method === "status") return "Daemon status is unavailable.";
  if (request.method === "submitAndObserve") return "Run submission failed.";
  if (request.method === "control") return `Control '${request.control.type}' could not be applied to run '${request.control.runId}'.`;
  return "Daemon shutdown failed.";
}

export function isDaemonStatus(value: unknown): value is DaemonStatus {
  return isPlainRecord(value)
    && hasExactKeys(value, ["status", "pid", "leaseGeneration", "protocolVersion", "packageVersion", "authority"])
    && value.status === "ok"
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && Number.isInteger(value.leaseGeneration) && Number(value.leaseGeneration) > 0
    && value.protocolVersion === DAEMON_PROTOCOL_VERSION
    && typeof value.packageVersion === "string"
    && isRuntimeAuthorityIdentity(value.authority)
    && value.leaseGeneration === value.authority.leaseGeneration;
}

function isDaemonPredecessorStatus(value: unknown): value is DaemonPredecessorStatus {
  return isPlainRecord(value)
    && hasExactKeys(value, ["status", "pid", "generation", "protocolVersion", "packageVersion"])
    && value.status === "ok"
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && Number.isInteger(value.generation) && Number(value.generation) > 0
    && value.protocolVersion === 3
    && typeof value.packageVersion === "string";
}

export function classifyDaemonStatus(value: unknown): DaemonStatusProbe {
  if (isDaemonStatus(value)) return { kind: "current", status: value };
  if (isDaemonPredecessorStatus(value)) return { kind: "predecessor", status: value };
  if (isPlainRecord(value) && Number.isInteger(value.protocolVersion) && Number(value.protocolVersion) > 0) {
    return { kind: "unknown", protocolVersion: Number(value.protocolVersion) };
  }
  return { kind: "unknown" };
}

function isRuntimeAuthorityIdentity(value: unknown): value is RuntimeAuthorityIdentity {
  return isRuntimeAuthorityWireIdentity(value)
    && value.runtimeAbi === RUNTIME_ABI_VERSION
    && value.layoutVersion === RUNTIME_LAYOUT_VERSION
    && value.storageVersion === RUNTIME_STORAGE_VERSION;
}

export function isDaemonRunStreamFrame(value: unknown): value is DaemonRunStreamFrame {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "admitted") {
    return hasExactKeys(value, ["kind", "authority", "run"])
      && isRuntimeAuthorityIdentity(value.authority)
      && isRunDetails(value.run);
  }
  if (value.kind === "observation") {
    return hasExactKeys(value, ["kind", "observation"])
      && isInspectionObservation(value.observation);
  }
  if (value.kind !== "error"
    || !hasExactKeys(value, ["kind", "phase", "outcome", "error"], ["runId"])
    || !["authority", "admission", "observation"].includes(String(value.phase))
    || !["not-admitted", "admitted", "unknown"].includes(String(value.outcome))
    || (value.runId !== undefined && typeof value.runId !== "string")
    || !isPlainRecord(value.error)) return false;
  return hasExactKeys(value.error, ["code", "message"])
    && DAEMON_ERROR_CODES.includes(value.error.code as DaemonErrorCode)
    && typeof value.error.message === "string";
}

export function isDaemonShutdownResult(value: unknown): value is DaemonShutdownResult {
  return isPlainRecord(value) && hasExactKeys(value, ["status"]) && value.status === "shutdown";
}

function isRunDetails(value: unknown): value is RunDetails {
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

function isSubmitAndObserveRequest(value: Record<string, unknown>): value is DaemonSubmitAndObserveRequest {
  return value.method === "submitAndObserve"
    && hasExactKeys(
      value,
      ["method", "expectedAuthority", "requestId", "prepared", "input", "until"],
      ["agentOverrides"],
    )
    && isRuntimeAuthorityWireIdentity(value.expectedAuthority)
    && typeof value.requestId === "string" && value.requestId.length > 0
    && isPreparedRunWorkflow(value.prepared)
    && hasOwn(value, "input")
    && isJsonValue(value.input)
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides))
    && (value.until === "admitted" || value.until === "subject-terminal" || value.until === "decision-boundary");
}

function isRuntimeAuthorityWireIdentity(value: unknown): value is RuntimeAuthorityIdentity {
  return isPlainRecord(value)
    && hasExactKeys(value, ["workspaceKey", "runtimeAbi", "layoutVersion", "storageVersion", "authorityId", "storeBinding", "leaseGeneration"])
    && typeof value.workspaceKey === "string" && /^[a-f0-9]{32}$/.test(value.workspaceKey)
    && Number.isInteger(value.runtimeAbi) && Number(value.runtimeAbi) > 0
    && Number.isInteger(value.layoutVersion) && Number(value.layoutVersion) > 0
    && Number.isInteger(value.storageVersion) && Number(value.storageVersion) > 0
    && typeof value.authorityId === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.authorityId)
    && typeof value.storeBinding === "string" && /^sha256:[a-f0-9]{64}$/.test(value.storeBinding)
    && Number.isInteger(value.leaseGeneration) && Number(value.leaseGeneration) > 0;
}

function isInspectionObservation(value: unknown): value is InspectionObservation {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "attached") {
    return hasExactKeys(value, ["kind", "view"])
      && isObservableInspectionView(value.view);
  }
  if (value.kind === "update") {
    return hasExactKeys(value, ["kind", "changes"], ["timeline"])
      && Array.isArray(value.changes)
      && value.changes.every(isInspectionChange)
      && (value.timeline === undefined || Array.isArray(value.timeline) && value.timeline.every(isTimelineEntry));
  }
  return value.kind === "closed"
    && hasExactKeys(value, ["kind", "reason", "view"])
    && (value.reason === "subject-terminal" || value.reason === "awaiting-input" || value.reason === "paused")
    && isObservableInspectionView(value.view);
}

function isObservableInspectionView(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "run") {
    return hasExactKeys(value, ["kind", "run", "counts", "tree"], ["output"])
      && isInspectionRun(value.run)
      && isInspectionCounts(value.counts)
      && Array.isArray(value.tree)
      && value.tree.every(entry => isInspectionTreeEntry(entry))
      && (value.output === undefined || isJsonValue(value.output));
  }
  if (value.kind !== "target" || typeof value.detail !== "string") return false;
  if (value.detail === "summary") {
    return hasExactKeys(
      value,
      ["kind", "detail", "run", "subject", "state"],
      ["pulse", "acp", "attention", "visibility", "occurrences"],
    )
      && isInspectionRunRef(value.run)
      && isInspectionSubject(value.subject)
      && isInspectionVisibleState(value.state)
      && (value.pulse === undefined || isInspectionPulse(value.pulse))
      && (value.acp === undefined || isAcpSilence(value.acp))
      && (value.attention === undefined || isInspectionAttention(value.attention))
      && (value.visibility === undefined || isInspectionVisibility(value.visibility))
      && (value.occurrences === undefined || isInspectionCounts(value.occurrences));
  }
  return value.detail === "timeline"
    && hasExactKeys(
      value,
      ["kind", "detail", "run", "subject", "state", "recent"],
      ["visibility", "current"],
    )
    && isInspectionRunRef(value.run)
    && isInspectionSubject(value.subject)
    && isInspectionVisibleState(value.state)
    && (value.visibility === undefined || isInspectionVisibility(value.visibility))
    && (value.current === undefined || isInspectionActivity(value.current))
    && Array.isArray(value.recent)
    && value.recent.every(isTimelineEntry);
}

function isInspectionRun(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["id", "name", "status"], ["durationMs", "liveness", "failure", "fork"])
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || !isRunStatus(value.status)
    || (value.durationMs !== undefined && !isNonNegativeNumber(value.durationMs))
    || (value.liveness !== undefined && !isStringEnum(value.liveness, ["active", "inactive", "stale", "terminal", "unknown"]))
    || (value.failure !== undefined && !isInspectionFailure(value.failure))) return false;
  return value.fork === undefined
    || isPlainRecord(value.fork)
      && hasExactKeys(value.fork, ["sourceRunId"])
      && typeof value.fork.sourceRunId === "string";
}

function isInspectionRunRef(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["id", "status"])
    && typeof value.id === "string"
    && isRunStatus(value.status);
}

function isInspectionSubject(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["label", "kind"], ["selector"])
    && typeof value.label === "string"
    && typeof value.kind === "string"
    && (value.selector === undefined || typeof value.selector === "string");
}

function isInspectionCounts(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(
      value,
      ["total"],
      ["notStarted", "notSelected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timedOut", "cancelled", "mixed"],
    )
    || !isNonNegativeInteger(value.total)) return false;
  return Object.entries(value).every(([key, count]) => key === "total" || isNonNegativeInteger(count));
}

function isInspectionVisibleState(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["status"], ["durationMs", "failure"])
    && isInspectionStatus(value.status)
    && (value.durationMs === undefined || isNonNegativeNumber(value.durationMs))
    && (value.failure === undefined || isInspectionFailure(value.failure));
}

function isInspectionFailure(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["origin", "message"], ["code"])
    && isStringEnum(value.origin, ["provider", "runtime", "scheduler", "task", "signal", "unknown"])
    && typeof value.message === "string"
    && (value.code === undefined || typeof value.code === "string");
}

function isInspectionProgress(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["completed", "total"])
    && isNonNegativeInteger(value.completed)
    && isNonNegativeInteger(value.total);
}

function isInspectionPulse(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["phase"], ["turn", "headline"])
    && isAgentInspectionPhase(value.phase)
    && (value.turn === undefined || isNonNegativeInteger(value.turn))
    && (value.headline === undefined || typeof value.headline === "string");
}

function isInspectionAttention(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "failure" || value.kind === "timed-out") {
    return hasExactKeys(value, ["kind", "summary"])
      && typeof value.summary === "string";
  }
  return value.kind === "awaiting-input"
    && hasExactKeys(value, ["kind", "summary", "signal"], ["prompt", "expected"])
    && typeof value.summary === "string"
    && typeof value.signal === "string"
    && (value.prompt === undefined || typeof value.prompt === "string")
    && (value.expected === undefined || typeof value.expected === "string");
}

function isInspectionVisibility(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["state", "reason"])
    && value.state === "degraded"
    && isVisibilityReason(value.reason);
}

function isInspectionActivity(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "agent") {
    return hasExactKeys(value, ["kind", "phase"], ["turn", "headline"])
      && isAgentInspectionPhase(value.phase)
      && (value.turn === undefined || isNonNegativeInteger(value.turn))
      && (value.headline === undefined || typeof value.headline === "string");
  }
  if (value.kind === "task" || value.kind === "composite") {
    return hasExactKeys(value, ["kind", "phase"], ["headline"])
      && isStringEnum(value.phase, ["starting", "running", "settling"])
      && (value.headline === undefined || typeof value.headline === "string");
  }
  return value.kind === "signal"
    && hasExactKeys(value, ["kind", "phase", "signal"], ["prompt", "expected"])
    && value.phase === "awaiting"
    && typeof value.signal === "string"
    && (value.prompt === undefined || typeof value.prompt === "string")
    && (value.expected === undefined || typeof value.expected === "string");
}

function isTimelineEntry(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string" || typeof value.at !== "string") return false;
  if (value.kind === "transition") {
    return hasExactKeys(value, ["kind", "at", "action"], ["status", "attempt", "summary"])
      && isStringEnum(value.action, ["started", "awaiting", "completed", "failed", "timed-out", "cancelled", "retry", "steer", "resumed"])
      && (value.status === undefined || isInspectionStatus(value.status))
      && (value.attempt === undefined || isNonNegativeInteger(value.attempt))
      && (value.summary === undefined || typeof value.summary === "string");
  }
  if (value.kind === "activity") {
    return hasExactKeys(value, ["kind", "at", "channel", "summary"], ["attempt", "turn"])
      && isStringEnum(value.channel, ["response", "reported-thought", "plan", "tool"])
      && typeof value.summary === "string"
      && (value.attempt === undefined || isNonNegativeInteger(value.attempt))
      && (value.turn === undefined || isNonNegativeInteger(value.turn));
  }
  if (value.kind === "control") {
    return hasExactKeys(value, ["kind", "at", "action"], ["attempt"])
      && isStringEnum(value.action, ["steered", "paused", "resumed", "retried", "cancelled"])
      && (value.attempt === undefined || isNonNegativeInteger(value.attempt));
  }
  if (value.kind === "phase") {
    return hasExactKeys(value, ["kind", "at", "phase"], ["attempt", "turn"])
      && isStringEnum(value.phase, ["starting", "responding", "reported-thought", "planning", "tool", "output-repair", "settling", "settled", "running"])
      && (value.attempt === undefined || isNonNegativeInteger(value.attempt))
      && (value.turn === undefined || isNonNegativeInteger(value.turn));
  }
  if (value.kind === "visibility") {
    return hasExactKeys(value, ["kind", "at", "state"], ["reason"])
      && isStringEnum(value.state, ["degraded", "restored"])
      && (value.reason === undefined || isVisibilityReason(value.reason));
  }
  return value.kind === "gap"
    && hasExactKeys(value, ["kind", "at", "dropped", "reason"])
    && isNonNegativeInteger(value.dropped)
    && typeof value.reason === "string";
}

function isInspectionTreeEntry(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "item") {
    return hasExactKeys(value, ["type", "subject", "state", "children"], ["progress", "pulse", "attention"])
      && isInspectionSubject(value.subject)
      && isInspectionVisibleState(value.state)
      && (value.progress === undefined || isInspectionProgress(value.progress))
      && (value.pulse === undefined || isInspectionPulse(value.pulse))
      && (value.attention === undefined || isInspectionAttention(value.attention))
      && Array.isArray(value.children)
      && value.children.every(entry => isInspectionTreeEntry(entry));
  }
  return value.type === "fold"
    && hasExactKeys(value, ["type", "scope", "range", "count", "state", "children"])
    && isStringEnum(value.scope, ["fanout-items", "loop-rounds"])
    && isPlainRecord(value.range)
    && hasExactKeys(value.range, ["start", "end"])
    && isNonNegativeInteger(value.range.start)
    && isNonNegativeInteger(value.range.end)
    && isNonNegativeInteger(value.count)
    && isInspectionVisibleState(value.state)
    && Array.isArray(value.children)
    && value.children.every(entry => isInspectionTreeEntry(entry));
}

function isInspectionChange(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["subject", "state"], ["progress", "occurrences", "attention", "visibility", "reason"])
    || !isInspectionSubject(value.subject)
    || !isInspectionVisibleState(value.state)) return false;
  return (value.progress === undefined || isInspectionProgress(value.progress))
    && (value.occurrences === undefined || isInspectionCounts(value.occurrences))
    && (value.attention === undefined || isInspectionAttention(value.attention))
    && (value.visibility === undefined || isInspectionVisibility(value.visibility))
    && (value.reason === undefined || isStringEnum(value.reason, ["retry", "steer", "resume", "operator-cancelled", "parent-cancelled", "branch-selected", "race-selected", "quorum-selected", "superseded"]));
}

function isAcpSilence(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["silentForMs"])
    && isNonNegativeNumber(value.silentForMs);
}

function isInspectionStatus(value: unknown): boolean {
  return isStringEnum(value, ["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "cancelled", "mixed"]);
}

function isAgentInspectionPhase(value: unknown): boolean {
  return isStringEnum(value, ["starting", "responding", "reported-thought", "planning", "tool", "output-repair", "settling", "settled"]);
}

function isVisibilityReason(value: unknown): boolean {
  return isStringEnum(value, ["observation-gap", "unrecognized-provider-activity"]);
}

function isStringEnum(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
