import { describe, expect, it } from "vitest";
import { ACP_WORKER_PROTOCOL_VERSION, isAcpWorkerChildMessage } from "../src/worker-protocol.js";

describe("ACP worker protocol", () => {
  it("accepts only the response-segment protocol version", () => {
    expect(ACP_WORKER_PROTOCOL_VERSION).toBe(2);
    expect(isAcpWorkerChildMessage({
      type: "ready",
      protocolVersion: 2,
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
      protocolVersion: 2,
      workerId: "worker",
      attemptId: "attempt",
      turnId: "turn",
    })).toBe(false);
  });
});

function turnResult(result: unknown) {
  return {
    type: "turn-result",
    protocolVersion: 2,
    workerId: "worker",
    attemptId: "attempt",
    turnId: "turn",
    result,
  };
}
