import { describe, expect, it } from "vitest";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { appendBranch, appendFanoutItem, appendNode } from "../src/scheduler/identity.js";
import { nextGroupCompletionBatchEvents, targetedRetryGroupAssessment } from "../src/scheduler/group-policy.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { GroupMember, GroupMemberStatus, GroupProjection } from "../src/scheduler/types.js";

describe("scheduler retry completion closure", () => {
  it("settles nested all groups deepest-first in independently applicable batches", () => {
    const outerPath = appendNode([], "outer");
    const activePath = appendBranch([], "outer", "active");
    const innerPath = appendNode(activePath, "inner");
    const cancelledPath = appendBranch([], "outer", "cancelled");
    let projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "outer", frameKind: "node", nodeKey: "outer", nodeId: "outer", instancePath: outerPath, strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "outer", nodeKey: "outer", nodeId: "outer", kind: "parallel", strategy: "all" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "outer.active", frameKind: "branch", parentFrameKey: "outer", instancePath: activePath } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "outer", memberKey: "outer.active", childFrameKey: "outer.active", memberKind: "branch", branchId: "active", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "outer.active" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "inner", frameKind: "node", parentFrameKey: "outer.active", nodeKey: "inner", nodeId: "inner", instancePath: innerPath, strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "inner", nodeKey: "inner", nodeId: "inner", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "inner", memberKey: "inner.done", memberKind: "branch", branchId: "done", readinessSequence: 2 } },
      { type: "group.member_completed", payload: { memberKey: "inner.done", completionSequence: 2 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "inner", memberKey: "inner.cancelled", memberKind: "branch", branchId: "cancelled", readinessSequence: 3 } },
      { type: "group.member_cancelled", payload: { memberKey: "inner.cancelled", cancelReason: "parent_failed" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "outer.cancelled", frameKind: "branch", parentFrameKey: "outer", instancePath: cancelledPath } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "outer", memberKey: "outer.cancelled", childFrameKey: "outer.cancelled", memberKind: "branch", branchId: "cancelled", readinessSequence: 4 } },
      { type: "group.member_cancelled", payload: { memberKey: "outer.cancelled", cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "outer.cancelled", cancelReason: "parent_failed" } },
    ]);

    const first = nextGroupCompletionBatchEvents(projection);
    expect(first).toEqual([
      { type: "group.failed", payload: { groupKey: "inner", error: { reason: "parent_failed" } } },
    ]);
    expect(() => applySchedulerEvents(projection, first)).not.toThrow();
    projection = JSON.parse(JSON.stringify(applySchedulerEvents(projection, first))) as typeof projection;

    const second = nextGroupCompletionBatchEvents(projection);
    expect(second).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "outer.active", cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "inner", cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "outer.active", cancelReason: "parent_failed" } },
      { type: "group.failed", payload: { groupKey: "outer", error: { reason: "parent_failed" } } },
    ]);
    expect(() => applySchedulerEvents(projection, second)).not.toThrow();
    projection = applySchedulerEvents(projection, second);

    expect(nextGroupCompletionBatchEvents(projection)).toEqual([]);
  });

  it("settles wide groups without rescanning every member per group", () => {
    const groupCount = 5_000;
    const setup: SchedulerEvent[] = [];
    for (let index = 0; index < groupCount; index += 1) {
      const groupKey = `group.${index}`;
      const memberKey = `${groupKey}.member`;
      setup.push(
        { type: "frame.started", payload: { runId: "run_1", frameKey: groupKey, frameKind: "node", nodeKey: groupKey, nodeId: groupKey, strategy: "all" } },
        { type: "group.started", payload: { runId: "run_1", groupKey, nodeKey: groupKey, nodeId: groupKey, kind: "parallel", strategy: "all" } },
        { type: "group.member_ready", payload: { runId: "run_1", groupKey, memberKey, memberKind: "branch", branchId: "member", readinessSequence: index + 1 } },
        { type: "group.member_completed", payload: { memberKey, completionSequence: index + 1 } },
      );
    }

    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), setup);
    const events = nextGroupCompletionBatchEvents(projection);

    expect(events).toHaveLength(groupCount);
    expect(events[0]).toEqual({ type: "group.completed", payload: { groupKey: "group.0", result: { acceptedMemberKeys: ["group.0.member"] } } });
    expect(events.at(-1)).toEqual({ type: "group.completed", payload: { groupKey: "group.4999", result: { acceptedMemberKeys: ["group.4999.member"] } } });
  });

  it("cancels five thousand members through one linear completion batch", () => {
    const memberCount = 5_000;
    const setup: SchedulerEvent[] = [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "wide", frameKind: "node", nodeKey: "wide", nodeId: "wide", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "wide", nodeKey: "wide", nodeId: "wide", kind: "fanout", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "wide", memberKey: "item.0", memberKind: "fanout_item", itemIndex: 0, item: 0, readinessSequence: 1 } },
      { type: "group.member_failed", payload: { memberKey: "item.0", error: { reason: "boom" } } },
    ];
    for (let index = 1; index < memberCount; index += 1) {
      const memberKey = `item.${index}`;
      setup.push(
        { type: "group.member_ready", payload: { runId: "run_1", groupKey: "wide", memberKey, memberKind: "fanout_item", itemIndex: index, item: index, readinessSequence: index + 1 } },
        { type: "instance.ready", payload: { runId: "run_1", nodeKey: memberKey, nodeId: "item", instancePath: [], readinessSequence: index + 1 } },
      );
    }

    const events = nextGroupCompletionBatchEvents(applySchedulerEvents(createSchedulerProjection("run_1"), setup));

    expect(events).toHaveLength((memberCount - 1) * 2 + 1);
    expect(events.slice(0, 2)).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "item.1", cancelReason: "parent_failed" } },
      { type: "instance.cancelled", payload: { nodeKey: "item.1", cancelReason: "parent_failed" } },
    ]);
    expect(events.slice(-3)).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "item.4999", cancelReason: "parent_failed" } },
      { type: "instance.cancelled", payload: { nodeKey: "item.4999", cancelReason: "parent_failed" } },
      { type: "group.failed", payload: { groupKey: "wide", error: { reason: "member_failed" } } },
    ]);
  });

  it("rejects a running group whose owning frame is missing", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "orphan", nodeKey: "orphan", nodeId: "orphan", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "orphan", memberKey: "orphan.done", memberKind: "branch", branchId: "done", readinessSequence: 1 } },
      { type: "group.member_completed", payload: { memberKey: "orphan.done", completionSequence: 1 } },
    ]);

    expect(() => nextGroupCompletionBatchEvents(projection)).toThrow("Group 'orphan' references missing frame 'orphan'.");
  });

  it("rejects an orphan group before it becomes terminalizable", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "orphan", nodeKey: "orphan", nodeId: "orphan", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "orphan", memberKey: "orphan.ready", memberKind: "branch", branchId: "ready", readinessSequence: 1 } },
    ]);

    expect(() => nextGroupCompletionBatchEvents(projection)).toThrow("Group 'orphan' references missing frame 'orphan'.");
  });

  it("rejects inconsistent group owner and child-frame identities", () => {
    const wrongOwner = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "wrong", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(wrongOwner)).toThrow("Group 'group' has inconsistent owner frame 'group'.");

    const missingChild = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "failed", memberKind: "branch", branchId: "failed", readinessSequence: 1 } },
      { type: "group.member_failed", payload: { memberKey: "failed", error: { reason: "boom" } } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "active", childFrameKey: "missing", memberKind: "branch", branchId: "active", readinessSequence: 2 } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(missingChild)).toThrow("Group member 'active' references missing child frame 'missing'.");

    const aliasedOwner = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "alias", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(aliasedOwner)).toThrow("Group 'alias' has inconsistent owner key 'group'.");
  });

  it("rejects crossed child frames and member paths before cancelling a subtree", () => {
    const crossed = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", instancePath: appendNode([], "race"), strategy: "race" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "left", frameKind: "branch", parentFrameKey: "race", instancePath: appendBranch([], "race", "left") } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "left", childFrameKey: "left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "group.member_completed", payload: { memberKey: "left", completionSequence: 1 } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "right", frameKind: "branch", parentFrameKey: "race", instancePath: appendBranch([], "race", "right") } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "right", childFrameKey: "left", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(crossed)).toThrow("Group member 'right' has inconsistent child frame 'left'.");

    const wrongItemPath = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "fanout", frameKind: "node", nodeKey: "fanout", nodeId: "fanout", instancePath: appendNode([], "fanout"), strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "fanout", nodeKey: "fanout", nodeId: "fanout", kind: "fanout", strategy: "all" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "item", frameKind: "fanout_item", parentFrameKey: "fanout", instancePath: appendFanoutItem([], "fanout", 1) } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey: "item", childFrameKey: "item", memberKind: "fanout_item", itemIndex: 0, item: null, readinessSequence: 1 } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(wrongItemPath)).toThrow("Group member 'item' has inconsistent child frame 'item'.");
  });

  it("allows pathless synthetic child frames when their structural identity is exact", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "member", frameKind: "branch", parentFrameKey: "group" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "member", childFrameKey: "member", memberKind: "branch", branchId: "member", readinessSequence: 1 } },
      { type: "group.member_completed", payload: { memberKey: "member", completionSequence: 1 } },
    ]);

    expect(nextGroupCompletionBatchEvents(projection)).toEqual([
      { type: "group.completed", payload: { groupKey: "group", result: { acceptedMemberKeys: ["member"] } } },
    ]);
  });

  it("rejects open members without schedulable child state", () => {
    const missingChild = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "ghost", memberKind: "branch", branchId: "ghost", readinessSequence: 1 } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(missingChild)).toThrow("Open group member 'ghost' has no child frame or instance.");

    const terminalChild = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "member", frameKind: "branch", parentFrameKey: "group" } },
      { type: "frame.completed", payload: { frameKey: "member", result: {} } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "member", childFrameKey: "member", memberKind: "branch", branchId: "member", readinessSequence: 1 } },
    ]);
    expect(() => nextGroupCompletionBatchEvents(terminalChild)).toThrow("Open group member 'member' references non-running child frame 'member'.");
  });

  it("rejects a terminal group that still owns open work", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", strategy: "race" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "winner", memberKind: "branch", branchId: "winner", readinessSequence: 1 } },
      { type: "group.member_completed", payload: { memberKey: "winner", completionSequence: 1 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "loser", memberKind: "branch", branchId: "loser", readinessSequence: 2 } },
      { type: "group.completed", payload: { groupKey: "race", result: { acceptedMemberKeys: ["winner"] } } },
    ]);

    expect(() => nextGroupCompletionBatchEvents(projection)).toThrow("Terminal group 'race' contains open member 'loser'.");
  });

  it("rejects a terminal group whose owner contradicts its result", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "group", frameKind: "node", parentFrameKey: "root", nodeKey: "group", nodeId: "group", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "group", memberKey: "failed", memberKind: "branch", branchId: "failed", readinessSequence: 1 } },
      { type: "group.member_failed", payload: { memberKey: "failed", error: { reason: "boom" } } },
      { type: "group.failed", payload: { groupKey: "group", error: { reason: "boom" } } },
      { type: "frame.completed", payload: { frameKey: "group", result: { impossible: true } } },
    ]);

    expect(() => nextGroupCompletionBatchEvents(projection)).toThrow("Group 'group' has inconsistent owner frame 'group'.");
  });

  it("restores five thousand parent-failed dependencies through one target retry event", () => {
    const dependencyCount = 5_000;
    const retryDependencyMemberKeys = Array.from({ length: dependencyCount }, (_, index) => `item.${index}`);
    const setup: SchedulerEvent[] = [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "target", nodeId: "target", parentFrameKey: "root", instancePath: appendNode([], "target"), readinessSequence: 1 } },
      { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "retry_me" } } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "fanout", frameKind: "node", parentFrameKey: "root", nodeKey: "fanout", nodeId: "fanout", instancePath: appendNode([], "fanout") } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "fanout", nodeKey: "fanout", nodeId: "fanout", kind: "fanout", strategy: "all" } },
    ];

    for (const [index, memberKey] of retryDependencyMemberKeys.entries()) {
      const itemPath = appendFanoutItem([], "fanout", index);
      const nodeKey = `${memberKey}.task`;
      setup.push(
        { type: "frame.started", payload: { runId: "run_1", frameKey: memberKey, frameKind: "fanout_item", parentFrameKey: "fanout", instancePath: itemPath } },
        { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey, childFrameKey: memberKey, memberKind: "fanout_item", itemIndex: index, item: index, readinessSequence: index + 2 } },
        { type: "instance.ready", payload: { runId: "run_1", nodeKey, nodeId: "task", parentFrameKey: memberKey, instancePath: appendNode(itemPath, "task"), readinessSequence: index + 2 } },
        { type: "group.member_cancelled", payload: { memberKey, cancelReason: "parent_failed" } },
        { type: "instance.cancelled", payload: { nodeKey, cancelReason: "parent_failed" } },
        { type: "frame.cancelled", payload: { frameKey: memberKey, cancelReason: "parent_failed" } },
      );
    }

    const preservedPath = appendFanoutItem([], "fanout", dependencyCount);
    setup.push(
      { type: "frame.started", payload: { runId: "run_1", frameKey: "preserved", frameKind: "fanout_item", parentFrameKey: "fanout", instancePath: preservedPath } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey: "preserved", childFrameKey: "preserved", memberKind: "fanout_item", itemIndex: dependencyCount, item: "preserved", readinessSequence: dependencyCount + 2 } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "preserved.task", nodeId: "task", parentFrameKey: "preserved", instancePath: appendNode(preservedPath, "task"), readinessSequence: dependencyCount + 2 } },
      { type: "group.member_cancelled", payload: { memberKey: "preserved", cancelReason: "race_lost" } },
      { type: "instance.cancelled", payload: { nodeKey: "preserved.task", cancelReason: "race_lost" } },
      { type: "frame.cancelled", payload: { frameKey: "preserved", cancelReason: "race_lost" } },
      { type: "frame.failed", payload: { frameKey: "root", error: { reason: "retry_me" } } },
    );

    const cancelled = applySchedulerEvents(createSchedulerProjection("run_1"), setup);
    const retryEvents: SchedulerEvent[] = [{
      type: "instance.retry_requested",
      payload: { nodeKey: "target", retryDependencyMemberKeys },
    }];
    expect(retryEvents).toHaveLength(1);
    const retryEvent = retryEvents[0]!;
    expect(retryEvent).toMatchObject({ type: "instance.retry_requested", payload: { nodeKey: "target" } });
    if (retryEvent.type !== "instance.retry_requested") throw new Error("Expected one target retry event.");
    expect(retryEvent.payload.retryDependencyMemberKeys).toHaveLength(dependencyCount);

    const restored = applySchedulerEvents(cancelled, retryEvents);
    for (const index of [0, Math.floor(dependencyCount / 2), dependencyCount - 1]) {
      const memberKey = retryDependencyMemberKeys[index]!;
      expect(restored.groupMembers[memberKey]).toMatchObject({ status: "ready" });
      expect(restored.groupMembers[memberKey]?.terminalReason).toBeUndefined();
      expect(restored.frames[memberKey]).toMatchObject({ status: "running" });
      expect(restored.frames[memberKey]?.terminalReason).toBeUndefined();
      expect(restored.instances[`${memberKey}.task`]).toMatchObject({ status: "ready" });
      expect(restored.instances[`${memberKey}.task`]?.statusReason).toBeUndefined();
    }
    expect(restored.groupMembers.preserved).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
    expect(restored.frames.preserved).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
    expect(restored.instances["preserved.task"]).toMatchObject({ status: "cancelled", statusReason: "race_lost" });
  });

  it("rejects only prospective group states that cannot run the retried path", () => {
    const all = parallelGroup("all");
    expect(targetedRetryGroupAssessment(
      all,
      [branchMember("target", "failed"), branchMember("independent", "failed")],
      new Set(),
    ).blockerFor("target")).toEqual({ status: "failed", reason: "member_failed" });
    expect(targetedRetryGroupAssessment(
      all,
      [branchMember("target", "failed"), branchMember("dependency", "cancelled", { terminalReason: "parent_failed" })],
      new Set(["dependency"]),
    ).blockerFor("target")).toBeUndefined();

    expect(targetedRetryGroupAssessment(
      parallelGroup("race"),
      [branchMember("target", "failed"), branchMember("winner", "completed", { completionSequence: 1 })],
      new Set(),
    ).blockerFor("target")).toEqual({ status: "completed", reason: "group_would_complete_without_retry" });

    const quorum = fanoutQuorum(2);
    expect(targetedRetryGroupAssessment(
      quorum,
      [fanoutMember("target", 0, "failed"), fanoutMember("done", 1, "completed", { completionSequence: 1 }), fanoutMember("independent", 2, "failed")],
      new Set(),
    ).blockerFor("target")).toBeUndefined();
    expect(targetedRetryGroupAssessment(
      fanoutQuorum(3),
      [fanoutMember("target", 0, "failed"), fanoutMember("done", 1, "completed", { completionSequence: 1 }), fanoutMember("independent", 2, "failed")],
      new Set(),
    ).blockerFor("target")).toEqual({ status: "failed", reason: "quorum_impossible" });
  });

  it("preserves corruption invariants in the batched assessment", () => {
    const group = parallelGroup("race");
    const corruptCompletion = [
      branchMember("target", "failed"),
      branchMember("ordered", "completed", { completionSequence: 1 }),
      branchMember("corrupt", "completed"),
    ];
    expect(() => targetedRetryGroupAssessment(group, corruptCompletion, new Set()))
      .toThrow("Completed group member 'corrupt' is missing completion sequence.");

    const duplicateIdentity = [
      branchMember("target", "failed"),
      branchMember("target", "completed", { completionSequence: 1 }),
    ];
    expect(() => targetedRetryGroupAssessment(group, duplicateIdentity, new Set()))
      .toThrow("Retry group 'group' contains duplicate member identity 'target'.");
  });

});

function parallelGroup(strategy: "all" | "race"): GroupProjection {
  return {
    runId: "run_1",
    groupKey: "group",
    nodeKey: "group",
    nodeId: "group",
    kind: "parallel",
    strategy,
    status: "failed",
  };
}

function fanoutQuorum(quorumCount: number): GroupProjection {
  return {
    runId: "run_1",
    groupKey: "group",
    nodeKey: "group",
    nodeId: "group",
    kind: "fanout",
    strategy: "quorum",
    quorumCount,
    status: "failed",
  };
}

function branchMember(
  memberKey: string,
  status: GroupMemberStatus,
  terminal: { completionSequence?: number; terminalReason?: string } = {},
): GroupMember {
  return {
    runId: "run_1",
    groupKey: "group",
    memberKey,
    memberKind: "branch",
    branchId: memberKey,
    status,
    readinessSequence: 1,
    ...(terminal.completionSequence === undefined ? {} : { completionSequence: terminal.completionSequence }),
    ...(terminal.terminalReason === undefined ? {} : { terminalReason: terminal.terminalReason }),
  };
}

function fanoutMember(
  memberKey: string,
  itemIndex: number,
  status: GroupMemberStatus,
  terminal: { completionSequence?: number; terminalReason?: string } = {},
): GroupMember {
  return {
    runId: "run_1",
    groupKey: "group",
    memberKey,
    memberKind: "fanout_item",
    itemIndex,
    item: itemIndex,
    status,
    readinessSequence: itemIndex + 1,
    ...(terminal.completionSequence === undefined ? {} : { completionSequence: terminal.completionSequence }),
    ...(terminal.terminalReason === undefined ? {} : { terminalReason: terminal.terminalReason }),
  };
}
