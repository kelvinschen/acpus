import { describe, expect, it } from "vitest";
import {
  DAEMON_PROTOCOL_VERSION,
  isDaemonControlResult,
  isDaemonInspectionResult,
  isDaemonRunStreamFrame,
  parseDaemonRequest,
} from "../src/daemon/protocol.js";
import { RUNTIME_ABI_VERSION } from "../src/runtime-contracts.js";

describe("daemon M6 control protocol", () => {
  it("cuts over the authority and daemon wire versions", () => {
    expect(RUNTIME_ABI_VERSION).toBe(5);
    expect(DAEMON_PROTOCOL_VERSION).toBe(10);
  });

  it.each([
    { requestId: "retry-1", type: "retry", runId: "run_1", target: "@failed" },
    { requestId: "steer-1", type: "steer", runId: "run_1", target: "@active", instruction: "Focus on the failure." },
  ])("accepts the closed $type intent", control => {
    expect(parseDaemonRequest(JSON.stringify({ method: "control", control }))).toEqual({
      ok: true,
      value: { method: "control", control },
    });
  });

  it.each([
    { requestId: "", type: "continue", runId: "run_1", target: "@terminal" },
    { requestId: "continue-1", type: "continue", runId: "run_1", target: " " },
    { requestId: "restart-1", type: "restart", runId: "run_1", target: " " },
    { requestId: "steer-1", type: "steer", runId: "run_1", target: "@active", instruction: " " },
    { requestId: "retry-1", type: "retry", runId: "run_1" },
  ])("rejects an invalid or removed control shape", control => {
    expect(parseDaemonRequest(JSON.stringify({ method: "control", control }))).toMatchObject({
      ok: false,
      response: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
  });

  it("accepts only observable inspection requests and closed live-control results", () => {
    const request = {
      method: "inspect",
      view: { kind: "target", runId: "run_1", target: "@123456789abc", detail: "summary" },
    };
    expect(parseDaemonRequest(JSON.stringify(request))).toEqual({ ok: true, value: request });
    expect(parseDaemonRequest(JSON.stringify({
      ...request,
      view: { ...request.view, detail: "forensics" },
    }))).toMatchObject({ ok: false, response: { ok: false, error: { code: "INVALID_REQUEST" } } });

    const view = activeTargetInspection();
    expect(isDaemonInspectionResult(view)).toBe(true);
    expect(isDaemonInspectionResult({
      ...view,
      availableControls: [{ type: "steer", target: "attempt-1", delivery: "in_place", effect: "inject" }],
    })).toBe(false);
  });

  it("accepts the current Steer receipt", () => {
    expect(isDaemonControlResult({
      type: "steer",
      state: "applied",
      run: runDetails(),
      steerId: "steer-1",
      requestedTarget: "@active",
      target: "review~abc",
      delivery: "interrupt_continue",
      fencedAttemptId: "attempt-1",
      continuation: "queued",
    }, "steer")).toBe(true);
    expect(isDaemonControlResult({
      type: "steer",
      state: "applied",
      run: runDetails(),
      steerId: "steer-1",
      requestedTarget: "@active",
      target: "review~abc",
      fencedAttemptId: "attempt-1",
      continuation: "queued",
    }, "steer")).toBe(false);
  });

  it("accepts current Session and control projections on observation frames", () => {
    const frame = {
      kind: "observation",
      observation: {
        kind: "attached",
        view: {
          kind: "run",
          run: {
            id: "run_1",
            name: "review",
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:01.000Z",
            agentSessions: [{
              scope: "node",
              agentSessionId: "session-1",
              generation: 1,
              lifecycle: "active",
              reportedVersion: "fixture-agent/1.2.3",
              ownershipHealth: "healthy",
              currentBinding: { attemptId: "attempt-1", operation: "start", promptOrigin: "authored" },
              checkpoint: { value: "provider_observed", attemptId: "attempt-1", turnId: "turn-1", promptOrigin: "authored" },
            }],
          },
          counts: { total: 1, running: 1 },
          tree: [],
        },
      },
    };

    expect(isDaemonRunStreamFrame(frame)).toBe(true);
    expect(isDaemonRunStreamFrame({
      ...frame,
      observation: {
        ...frame.observation,
        view: {
          ...frame.observation.view,
          run: {
            ...frame.observation.view.run,
            agentSessions: [{ ...frame.observation.view.run.agentSessions[0], ownershipHealth: "unknown" }],
          },
        },
      },
    })).toBe(false);
    expect(isDaemonRunStreamFrame({
      ...frame,
      observation: {
        ...frame.observation,
        view: {
          ...frame.observation.view,
          run: {
            ...frame.observation.view.run,
            agentSessions: [{
              ...frame.observation.view.run.agentSessions[0],
              bindingDigest: "sha256:not-a-digest",
            }],
          },
        },
      },
    })).toBe(false);
    expect(isDaemonRunStreamFrame({
      ...frame,
      observation: {
        ...frame.observation,
        view: {
          ...frame.observation.view,
          run: {
            ...frame.observation.view.run,
            agentSessions: [{
              ...frame.observation.view.run.agentSessions[0],
              reportedVersion: "x".repeat(257),
            }],
          },
        },
      },
    })).toBe(false);
  });
});

function runDetails() {
  return {
    id: "run_1",
    name: "review",
    status: "running",
    workflowEntry: "review.workflow.ts",
    sourceGraphDigest: "sha256:review",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:01.000Z",
    progressVersion: 2,
    input: {},
    hooks: [],
    eventCount: 4,
    nodeCount: 1,
    execution: { state: "active", lastStatus: "running", reason: "run_lease_active" },
  };
}

function activeTargetInspection() {
  return {
    kind: "target",
    detail: "summary",
    run: { id: "run_1", status: "running" },
    subject: { label: "Review", kind: "agent", selector: "@123456789abc" },
    state: { status: "running" },
    availableControls: [{
      type: "steer",
      target: "attempt-1",
      delivery: "interrupt_continue",
      effect: "cancel_drain_then_continue",
    }],
  };
}
