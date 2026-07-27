import { describe, expect, it } from "vitest";
import {
  canCancelRun,
  planCancelControl,
  planRetryControl,
  retryControlTargets,
} from "../src/scheduler/control-plan.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";
import {
  applySchedulerEvents,
  createSchedulerProjection,
} from "../src/scheduler/transitions.js";

describe("scheduler control plans", () => {
  it("projects only planner-approved retry targets in stable exact-key order", () => {
    const snapshot = schedulerSnapshot([
      rootStarted(),
      {
        type: "instance.ready",
        payload: {
          runId: "run_1",
          nodeKey: "z_node",
          nodeId: "task",
          parentFrameKey: "root",
          instancePath: [],
        },
      },
      {
        type: "instance.failed",
        payload: { nodeKey: "z_node", error: { reason: "provider_failed" } },
      },
      {
        type: "instance.ready",
        payload: {
          runId: "run_1",
          nodeKey: "m_expression",
          nodeId: "configured",
          parentFrameKey: "root",
          instancePath: [],
        },
      },
      {
        type: "instance.failed",
        payload: {
          nodeKey: "m_expression",
          error: { reason: "expression_resolution_failed" },
          statusReason: "expression_resolution_failed",
        },
      },
      {
        type: "frame.started",
        payload: {
          runId: "run_1",
          frameKey: "a_frame",
          frameKind: "node",
          nodeId: "route",
          parentFrameKey: "root",
        },
      },
      {
        type: "frame.failed",
        payload: { frameKey: "a_frame", error: { reason: "branch_failed" } },
      },
    ]);

    expect(retryControlTargets(snapshot)).toEqual([
      { target: "a_frame", kind: "frame", nodeId: "route" },
      { target: "z_node", kind: "node", nodeId: "task" },
    ]);
    expect(planRetryControl(snapshot, "m_expression")._unsafeUnwrapErr()).toMatchObject({
      type: "invalid-retry-target",
      targetKey: "m_expression",
      status: "expression_resolution_failed",
    });
  });

  it("resolves static retry aliases deterministically but preserves exact targets", () => {
    const snapshot = schedulerSnapshot([
      rootStarted(),
      ...failedInstance("z_occurrence", "task"),
      ...failedInstance("a_occurrence", "task"),
    ]);

    expect(planRetryControl(snapshot, "task")._unsafeUnwrapErr()).toEqual({
      type: "ambiguous-retry-target",
      runId: "run_1",
      targetKey: "task",
      candidateKeys: ["a_occurrence", "z_occurrence"],
      message: "Scheduler retry target 'task' is ambiguous. Candidate target keys: a_occurrence, z_occurrence.",
    });
    expect(planRetryControl(snapshot, "z_occurrence")._unsafeUnwrap()).toEqual({
      resolvedTarget: "z_occurrence",
      events: [{
        type: "instance.retry_requested",
        payload: { nodeKey: "z_occurrence" },
      }],
    });
  });

  it("rejects a target key shared by frame and node identities as corruption", () => {
    const snapshot = schedulerSnapshot([
      rootStarted(),
      {
        type: "frame.started",
        payload: {
          runId: "run_1",
          frameKey: "collision",
          frameKind: "node",
          nodeKey: "collision",
          nodeId: "frame",
          parentFrameKey: "root",
        },
      },
      {
        type: "frame.failed",
        payload: { frameKey: "collision", error: { reason: "failed" } },
      },
      ...failedInstance("collision", "node"),
    ]);

    const corruption = "Scheduler control target 'collision' has both frame and node identities.";
    expect(() => retryControlTargets(snapshot)).toThrow(corruption);
    expect(() => planRetryControl(snapshot, "collision")).toThrow(corruption);
    expect(() => planCancelControl(snapshot, "collision")).toThrow(corruption);
  });

  it("rejects targeted retry through the same run-status rule used by mutation", () => {
    const active = schedulerSnapshot([
      rootStarted(),
      ...failedInstance("target", "target"),
    ]);
    const paused = {
      ...active,
      projection: {
        ...active.projection,
        run: { ...active.projection.run, status: "paused" as const, paused: true },
      },
    };

    expect(planRetryControl(paused, "target")._unsafeUnwrapErr()).toMatchObject({
      type: "invalid-retry-target",
      targetKey: "target",
      status: "paused",
    });
  });

  it("distinguishes useful run cancel from idempotent terminal acceptance", () => {
    const pending = schedulerSnapshot([]);
    expect(canCancelRun(pending)).toBe(true);
    expect(planCancelControl(pending)._unsafeUnwrap()).toEqual({
      events: [
        {
          type: "frame.started",
          payload: { runId: "run_1", frameKey: "root", frameKind: "root" },
        },
        {
          type: "frame.cancelled",
          payload: { frameKey: "root", cancelReason: "operator_cancelled" },
        },
      ],
    });

    const pausedBeforeRoot = {
      ...pending,
      projection: applySchedulerEvents(pending.projection, [{
        type: "control.paused",
        payload: {},
      }]),
    };
    expect(canCancelRun(pausedBeforeRoot)).toBe(true);
    expect(planCancelControl(pausedBeforeRoot)._unsafeUnwrap()).toEqual({
      events: [
        {
          type: "frame.started",
          payload: { runId: "run_1", frameKey: "root", frameKind: "root" },
        },
        {
          type: "frame.cancelled",
          payload: { frameKey: "root", cancelReason: "operator_cancelled" },
        },
      ],
    });

    const canceled = schedulerSnapshot([
      rootStarted(),
      {
        type: "frame.cancelled",
        payload: { frameKey: "root", cancelReason: "operator_cancelled" },
      },
    ]);
    expect(canCancelRun(canceled)).toBe(false);
    expect(planCancelControl(canceled)._unsafeUnwrap()).toEqual({ events: [] });
  });

  it("offers exact active cancel targets and rejects terminal or ambiguous targets", () => {
    const active = schedulerSnapshot([
      rootStarted(),
      readyInstance("z_occurrence", "task"),
      readyInstance("a_occurrence", "task"),
      readyInstance("finished", "done"),
      { type: "instance.completed", payload: { nodeKey: "finished", output: null } },
    ]);

    expect(planCancelControl(active, "z_occurrence")._unsafeUnwrap()).toEqual({
      resolvedTarget: "z_occurrence",
      events: [{
        type: "instance.cancelled",
        payload: { nodeKey: "z_occurrence", cancelReason: "operator_cancelled" },
      }],
    });
    expect(planCancelControl(active, "finished")._unsafeUnwrapErr()).toMatchObject({
      type: "invalid-cancel-target",
      targetKey: "finished",
      status: "completed",
    });
    expect(planCancelControl(active, "task")._unsafeUnwrapErr()).toMatchObject({
      type: "ambiguous-cancel-target",
      candidateKeys: ["a_occurrence", "z_occurrence"],
    });
  });

  it("keeps batch assessment aligned with the exact mutation planner", () => {
    const snapshot = schedulerSnapshot(nestedCompletionDependencyEvents(3));
    const targets = new Set(retryControlTargets(snapshot).map(target => target.target));
    const candidates = [
      ...Object.values(snapshot.projection.frames)
        .filter(frame => frame.status === "failed" && (frame.frameKind === "node" || frame.frameKind === "loop"))
        .map(frame => frame.frameKey),
      ...Object.values(snapshot.projection.instances)
        .filter(instance => instance.status === "failed")
        .map(instance => instance.nodeKey),
    ];

    for (const candidate of candidates) {
      expect(targets.has(candidate)).toBe(planRetryControl(snapshot, candidate).isOk());
    }
  });

  it("projects nested completion dependencies without replaying each candidate", () => {
    const memberCount = 1_000;
    const targets = retryControlTargets(
      schedulerSnapshot(nestedCompletionDependencyEvents(memberCount)),
    );

    expect(targets).toHaveLength(memberCount + 2);
    expect(targets[0]).toEqual({ target: "inner", kind: "frame", nodeId: "inner" });
    expect(targets.filter(target => target.kind === "node")).toHaveLength(memberCount);
    expect(targets.at(-1)).toEqual({ target: "outer", kind: "frame", nodeId: "outer" });
  });

  it("projects a deep failed frame chain through shared ancestor assessment", () => {
    const frameCount = 1_000;
    const targets = retryControlTargets(
      schedulerSnapshot(deepFailedFrameEvents(frameCount)),
    );

    expect(targets).toHaveLength(frameCount);
    expect(targets[0]).toEqual({
      target: "frame.0000",
      kind: "frame",
      nodeId: "node.0000",
    });
    expect(targets.at(-1)).toEqual({
      target: "frame.0999",
      kind: "frame",
      nodeId: "node.0999",
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

function rootStarted(): SchedulerEvent {
  return {
    type: "frame.started",
    payload: { runId: "run_1", frameKey: "root", frameKind: "root" },
  };
}

function readyInstance(nodeKey: string, nodeId: string): SchedulerEvent {
  return {
    type: "instance.ready",
    payload: {
      runId: "run_1",
      nodeKey,
      nodeId,
      parentFrameKey: "root",
      instancePath: [],
    },
  };
}

function failedInstance(nodeKey: string, nodeId: string): SchedulerEvent[] {
  return [
    readyInstance(nodeKey, nodeId),
    {
      type: "instance.failed",
      payload: { nodeKey, error: { reason: "failed" } },
    },
  ];
}

function nestedCompletionDependencyEvents(memberCount: number): SchedulerEvent[] {
  const events: SchedulerEvent[] = [
    rootStarted(),
    {
      type: "frame.started",
      payload: {
        runId: "run_1",
        frameKey: "outer",
        frameKind: "node",
        parentFrameKey: "root",
        nodeKey: "outer",
        nodeId: "outer",
        strategy: "all",
      },
    },
    {
      type: "group.started",
      payload: {
        runId: "run_1",
        groupKey: "outer",
        nodeKey: "outer",
        nodeId: "outer",
        kind: "fanout",
        strategy: "all",
      },
    },
    {
      type: "frame.started",
      payload: {
        runId: "run_1",
        frameKey: "outer.target",
        frameKind: "fanout_item",
        parentFrameKey: "outer",
      },
    },
    {
      type: "group.member_ready",
      payload: {
        runId: "run_1",
        groupKey: "outer",
        memberKey: "outer.target",
        childFrameKey: "outer.target",
        memberKind: "fanout_item",
        itemIndex: 0,
        item: null,
        readinessSequence: 1,
      },
    },
    {
      type: "frame.started",
      payload: {
        runId: "run_1",
        frameKey: "inner",
        frameKind: "node",
        parentFrameKey: "outer.target",
        nodeKey: "inner",
        nodeId: "inner",
        strategy: "quorum",
      },
    },
    {
      type: "group.started",
      payload: {
        runId: "run_1",
        groupKey: "inner",
        nodeKey: "inner",
        nodeId: "inner",
        kind: "fanout",
        strategy: "quorum",
        quorumCount: 1,
      },
    },
  ];
  for (let index = 0; index < memberCount; index += 1) {
    const nodeKey = `inner.item.${index}`;
    events.push(
      {
        type: "group.member_ready",
        payload: {
          runId: "run_1",
          groupKey: "inner",
          memberKey: nodeKey,
          memberKind: "fanout_item",
          itemIndex: index,
          item: null,
          readinessSequence: index + 2,
        },
      },
      {
        type: "instance.ready",
        payload: {
          runId: "run_1",
          nodeKey,
          nodeId: "task",
          parentFrameKey: "inner",
          instancePath: [],
        },
      },
      {
        type: "instance.failed",
        payload: { nodeKey, error: { reason: "failed" } },
      },
      {
        type: "group.member_failed",
        payload: { memberKey: nodeKey, error: { reason: "failed" } },
      },
    );
  }
  events.push(
    { type: "group.failed", payload: { groupKey: "inner", error: { reason: "quorum_impossible" } } },
    { type: "frame.failed", payload: { frameKey: "inner", error: { reason: "quorum_impossible" } } },
    { type: "frame.failed", payload: { frameKey: "outer.target", error: { reason: "quorum_impossible" } } },
    { type: "group.member_failed", payload: { memberKey: "outer.target", error: { reason: "quorum_impossible" } } },
  );
  for (let index = 0; index < memberCount; index += 1) {
    const nodeKey = `outer.dependency.${index}`;
    events.push(
      {
        type: "group.member_ready",
        payload: {
          runId: "run_1",
          groupKey: "outer",
          memberKey: nodeKey,
          memberKind: "fanout_item",
          itemIndex: index + 1,
          item: null,
          readinessSequence: memberCount + index + 2,
        },
      },
      {
        type: "instance.ready",
        payload: {
          runId: "run_1",
          nodeKey,
          nodeId: "dependency",
          parentFrameKey: "outer",
          instancePath: [],
        },
      },
      {
        type: "instance.cancelled",
        payload: { nodeKey, cancelReason: "parent_failed" },
      },
      {
        type: "group.member_cancelled",
        payload: { memberKey: nodeKey, cancelReason: "parent_failed" },
      },
    );
  }
  events.push(
    { type: "group.failed", payload: { groupKey: "outer", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "outer", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "root", error: { reason: "member_failed" } } },
  );
  return events;
}

function deepFailedFrameEvents(frameCount: number): SchedulerEvent[] {
  const events: SchedulerEvent[] = [rootStarted()];
  let parentFrameKey = "root";
  for (let index = 0; index < frameCount; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const frameKey = `frame.${suffix}`;
    events.push({
      type: "frame.started",
      payload: {
        runId: "run_1",
        frameKey,
        frameKind: "node",
        parentFrameKey,
        nodeKey: frameKey,
        nodeId: `node.${suffix}`,
      },
    });
    parentFrameKey = frameKey;
  }
  for (let index = frameCount - 1; index >= 0; index -= 1) {
    events.push({
      type: "frame.failed",
      payload: {
        frameKey: `frame.${String(index).padStart(4, "0")}`,
        error: { reason: "failed" },
      },
    });
  }
  events.push({
    type: "frame.failed",
    payload: { frameKey: "root", error: { reason: "failed" } },
  });
  return events;
}
