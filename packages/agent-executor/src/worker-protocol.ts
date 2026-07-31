import type {
  AgentPermissionMode,
  AgentSelector,
  AgentTurnObservation,
  AgentTurnRequest,
  AgentTurnResult,
} from "./types.js";

export const ACP_WORKER_PROTOCOL_VERSION = 2;

export type AcpWorkerParentMessage =
  | {
      type: "initialize";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      sessionStateDirectory: string;
      cwd: string;
      env: Record<string, string | undefined>;
      agent: AgentSelector;
      permissionMode: AgentPermissionMode;
      model?: string;
    }
  | {
      type: "run-turn";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      turnId: string;
      request: Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation">;
    }
  | {
      type: "abort-turn";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      turnId: string;
      reason: "aborted" | "timeout" | "inactivity";
    }
  | {
      type: "close-attempt";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      reason: string;
    };

export type AcpWorkerChildMessage =
  | {
      type: "ready";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
    }
  | {
      type: "acp-activity";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      turnId: string;
      observedAt: string;
    }
  | {
      type: "turn-observation";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      turnId: string;
      observation: AgentTurnObservation;
    }
  | {
      type: "turn-result";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      turnId: string;
      result: AgentTurnResult;
    }
  | {
      type: "worker-failure";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
      message: string;
    }
  | {
      type: "closed";
      protocolVersion: 2;
      workerId: string;
      attemptId: string;
    };

export function isAcpWorkerChildMessage(value: unknown): value is AcpWorkerChildMessage {
  if (!record(value)
    || value.protocolVersion !== ACP_WORKER_PROTOCOL_VERSION
    || typeof value.workerId !== "string"
    || typeof value.attemptId !== "string") return false;
  if (value.type === "ready" || value.type === "closed") return true;
  if (value.type === "worker-failure") return typeof value.message === "string";
  if (value.type === "acp-activity") {
    return typeof value.turnId === "string" && typeof value.observedAt === "string";
  }
  if (value.type === "turn-observation") {
    return typeof value.turnId === "string" && isTurnObservation(value.observation);
  }
  return value.type === "turn-result"
    && typeof value.turnId === "string"
    && isTurnResult(value.result);
}

function isTurnObservation(value: unknown): value is AgentTurnObservation {
  if (!record(value) || !record(value.event) || !record(value.progress)) return false;
  return stringArray(value.progress.responses)
    && isTurnSummary(value.progress.summary)
    && typeof value.progress.updatedAt === "string";
}

function isTurnResult(value: unknown): value is AgentTurnResult {
  if (!record(value)
    || "responseText" in value
    || !stringArray(value.responses)
    || typeof value.stderr !== "string"
    || !isTurnSummary(value.summary)
    || !isTurnTiming(value.timing)) return false;
  if (value.status === "completed") {
    return typeof value.finalResponse === "string" && !("failure" in value) && !("message" in value);
  }
  if (value.status === "failed") {
    return !("finalResponse" in value) && !("message" in value) && isFailure(value.failure);
  }
  return value.status === "cancelled"
    && !("finalResponse" in value)
    && !("failure" in value)
    && typeof value.message === "string";
}

function isTurnSummary(value: unknown): boolean {
  if (!record(value) || !record(value.availability) || !record(value.tools)) return false;
  return nonnegativeInteger(value.eventCount)
    && (value.availability.context === "available" || value.availability.context === "unavailable")
    && (value.availability.tokenUsage === "available"
      || value.availability.tokenUsage === "partial"
      || value.availability.tokenUsage === "unavailable")
    && nonnegativeInteger(value.tools.totalToolCallCount)
    && Array.isArray(value.tools.calls)
    && value.tools.calls.every(record);
}

function isTurnTiming(value: unknown): boolean {
  return record(value)
    && typeof value.startedAt === "string"
    && typeof value.finishedAt === "string"
    && typeof value.elapsedMs === "number"
    && Number.isFinite(value.elapsedMs)
    && value.elapsedMs >= 0;
}

function isFailure(value: unknown): boolean {
  return record(value)
    && (value.kind === "config"
      || value.kind === "spawn"
      || value.kind === "provider_exit"
      || value.kind === "timeout"
      || value.kind === "worker_lost"
      || value.kind === "inactivity_stale")
    && typeof value.message === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
