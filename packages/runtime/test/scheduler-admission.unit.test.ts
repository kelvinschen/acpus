import { describe, expect, it } from "vitest";
import { selectNextAdmission } from "../src/scheduler/admission.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";

describe("scheduler admission", () => {
  it("selects the oldest admissible leaf after skipping an earlier group-blocked leaf", () => {
    const projection = projected([
      group("limited", 1),
      member("limited", "busy", 1),
      { type: "group.member_started", payload: { memberKey: "busy" } },
      member("limited", "blocked-scope", 2),
      frame("blocked-scope"),
      ready("blocked", 1, "blocked-scope"),
      ready("open", 2),
    ]);

    expect(selectNextAdmission({
      projection,
      maxLeafConcurrency: 2,
      ownerLocalUnsettled: 0,
      signalNodeIds: new Set(),
    })).toMatchObject({ kind: "executor", instance: { nodeKey: "open" } });
  });

  it("uses ordinal nodeKey order to break equal durable readiness sequences", () => {
    const projection = projected([
      ready("a-lower", 1),
      ready("Z-upper", 1),
    ]);

    expect(selectNextAdmission({
      projection,
      maxLeafConcurrency: 1,
      ownerLocalUnsettled: 0,
      signalNodeIds: new Set(),
    })).toMatchObject({ kind: "executor", instance: { nodeKey: "Z-upper" } });
  });

  it("charges a local cap once for a running direct member with multiple ready descendant leaves", () => {
    const initial = projected([
      group("limited", 1),
      member("limited", "active-scope", 1),
      frame("active-scope"),
      { type: "group.member_started", payload: { memberKey: "active-scope" } },
      member("limited", "blocked-scope", 2),
      frame("blocked-scope"),
      ready("blocked-other", 1, "blocked-scope"),
      ready("first-active", 2, "active-scope"),
      ready("second-active", 3, "active-scope"),
    ]);

    expect(selectNextAdmission({
      projection: initial,
      maxLeafConcurrency: 2,
      ownerLocalUnsettled: 0,
      signalNodeIds: new Set(),
    })).toMatchObject({ kind: "executor", instance: { nodeKey: "first-active" } });

    const afterFirstStart = applySchedulerEvents(initial, [
      { type: "instance.started", payload: { nodeKey: "first-active" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt-1", nodeKey: "first-active", nodeId: "first-active", attemptNo: 1, ownerEpoch: 1 } },
    ]);
    expect(selectNextAdmission({
      projection: afterFirstStart,
      maxLeafConcurrency: 2,
      ownerLocalUnsettled: 1,
      signalNodeIds: new Set(),
    })).toMatchObject({ kind: "executor", instance: { nodeKey: "second-active" } });
  });

  it("admits a Signal when the leaf cap is full but still applies its local group cap", () => {
    const fullRun = projected([
      ready("active", 0),
      { type: "instance.started", payload: { nodeKey: "active" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt-1", nodeKey: "active", nodeId: "active", attemptNo: 1, ownerEpoch: 1 } },
      ready("executor", 1),
      ready("approval", 2, undefined, "signal"),
    ]);
    expect(selectNextAdmission({
      projection: fullRun,
      maxLeafConcurrency: 1,
      ownerLocalUnsettled: 1,
      signalNodeIds: new Set(["signal"]),
    })).toMatchObject({ kind: "signal", instance: { nodeKey: "approval" } });

    const groupBlocked = projected([
      group("limited", 1),
      member("limited", "busy", 1),
      { type: "group.member_started", payload: { memberKey: "busy" } },
      member("limited", "signal-scope", 2),
      frame("signal-scope"),
      ready("approval", 1, "signal-scope", "signal"),
    ]);
    expect(selectNextAdmission({
      projection: groupBlocked,
      maxLeafConcurrency: 0,
      ownerLocalUnsettled: 0,
      signalNodeIds: new Set(["signal"]),
    })).toBeUndefined();
  });

  it("blocks executor admission independently on durable and owner-local physical occupancy", () => {
    const readyOnly = projected([ready("next", 1)]);
    expect(selectNextAdmission({
      projection: readyOnly,
      maxLeafConcurrency: 1,
      ownerLocalUnsettled: 1,
      signalNodeIds: new Set(),
    })).toBeUndefined();

    const durablyFull = projected([
      ready("active", 0),
      { type: "instance.started", payload: { nodeKey: "active" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt-1", nodeKey: "active", nodeId: "active", attemptNo: 1, ownerEpoch: 1 } },
      ready("next", 1),
    ]);
    expect(selectNextAdmission({
      projection: durablyFull,
      maxLeafConcurrency: 1,
      ownerLocalUnsettled: 0,
      signalNodeIds: new Set(),
    })).toBeUndefined();
  });

  it("skips an executor whose session resource is still occupied without blocking unrelated sessions", () => {
    const projection = projected([
      ready("same-session", 1),
      ready("other-session", 2),
    ]);

    expect(selectNextAdmission({
      projection,
      maxLeafConcurrency: 2,
      ownerLocalUnsettled: 1,
      ownerLocalUnsettledExecutorResources: new Set(["session:shared"]),
      executorResourceFor: instance => instance.nodeKey === "same-session" ? "session:shared" : "session:other",
      signalNodeIds: new Set(),
    })).toMatchObject({ kind: "executor", instance: { nodeKey: "other-session" } });
  });
});

function projected(events: SchedulerEvent[]) {
  return applySchedulerEvents(createSchedulerProjection("run_1"), events);
}

function group(groupKey: string, maxConcurrency: number): SchedulerEvent {
  return { type: "group.started", payload: { runId: "run_1", groupKey, nodeKey: groupKey, nodeId: groupKey, kind: "parallel", strategy: "all", maxConcurrency } };
}

function member(groupKey: string, memberKey: string, readinessSequence: number): SchedulerEvent {
  return { type: "group.member_ready", payload: { runId: "run_1", groupKey, memberKey, childFrameKey: memberKey, memberKind: "branch", branchId: memberKey, readinessSequence } };
}

function frame(frameKey: string): SchedulerEvent {
  return { type: "frame.started", payload: { runId: "run_1", frameKey, frameKind: "branch" } };
}

function ready(nodeKey: string, readinessSequence: number, parentFrameKey?: string, nodeId = nodeKey): SchedulerEvent {
  return {
    type: "instance.ready",
    payload: {
      runId: "run_1",
      nodeKey,
      nodeId,
      instancePath: [{ kind: "node", nodeId }],
      readinessSequence,
      ...(parentFrameKey === undefined ? {} : { parentFrameKey }),
    },
  };
}
