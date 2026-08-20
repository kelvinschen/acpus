import type { NodeIR, AdmittedWorkflowIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { planSteerControl, steerControlTargets } from "../src/scheduler/steer-plan.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import type { FrozenSchedulerRun } from "../src/scheduler/settle.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { InstancePath } from "../src/scheduler/types.js";

describe("scheduler steer plan", () => {
  it("shares exact occurrence resolution with the planner-approved active capability batch", () => {
    const reviewPath: InstancePath = [{ kind: "node", nodeId: "review" }];
    const snapshot = schedulerSnapshot([
      rootStarted({ review: "review~1", check: "check~1" }),
      ...started("review~1", "review", "attempt-review", reviewPath),
      ...started("check~1", "check", "attempt-check", [{ kind: "node", nodeId: "check" }]),
    ]);
    const frozen = frozenWorkflow([agent("review"), task("check")]);

    expect(planSteerControl(frozen, snapshot, deriveOccurrenceRef(reviewPath))._unsafeUnwrap()).toEqual({
      target: {
        runId: "run_1",
        attemptId: "attempt-review",
        nodeKey: "review~1",
        nodeId: "review",
        attemptNo: 1,
      },
    });
    expect(steerControlTargets(frozen, snapshot)).toEqual([{
      runId: "run_1",
      attemptId: "attempt-review",
      nodeKey: "review~1",
      nodeId: "review",
      attemptNo: 1,
    }]);
  });

  it("excludes shared Agent sessions from the batch and preserves exact conflict diagnostics", () => {
    const snapshot = schedulerSnapshot([
      rootStarted({ first: "first~1", second: "second~1" }),
      ...started("first~1", "first", "attempt-first", [{ kind: "node", nodeId: "first" }]),
      ...started("second~1", "second", "attempt-second", [{ kind: "node", nodeId: "second" }]),
    ]);
    const frozen = frozenWorkflow([agent("first", "shared"), agent("second", "shared")]);

    expect(steerControlTargets(frozen, snapshot)).toEqual([]);
    expect(planSteerControl(frozen, snapshot, "attempt-first")._unsafeUnwrapErr()).toEqual({
      type: "steer-session-conflict",
      runId: "run_1",
      targetKey: "first~1",
      candidateKeys: ["second~1"],
      message: "Agent session for steer target 'first~1' is also used by active nodeKeys: second~1.",
    });
  });

  it("keeps the batch capability aligned with exact planner outcomes", () => {
    const snapshot = schedulerSnapshot([
      rootStarted({ review: "review~1", first: "first~1", second: "second~1", check: "check~1" }),
      ...started("review~1", "review", "attempt-review", [{ kind: "node", nodeId: "review" }]),
      ...started("first~1", "first", "attempt-first", [{ kind: "node", nodeId: "first" }]),
      ...started("second~1", "second", "attempt-second", [{ kind: "node", nodeId: "second" }]),
      ...started("check~1", "check", "attempt-check", [{ kind: "node", nodeId: "check" }]),
    ]);
    const frozen = frozenWorkflow([agent("review"), agent("first", "shared"), agent("second", "shared"), task("check")]);
    const approved = new Set(steerControlTargets(frozen, snapshot).map(target => target.attemptId));

    for (const attempt of Object.values(snapshot.projection.attempts)) {
      expect(approved.has(attempt.attemptId)).toBe(planSteerControl(frozen, snapshot, attempt.attemptId).isOk());
    }
  });

  it("keeps an exact non-Agent attempt invalid rather than silently omitting its error", () => {
    const snapshot = schedulerSnapshot([
      rootStarted({ check: "check~1" }),
      ...started("check~1", "check", "attempt-check", [{ kind: "node", nodeId: "check" }]),
    ]);

    expect(planSteerControl(frozenWorkflow([task("check")]), snapshot, "attempt-check")._unsafeUnwrapErr()).toEqual({
      type: "invalid-steer-target",
      runId: "run_1",
      targetKey: "attempt-check",
      status: "task",
      message: "Steer target 'attempt-check' is not an Agent attempt.",
    });
  });
});

function schedulerSnapshot(events: SchedulerEvent[]): SchedulerSnapshot {
  return {
    runId: "run_1",
    version: events.length,
    projection: applySchedulerEvents(createSchedulerProjection("run_1"), events),
  };
}

function rootStarted(scope: Record<string, string>): SchedulerEvent {
  return { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope } };
}

function started(nodeKey: string, nodeId: string, attemptId: string, instancePath: InstancePath): SchedulerEvent[] {
  return [
    {
      type: "instance.ready",
      payload: {
        runId: "run_1",
        nodeKey,
        nodeId,
        parentFrameKey: "root",
        instancePath,
      },
    },
    { type: "instance.started", payload: { nodeKey } },
    {
      type: "attempt.started",
      payload: { runId: "run_1", attemptId, nodeKey, nodeId, attemptNo: 1, ownerEpoch: 1 },
    },
  ];
}

function frozenWorkflow(nodes: NodeIR[]): FrozenSchedulerRun {
  const ir: AdmittedWorkflowIR = {
    irVersion: 8,
    name: "steer-plan",
    agents: { reviewer: { kind: "agent_definition", use: "codex" } },
    root: { nodes, output: { kind: "object", fields: {} } },
    diagnostics: [],
  };
  return { ir, input: {}, meta: {} };
}

function agent(id: string, sessionKey?: string): Extract<NodeIR, { kind: "agent" }> {
  return {
    id,
    kind: "agent",
    run: {
      agent: "reviewer",
      prompt: { kind: "literal", value: "Review" },
      ...(sessionKey === undefined
        ? {}
        : { sessionKey: { kind: "template", parts: [{ kind: "text", value: sessionKey }] } }),
    },
  };
}

function task(id: string): Extract<NodeIR, { kind: "task" }> {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source: "async function task() {}" },
    },
  };
}
