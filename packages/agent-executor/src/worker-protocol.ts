import type {
  AgentPermissionMode,
  AgentSelector,
  AgentTurnObservation,
  AgentTurnRequest,
  AgentTurnResult,
} from "./types.js";

export const ACP_WORKER_PROTOCOL_VERSION = 1;

export type AcpWorkerParentMessage =
  | {
      type: "initialize";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      sessionDirectory: string;
      cwd: string;
      env: Record<string, string | undefined>;
      agent: AgentSelector;
      permissionMode: AgentPermissionMode;
      model?: string;
    }
  | {
      type: "run-turn";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      turnId: string;
      request: Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation">;
    }
  | {
      type: "abort-turn";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      turnId: string;
      reason: "aborted" | "timeout" | "inactivity";
    }
  | {
      type: "close-attempt";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      reason: string;
    };

export type AcpWorkerChildMessage =
  | {
      type: "ready";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
    }
  | {
      type: "acp-activity";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      turnId: string;
      observedAt: string;
    }
  | {
      type: "turn-observation";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      turnId: string;
      observation: AgentTurnObservation;
    }
  | {
      type: "turn-result";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      turnId: string;
      result: AgentTurnResult;
    }
  | {
      type: "worker-failure";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
      message: string;
    }
  | {
      type: "closed";
      protocolVersion: 1;
      workerId: string;
      attemptId: string;
    };

export function isAcpWorkerChildMessage(value: unknown): value is AcpWorkerChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.protocolVersion === ACP_WORKER_PROTOCOL_VERSION
    && typeof message.workerId === "string"
    && typeof message.attemptId === "string"
    && typeof message.type === "string";
}
