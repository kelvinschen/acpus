import type {
  AgentPermissionMode,
  AgentSelector,
  AgentTurnObservation,
  AgentTurnRequest,
  AgentTurnResult,
} from "./types.js";
import type { AcpxAgentLaunch } from "./acpx-agent-resolution.js";

export const ACP_WORKER_PROTOCOL_VERSION = 4;

export type AcpWorkerParentMessage =
  | {
      type: "initialize";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      sessionStateDirectory: string;
      cwd: string;
      env: Record<string, string | undefined>;
      agent: AgentSelector;
      resolvedLaunch: AcpxAgentLaunch;
      permissionMode: AgentPermissionMode;
      model?: string;
    }
  | {
      type: "run-turn";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      turnId: string;
      request: Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation">;
    }
  | {
      type: "abort-turn";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      turnId: string;
      reason: "aborted" | "timeout" | "inactivity";
    }
  | {
      type: "close-attempt";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      reason: string;
    };

export type AcpWorkerChildMessage =
  | {
      type: "ready";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
    }
  | {
      type: "acp-activity";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      turnId: string;
      observedAt: string;
    }
  | {
      type: "turn-observation";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      turnId: string;
      observation: AgentTurnObservation;
    }
  | {
      type: "turn-result";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      turnId: string;
      result: AgentTurnResult;
    }
  | {
      type: "worker-failure";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
      message: string;
    }
  | {
      type: "closed";
      protocolVersion: 4;
      workerId: string;
      attemptId: string;
    };

export function isAcpWorkerParentMessage(value: unknown): value is AcpWorkerParentMessage {
  if (!record(value)
    || value.protocolVersion !== ACP_WORKER_PROTOCOL_VERSION
    || typeof value.workerId !== "string"
    || typeof value.attemptId !== "string") return false;
  if (value.type === "initialize") {
    return exactKeys(value, [
      "type", "protocolVersion", "workerId", "attemptId", "sessionStateDirectory",
      "cwd", "env", "agent", "resolvedLaunch", "permissionMode",
    ], ["model"])
      && typeof value.sessionStateDirectory === "string"
      && typeof value.cwd === "string"
      && environment(value.env)
      && isAgentSelector(value.agent)
      && agentLaunch(value.resolvedLaunch)
      && isPermissionMode(value.permissionMode)
      && optionalString(value.model);
  }
  if (value.type === "run-turn") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "turnId", "request"])
      && typeof value.turnId === "string"
      && isTurnRequest(value.request);
  }
  if (value.type === "abort-turn") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "turnId", "reason"])
      && typeof value.turnId === "string"
      && (value.reason === "aborted" || value.reason === "timeout" || value.reason === "inactivity");
  }
  return value.type === "close-attempt"
    && exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "reason"])
    && typeof value.reason === "string";
}

export function isAcpWorkerChildMessage(value: unknown): value is AcpWorkerChildMessage {
  if (!record(value)
    || value.protocolVersion !== ACP_WORKER_PROTOCOL_VERSION
    || typeof value.workerId !== "string"
    || typeof value.attemptId !== "string") return false;
  if (value.type === "ready" || value.type === "closed") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId"]);
  }
  if (value.type === "worker-failure") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "message"])
      && typeof value.message === "string";
  }
  if (value.type === "acp-activity") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "turnId", "observedAt"])
      && typeof value.turnId === "string"
      && typeof value.observedAt === "string";
  }
  if (value.type === "turn-observation") {
    return exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "turnId", "observation"])
      && typeof value.turnId === "string"
      && isTurnObservation(value.observation);
  }
  return value.type === "turn-result"
    && exactKeys(value, ["type", "protocolVersion", "workerId", "attemptId", "turnId", "result"])
    && typeof value.turnId === "string"
    && isTurnResult(value.result);
}

function isTurnRequest(value: unknown): value is Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation"> {
  return record(value)
    && exactKeys(value, ["agent", "prompt", "cwd", "env", "sessionName", "permissionMode"], ["model", "config", "timeoutMs"])
    && isAgentSelector(value.agent)
    && typeof value.prompt === "string"
    && typeof value.cwd === "string"
    && environment(value.env)
    && typeof value.sessionName === "string"
    && isPermissionMode(value.permissionMode)
    && optionalString(value.model)
    && (value.config === undefined || stringRecord(value.config))
    && (value.timeoutMs === undefined || finiteNumber(value.timeoutMs));
}

function isTurnObservation(value: unknown): value is AgentTurnObservation {
  return record(value)
    && exactKeys(value, ["event", "progress"])
    && isObservationEvent(value.event)
    && isTurnProgress(value.progress);
}

function isObservationEvent(value: unknown): boolean {
  if (!record(value)
    || value.schemaVersion !== 1
    || !finiteNumber(value.sequence)
    || typeof value.observedAt !== "string"
    || !finiteNumber(value.elapsedMs)) return false;
  const base = ["schemaVersion", "sequence", "observedAt", "elapsedMs", "type"];
  if (value.type === "message") {
    return exactKeys(value, [...base, "channel", "content"], ["tag"])
      && (value.channel === "assistant" || value.channel === "thought")
      && isAgentJsonValue(value.content)
      && optionalString(value.tag);
  }
  if (value.type === "tool") {
    return exactKeys(value, [...base, "action"], [
      "toolCallId", "title", "kind", "toolName", "status",
      "rawInput", "rawOutput", "content", "locations",
    ])
      && (value.action === "call" || value.action === "update")
      && optionalString(value.toolCallId)
      && optionalString(value.title)
      && optionalString(value.kind)
      && optionalString(value.toolName)
      && optionalString(value.status)
      && optionalAgentJsonValue(value.rawInput)
      && optionalAgentJsonValue(value.rawOutput)
      && optionalAgentJsonValue(value.content)
      && optionalAgentJsonValue(value.locations);
  }
  if (value.type === "usage") {
    return exactKeys(value, base, ["context", "tokenUsage"])
      && optionalAgentJsonValue(value.context)
      && optionalAgentJsonValue(value.tokenUsage);
  }
  if (value.type === "plan") {
    return exactKeys(value, [...base, "value"])
      && isAgentJsonValue(value.value);
  }
  if (value.type === "unknown") {
    return exactKeys(value, [...base, "value"], ["tag"])
      && optionalString(value.tag)
      && isAgentJsonValue(value.value);
  }
  if (value.type === "turn_end") {
    return exactKeys(value, [...base, "status"], ["stopReason", "failure", "message"])
      && (value.status === "completed" || value.status === "failed" || value.status === "cancelled" || value.status === "timed_out")
      && optionalString(value.stopReason)
      && optionalAgentJsonValue(value.failure)
      && optionalString(value.message);
  }
  return false;
}

function isTurnProgress(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["responses", "summary", "updatedAt"])
    && stringArray(value.responses)
    && isTurnSummary(value.summary)
    && typeof value.updatedAt === "string";
}

function isTurnResult(value: unknown): value is AgentTurnResult {
  if (!record(value)
    || !stringArray(value.responses)
    || typeof value.stderr !== "string"
    || !isTurnSummary(value.summary)
    || !isTurnTiming(value.timing)) return false;
  if (value.status === "completed") {
    return exactKeys(value, ["status", "responses", "stderr", "summary", "timing", "finalResponse"])
      && typeof value.finalResponse === "string";
  }
  if (value.status === "failed") {
    return exactKeys(value, ["status", "responses", "stderr", "summary", "timing", "failure"])
      && isFailure(value.failure);
  }
  return value.status === "cancelled"
    && exactKeys(value, ["status", "responses", "stderr", "summary", "timing", "message"])
    && typeof value.message === "string";
}

function isTurnSummary(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["eventCount", "availability", "tools"], ["stopReason", "context", "tokenUsage", "cwd", "acpxRecordId"])
    && nonnegativeInteger(value.eventCount)
    && isTelemetryAvailability(value.availability)
    && optionalString(value.stopReason)
    && (value.context === undefined || isContextSummary(value.context))
    && (value.tokenUsage === undefined || isTokenUsageSummary(value.tokenUsage))
    && isToolsSummary(value.tools)
    && optionalString(value.cwd)
    && optionalString(value.acpxRecordId);
}

function isTelemetryAvailability(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["context", "tokenUsage"])
    && (value.context === "available" || value.context === "unavailable")
    && (value.tokenUsage === "available" || value.tokenUsage === "partial" || value.tokenUsage === "unavailable");
}

function isContextSummary(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["used", "size", "updatedAt"])
    && finiteNumber(value.used)
    && finiteNumber(value.size)
    && typeof value.updatedAt === "string";
}

function isTokenUsageSummary(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["source"], [
      "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens",
    ])
    && (value.source === "prompt_response" || value.source === "usage_update")
    && optionalFiniteNumber(value.inputTokens)
    && optionalFiniteNumber(value.outputTokens)
    && optionalFiniteNumber(value.cachedReadTokens)
    && optionalFiniteNumber(value.cachedWriteTokens)
    && optionalFiniteNumber(value.thoughtTokens)
    && optionalFiniteNumber(value.totalTokens);
}

function isToolsSummary(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["totalToolCallCount", "calls"])
    && nonnegativeInteger(value.totalToolCallCount)
    && Array.isArray(value.calls)
    && value.calls.every(isToolCallSummary);
}

function isToolCallSummary(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["toolCallId", "startedAt", "updatedAt"], [
      "title", "kind", "toolName", "status", "input", "completedAt",
    ])
    && typeof value.toolCallId === "string"
    && optionalString(value.title)
    && optionalString(value.kind)
    && optionalString(value.toolName)
    && optionalString(value.status)
    && (value.input === undefined || isToolInputPreview(value.input))
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string"
    && optionalString(value.completedAt);
}

function isToolInputPreview(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["preview", "truncated", "originalBytes", "headBytes"], ["tailBytes"])
    && typeof value.preview === "string"
    && typeof value.truncated === "boolean"
    && finiteNumber(value.originalBytes)
    && finiteNumber(value.headBytes)
    && optionalFiniteNumber(value.tailBytes);
}

function isTurnTiming(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["startedAt", "finishedAt", "elapsedMs"])
    && typeof value.startedAt === "string"
    && typeof value.finishedAt === "string"
    && nonnegativeFiniteNumber(value.elapsedMs);
}

function isFailure(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["kind", "message"], ["origin", "retryable", "evidence", "upstream"])
    && (value.kind === "config"
      || value.kind === "spawn"
      || value.kind === "provider_exit"
      || value.kind === "timeout"
      || value.kind === "worker_lost"
      || value.kind === "inactivity_stale")
    && (value.origin === undefined || value.origin === "provider" || value.origin === "runtime")
    && (value.retryable === undefined || typeof value.retryable === "boolean")
    && typeof value.message === "string"
    && (value.evidence === undefined || isFailureEvidence(value.evidence))
    && (value.upstream === undefined || isFailureUpstream(value.upstream));
}

function isFailureEvidence(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["failAfterMs", "silentForMs", "silenceStartedAt"])
    && finiteNumber(value.failAfterMs)
    && finiteNumber(value.silentForMs)
    && typeof value.silenceStartedAt === "string";
}

function isFailureUpstream(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["source", "operation"], ["code", "origin"])
    && value.source === "acpx"
    && (value.operation === "sessions.ensure" || value.operation === "session.set_config_option" || value.operation === "prompt")
    && optionalString(value.code)
    && optionalString(value.origin);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function agentLaunch(value: unknown): value is AcpxAgentLaunch {
  return typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value)
      && value.length > 0
      && typeof value[0] === "string"
      && value[0].length > 0
      && value.every(item => typeof item === "string");
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value);
}

function environment(value: unknown): value is Record<string, string | undefined> {
  return record(value) && Object.values(value).every(item => item === undefined || typeof item === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every(item => typeof item === "string");
}

function isAgentSelector(value: unknown): value is AgentSelector {
  if (!record(value)) return false;
  if (value.kind === "named") {
    return exactKeys(value, ["kind", "name"])
      && typeof value.name === "string";
  }
  return value.kind === "command"
    && exactKeys(value, ["kind", "command"])
    && typeof value.command === "string";
}

function isPermissionMode(value: unknown): value is AgentPermissionMode {
  return value === "approve-reads" || value === "approve-all" || value === "deny-all";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalAgentJsonValue(value: unknown): boolean {
  return value === undefined || isAgentJsonValue(value);
}

function isAgentJsonValue(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isAgentJsonValue(item, ancestors))
    : plainRecord(value) && Object.values(value).every(item => isAgentJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function plainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return !Array.isArray(value) && (prototype === Object.prototype || prototype === null);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
