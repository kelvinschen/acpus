import { describe, expect, it } from "vitest";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  isAcpWorkerParentMessage,
} from "../src/worker-protocol.js";

describe("ACP worker protocol", () => {
  it("accepts only the current protocol version", () => {
    expect(ACP_WORKER_PROTOCOL_VERSION).toBe(3);
    expect(isAcpWorkerChildMessage({
      type: "ready",
      protocolVersion: 3,
      workerId: "worker",
      attemptId: "attempt",
    })).toBe(true);
    expect(isAcpWorkerChildMessage({
      type: "ready",
      protocolVersion: 1,
      workerId: "worker",
      attemptId: "attempt",
    })).toBe(false);
  });

  it("requires the resolved command on worker initialization", () => {
    const initialize = {
      type: "initialize",
      protocolVersion: 3,
      workerId: "worker",
      attemptId: "attempt",
      sessionStateDirectory: "/tmp/sessions",
      cwd: "/tmp/workspace",
      env: { HOME: "/tmp/home" },
      agent: { kind: "named", name: "configured" },
      resolvedCommand: "configured-acp --stdio",
      permissionMode: "approve-all",
    };

    expect(isAcpWorkerParentMessage(initialize)).toBe(true);
    expect(isAcpWorkerParentMessage({ ...initialize, resolvedCommand: undefined })).toBe(false);
    expect(isAcpWorkerParentMessage({ ...initialize, resolvedCommand: "" })).toBe(false);
  });

  it("validates the discriminant-specific child payload", () => {
    const resultBase = {
      responses: ["intermediate", "final"],
      stderr: "",
      summary: {
        eventCount: 2,
        availability: { context: "unavailable", tokenUsage: "unavailable" },
        tools: { totalToolCallCount: 0, calls: [] },
      },
      timing: {
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:00:01.000Z",
        elapsedMs: 1_000,
      },
    };

    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "completed",
      finalResponse: "final",
    }))).toBe(true);
    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "failed",
      failure: { kind: "provider_exit", message: "failed" },
    }))).toBe(true);
    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "cancelled",
      message: "cancelled",
    }))).toBe(true);
    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "completed",
    }))).toBe(false);
    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "failed",
      finalResponse: "stale",
      failure: { kind: "provider_exit", message: "failed" },
    }))).toBe(false);
    expect(isAcpWorkerChildMessage(turnResult({
      ...resultBase,
      status: "completed",
      responseText: "legacy",
      finalResponse: "final",
    }))).toBe(false);
    expect(isAcpWorkerChildMessage({
      type: "turn-result",
      protocolVersion: 3,
      workerId: "worker",
      attemptId: "attempt",
      turnId: "turn",
    })).toBe(false);
  });
});

function turnResult(result: unknown) {
  return {
    type: "turn-result",
    protocolVersion: 3,
    workerId: "worker",
    attemptId: "attempt",
    turnId: "turn",
    result,
  };
}
