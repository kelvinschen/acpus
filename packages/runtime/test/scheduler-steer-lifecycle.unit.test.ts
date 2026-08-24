import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { projectSteerLifecycle, type SequencedSchedulerEvent } from "../src/scheduler/steer-lifecycle.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";

describe("Steer lifecycle projection", () => {
  it("projects draining, queued, and one replacement from the closed relation", () => {
    const draining = base();
    expect(Result.getOrThrow(projectSteerLifecycle("steer-1", draining))).toMatchObject({ phase: "draining" });
    const queued = [...draining, requeued()];
    expect(Result.getOrThrow(projectSteerLifecycle("steer-1", queued, "terminal_observed"))).toMatchObject({ phase: "queued" });
    expect(Result.getOrThrow(projectSteerLifecycle("steer-1", [...queued, started()], "terminal_observed"))).toEqual({
      steerId: "steer-1",
      delivery: "interrupt_continue",
      fencedAttemptId: "attempt-old",
      phase: "replacement_started",
      replacementAttemptId: "attempt-new",
    });
  });

  it("projects blocked only with exact unknown checkpoint and failure", () => {
    const events: SequencedSchedulerEvent[] = [
      ...base(),
      {
        sequence: 12,
        event: {
          type: "control.agent_steer_blocked",
          payload: { steerId: "steer-1", nodeKey: "agent~1", fencedAttemptId: "attempt-old", checkpoint: "terminal_unknown" },
        },
      },
      { sequence: 13, event: { type: "instance.failed", payload: { nodeKey: "agent~1", error: { message: "unknown" } } } },
    ];
    expect(Result.getOrThrow(projectSteerLifecycle("steer-1", events, "terminal_unknown"))).toMatchObject({
      phase: "blocked",
      blockedCheckpoint: "terminal_unknown",
    });
  });

  it("rejects missing, out-of-order, and duplicate replacement facts", () => {
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", [base()[0]!])))).toMatchObject({ type: "invalid_steer_lifecycle" });
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", [...base(), started()]))).message).toContain("before");
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", [base()[0]!, { ...requeued(), sequence: 11 }, { ...base()[1]!, sequence: 12 }], "terminal_observed"))).message).toContain("before");
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", [...base(), { ...started(), sequence: 12 }, { ...requeued(), sequence: 13 }], "terminal_observed"))).message).toContain("before");
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", [...base(), { ...requeued(), event: { ...requeued().event, payload: { ...requeued().event.payload, steerEventSequence: 9 } } }], "terminal_observed"))).message).toContain("authority");
    const queued = [...base(), requeued(), started(), { ...started(), sequence: 14, event: { ...started().event, payload: { ...started().event.payload, attemptId: "attempt-other" } } }];
    expect(Result.getOrThrow(Result.flip(projectSteerLifecycle("steer-1", queued, "terminal_observed"))).message).toContain("duplicate");
  });
});

function base(): SequencedSchedulerEvent[] {
  return [
    {
      sequence: 10,
      event: {
        type: "control.agent_steer_requested",
        payload: {
          steerId: "steer-1",
          requestedTarget: "agent",
          nodeKey: "agent~1",
          fencedAttemptId: "attempt-old",
          instruction: "new direction",
          delivery: "interrupt_continue",
        },
      },
    },
    { sequence: 11, event: { type: "attempt.superseded", payload: { attemptId: "attempt-old", cancelReason: "operator_steered" } } },
  ];
}

function requeued(): SequencedSchedulerEvent & {
  event: Extract<SchedulerEvent, { type: "instance.requeued" }> & {
    payload: Extract<Extract<SchedulerEvent, { type: "instance.requeued" }>["payload"], { reason: "steered" }>;
  };
} {
  return {
    sequence: 12,
    event: {
      type: "instance.requeued",
      payload: {
        nodeKey: "agent~1",
        reason: "steered",
        steerId: "steer-1",
        steerEventSequence: 10,
      },
    },
  };
}

function started(): SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "attempt.started" }> } {
  return {
    sequence: 13,
    event: {
      type: "attempt.started",
      payload: {
        runId: "run-1",
        attemptId: "attempt-new",
        nodeKey: "agent~1",
        nodeId: "agent",
        attemptNo: 2,
        ownerEpoch: 1,
        steerId: "steer-1",
        steerEventSequence: 10,
      },
    },
  };
}
