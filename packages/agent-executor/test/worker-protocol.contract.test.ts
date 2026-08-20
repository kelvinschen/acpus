import { describe, expect, it } from "vitest";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  isAcpWorkerParentMessage,
} from "../src/worker-protocol.js";

const identity = { protocolVersion: 10, hostId: "host", sessionLeaseId: "lease" } as const;

describe("ACP worker protocol v10", () => {
  it("accepts the closed parent topology", () => {
    expect(ACP_WORKER_PROTOCOL_VERSION).toBe(10);
    expect(isAcpWorkerParentMessage({
      type: "open",
      protocolVersion: 10,
      input: {
        hostId: "host",
        sessionLeaseId: "lease",
        runId: "run",
        attemptId: "attempt",
        agentSessionId: "session",
        sessionOpenMode: "new_or_empty",
        sessionStateDirectory: "/tmp/sessions",
        resolvedLaunch: { kind: "command", command: "agent --stdio" },
        cwd: "/tmp/workspace",
        env: {},
        permissionMode: "deny-all",
        configuration: { options: {} },
      },
    })).toBe(true);
    expect(isAcpWorkerParentMessage({ ...identity, type: "run", turnId: "turn", prompt: "work" })).toBe(true);
    expect(isAcpWorkerParentMessage({ ...identity, type: "cancel", turnId: "turn", reason: "steer" })).toBe(true);
    expect(isAcpWorkerParentMessage({ ...identity, type: "close", reason: "shutdown" })).toBe(true);
  });

  it("rejects predecessor and additive wire shapes", () => {
    expect(isAcpWorkerParentMessage({ ...identity, protocolVersion: 7, type: "run", turnId: "turn", prompt: "work" })).toBe(false);
    expect(isAcpWorkerParentMessage({ ...identity, type: "run-turn", turnId: "turn", prompt: "work" })).toBe(false);
    expect(isAcpWorkerParentMessage({ ...identity, type: "run", turnId: "turn", prompt: "work", attemptId: "attempt" })).toBe(false);
  });

  it("accepts child readiness and terminal identities and rejects old workerId identity", () => {
    expect(isAcpWorkerChildMessage({
      ...identity,
      type: "ready",
      projectionRef: "sessions/session.json",
      reportedVersion: "1.2.3",
    })).toBe(true);
    expect(isAcpWorkerChildMessage({
      ...identity,
      type: "ready",
      projectionRef: "sessions/session.json",
      reportedVersion: "x".repeat(257),
    })).toBe(false);
    expect(isAcpWorkerChildMessage({ ...identity, type: "closed" })).toBe(true);
    expect(isAcpWorkerChildMessage({ protocolVersion: 10, workerId: "worker", attemptId: "attempt", type: "closed" })).toBe(false);
  });

  it("accepts only fixed-order non-empty binding mismatch categories", () => {
    const error = {
      type: "session_binding",
      operation: "open_session",
      origin: "persistence",
      providerEvidence: "none",
      message: "Session binding mismatch.",
      retryable: false,
      categories: ["launch", "model"],
    };
    expect(isAcpWorkerChildMessage({ ...identity, type: "open_failed", error })).toBe(true);
    expect(isAcpWorkerChildMessage({
      ...identity,
      type: "open_failed",
      error: { ...error, categories: ["model", "launch"] },
    })).toBe(false);
    expect(isAcpWorkerChildMessage({
      ...identity,
      type: "open_failed",
      error: { ...error, categories: [] },
    })).toBe(false);
    for (const invalid of [
      { operation: "run_turn" },
      { origin: "provider" },
      { providerEvidence: "terminal_response" },
      { retryable: true },
    ]) {
      expect(isAcpWorkerChildMessage({
        ...identity,
        type: "open_failed",
        error: { ...error, ...invalid },
      })).toBe(false);
    }
  });
});
