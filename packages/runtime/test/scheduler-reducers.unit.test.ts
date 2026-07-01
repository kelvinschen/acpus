import { describe, expect, it } from "vitest";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, canonicalPath, deriveInstanceKey } from "../src/scheduler/identity.js";
import { applySchedulerEvents, attemptTimeoutEvents, createSchedulerProjection, evaluateGroupCompletion, groupCompletionEvents, loopExhaustionResult, materializeFanoutItems, nextLoopStep, resolveScopedNodeKey, retryTargetClass, signalTimeoutEvents } from "../src/scheduler/transitions.js";
import type { GroupMember, GroupProjection } from "../src/scheduler/types.js";

describe("scheduler identity and reducers", () => {
  it("derives stable readable keys from structured instance paths", () => {
    const path = appendNode(
      appendLoopIteration(
        appendFanoutItem([], "items", "pkg/a", 0),
        "retry",
        2,
      ),
      "check",
    );

    expect(deriveInstanceKey(path)).toMatch(/^items\[pkg_a\]\/retry#2\/check~[a-f0-9]{12}$/);
    expect(deriveInstanceKey(path)).toBe(deriveInstanceKey(JSON.parse(canonicalPath(path))));
    expect(deriveInstanceKey(appendBranch([], "race", "left"))).toMatch(/^race\.left~[a-f0-9]{12}$/);
  });

  it("rebuilds frame, instance, attempt, group, branch, and signal projections from events", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "control.paused", payload: { reason: "user" } },
      { type: "control.resumed", payload: {} },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { prepare: "prepare~1" } } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "prepare~1", nodeId: "prepare", instancePath: appendNode([], "prepare"), parentFrameKey: "root", readinessSequence: 1 } },
      { type: "instance.started", payload: { nodeKey: "prepare~1" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "prepare~1", nodeId: "prepare", attemptNo: 1, ownerEpoch: 7, deadlineAt: "2026-06-30T00:00:00.000Z" } },
      { type: "attempt.completed", payload: { attemptId: "attempt_1", result: { ok: true } } },
      { type: "instance.completed", payload: { nodeKey: "prepare~1", output: { ok: true }, acceptedAttemptId: "attempt_1" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "race~1", nodeKey: "race~1", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race~1", memberKey: "race.left", memberKind: "branch", branchId: "left", readinessSequence: 2 } },
      { type: "group.member_completed", payload: { memberKey: "race.left", completionSequence: 8, output: { value: "left" }, acceptedRank: 1 } },
      { type: "group.completed", payload: { groupKey: "race~1", result: { winner: "left" } } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "if~1", frameKind: "node", nodeKey: "if~1", nodeId: "if" } },
      { type: "branch.decided", payload: { frameKey: "if~1", branchId: "then" } },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop~1", frameKind: "loop", nodeKey: "loop~1", nodeId: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 0, result: { done: false, iter: 0 } } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 1, previous: { done: false, iter: 0 }, result: { done: false } } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 2, previous: { done: false }, result: { done: true } } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", deadlineAt: "2026-06-30T01:00:00.000Z" } },
      { type: "signal.consumed", payload: { nodeKey: "approve~1", payload: { ok: true }, payloadDigest: "sha256:1", commandIdempotencyKey: "signal-1" } },
    ]);

    expect(projection.run).toEqual({ runId: "run_1", status: "pending", paused: false });
    expect(projection.frames.root).toMatchObject({ frameKind: "root", status: "running", scope: { prepare: "prepare~1" } });
    expect(projection.instances["prepare~1"]).toMatchObject({ status: "completed", output: { ok: true }, acceptedAttemptId: "attempt_1" });
    expect(projection.attempts.attempt_1).toMatchObject({ status: "completed", result: { ok: true }, ownerEpoch: 7 });
    expect(projection.groups["race~1"]).toMatchObject({ status: "completed", result: { winner: "left" } });
    expect(projection.groupMembers["race.left"]).toMatchObject({ status: "completed", acceptedRank: 1 });
    expect(projection.branchDecisions["if~1"]).toBe("then");
    expect(projection.frames["loop~1"]).toMatchObject({ loop: { iter: 2, previous: { done: false }, result: { done: true } } });
    expect(projection.signalWaits["approve~1"]).toMatchObject({ status: "consumed", payload: { ok: true }, commandIdempotencyKey: "signal-1" });
  });

  it("derives scheduler run terminal status from the root frame", () => {
    expect(applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
      { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
    ]).run).toMatchObject({ status: "completed" });

    expect(applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
      { type: "frame.failed", payload: { frameKey: "root", error: { reason: "bad" }, terminalReason: "root_failed" } },
    ]).run).toMatchObject({ status: "failed" });

    expect(applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } },
    ]).run).toMatchObject({ status: "failed" });
  });

  it("resets failed run projection for run-level retry without preserving stale dynamic state", () => {
    const retried = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root", scope: { fail: "fail~1" } } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "fail~1", nodeId: "fail", instancePath: appendNode([], "fail") } },
      { type: "instance.failed", payload: { nodeKey: "fail~1", error: { reason: "boom" } } },
      { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
      { type: "control.run_retry_requested", payload: {} },
      { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
    ]);

    expect(retried.run).toEqual({ runId: "run_1", status: "pending", paused: false });
    expect(retried.frames.root).toMatchObject({ frameKind: "root", status: "running" });
    expect(retried.instances).toEqual({});

    expect(() => applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "control.run_retry_requested", payload: {} },
    ])).toThrow("Cannot retry run from pending.");
  });

  it("rejects terminal-state regressions and non-idempotent signal replacement", () => {
    const completed = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "node~1", nodeId: "node", instancePath: appendNode([], "node") } },
      { type: "instance.completed", payload: { nodeKey: "node~1", output: { ok: true } } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "node~1", nodeId: "node", attemptNo: 1, ownerEpoch: 1 } },
      { type: "attempt.completed", payload: { attemptId: "attempt_1", result: { ok: true } } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve" } },
      { type: "signal.consumed", payload: { nodeKey: "approve~1", payload: { ok: true }, commandIdempotencyKey: "signal-1" } },
    ]);

    expect(() => applySchedulerEvents(completed, [
      { type: "instance.started", payload: { nodeKey: "node~1" } },
    ])).toThrow("Node instance 'node~1' is already completed.");
    expect(() => applySchedulerEvents(completed, [
      { type: "attempt.failed", payload: { attemptId: "attempt_1", error: { message: "late" } } },
    ])).toThrow("Attempt 'attempt_1' is already completed.");
    expect(applySchedulerEvents(completed, [
      { type: "signal.consumed", payload: { nodeKey: "approve~1", payload: { ok: true }, commandIdempotencyKey: "signal-1" } },
    ])).toMatchObject({ signalWaits: { "approve~1": { payload: { ok: true } } } });
    expect(() => applySchedulerEvents(completed, [
      { type: "signal.consumed", payload: { nodeKey: "approve~1", payload: { ok: false }, commandIdempotencyKey: "signal-2" } },
    ])).toThrow("already consumed a different payload");
  });

  it("keeps run controls, branch decisions, and loop progress monotonic", () => {
    const terminalRun = createSchedulerProjection("run_1");
    terminalRun.run = { ...terminalRun.run, status: "completed" };
    expect(() => applySchedulerEvents(terminalRun, [
      { type: "control.paused", payload: { reason: "late" } },
    ])).toThrow("Cannot pause completed run.");
    expect(() => applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "control.resumed", payload: {} },
    ])).toThrow("Cannot resume run from pending.");

    const decided = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "if~1", frameKind: "node" } },
      { type: "branch.decided", payload: { frameKey: "if~1", branchId: "then" } },
    ]);
    expect(applySchedulerEvents(decided, [
      { type: "branch.decided", payload: { frameKey: "if~1", branchId: "then" } },
    ]).branchDecisions["if~1"]).toBe("then");
    expect(() => applySchedulerEvents(decided, [
      { type: "branch.decided", payload: { frameKey: "if~1", branchId: "else" } },
    ])).toThrow("Branch decision for frame 'if~1' is already 'then'.");
    expect(() => applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "branch.decided", payload: { frameKey: "missing", branchId: "then" } },
    ])).toThrow("Unknown frame 'missing'.");

    const loop = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop~1", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 0, result: { done: false, iter: 0 } } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 1, previous: { done: false, iter: 0 }, result: { done: false, iter: 1 } } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 2, previous: { done: false, iter: 1 }, result: { done: true } } },
    ]);
    expect(() => applySchedulerEvents(loop, [
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 1, result: { done: false } } },
    ])).toThrow("cannot move from iteration 2 back to 1");
    expect(() => applySchedulerEvents(loop, [
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 2, result: { done: false } } },
    ])).toThrow("already recorded a different result");
    expect(() => applySchedulerEvents(loop, [
      { type: "frame.loop_advanced", payload: { frameKey: "loop~1", iter: 2, previous: { changed: true }, result: { done: true } } },
    ])).toThrow("already recorded a different previous value");
    expect(() => applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop~2", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop~2", iter: 2, result: { done: true } } },
    ])).toThrow("must start at iteration 0");
  });

  it("retries only failed dynamic instances and direct group members", () => {
    const failedNode = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "node~1", nodeId: "node", instancePath: appendNode([], "node"), readinessSequence: 4 } },
      { type: "instance.failed", payload: { nodeKey: "node~1", error: { reason: "boom" }, statusReason: "terminal" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "parallel~1", memberKey: "branch~1", memberKind: "branch", branchId: "left", readinessSequence: 5 } },
      { type: "group.member_failed", payload: { memberKey: "branch~1", error: { reason: "boom" } } },
    ]);
    const retried = applySchedulerEvents(failedNode, [
      { type: "instance.retry_requested", payload: { nodeKey: "node~1" } },
      { type: "group.member_retry_requested", payload: { memberKey: "branch~1" } },
    ]);
    const retriedNode = retried.instances["node~1"];
    const retriedMember = retried.groupMembers["branch~1"];
    expect(retriedNode).toMatchObject({ status: "ready", readinessSequence: 4, statusReason: "retry" });
    expect(retriedNode?.error).toBeUndefined();
    expect(retriedMember).toMatchObject({ status: "ready", readinessSequence: 5 });
    expect(retriedMember?.error).toBeUndefined();
    expect(() => applySchedulerEvents(retried, [
      { type: "instance.retry_requested", payload: { nodeKey: "node~1" } },
    ])).toThrow("cannot be retried from ready");
  });

  it("records cancellation, superseded attempts, and signal timeout reasons", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "frame.started", payload: { runId: "run_1", frameKey: "frame~1", frameKind: "branch" } },
      { type: "frame.cancelled", payload: { frameKey: "frame~1", cancelReason: "race_lost" } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "node~1", nodeId: "node", instancePath: appendNode([], "node") } },
      { type: "instance.cancelled", payload: { nodeKey: "node~1", cancelReason: "parent_failed" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "node~1", nodeId: "node", attemptNo: 1, ownerEpoch: 1 } },
      { type: "attempt.superseded", payload: { attemptId: "attempt_1" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "race~1", nodeKey: "race~1", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race~1", memberKey: "race.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "group.member_cancelled", payload: { memberKey: "race.left", cancelReason: "race_lost" } },
      { type: "group.cancelled", payload: { groupKey: "race~1", cancelReason: "paused" } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve" } },
      { type: "signal.timed_out", payload: { nodeKey: "approve~1", terminalReason: "timeout_fail" } },
    ]);

    expect(projection.frames["frame~1"]).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
    expect(projection.instances["node~1"]).toMatchObject({ status: "cancelled", statusReason: "parent_failed" });
    expect(projection.attempts.attempt_1).toMatchObject({ status: "superseded", cancelReason: "superseded" });
    expect(projection.groupMembers["race.left"]).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
    expect(projection.groups["race~1"]).toMatchObject({ status: "cancelled", error: { reason: "paused" } });
    expect(projection.signalWaits["approve~1"]).toMatchObject({ status: "timed_out", terminalReason: "timeout_fail" });
  });

  it("requeues active instances and group members for pause without reopening terminals", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "node~1", nodeId: "node", instancePath: appendNode([], "node"), readinessSequence: 1 } },
      { type: "instance.started", payload: { nodeKey: "node~1" } },
      { type: "instance.requeued", payload: { nodeKey: "node~1", reason: "paused", readinessSequence: 9 } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "parallel~1", memberKey: "parallel.left", memberKind: "branch", branchId: "left", readinessSequence: 2 } },
      { type: "group.member_started", payload: { memberKey: "parallel.left" } },
      { type: "group.member_requeued", payload: { memberKey: "parallel.left", reason: "paused", readinessSequence: 10 } },
    ]);

    expect(projection.instances["node~1"]).toMatchObject({ status: "ready", readinessSequence: 9, statusReason: "paused" });
    expect(projection.groupMembers["parallel.left"]).toMatchObject({ status: "ready", readinessSequence: 10 });

    const completed = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "done~1", nodeId: "done", instancePath: appendNode([], "done") } },
      { type: "instance.completed", payload: { nodeKey: "done~1" } },
    ]);
    expect(() => applySchedulerEvents(completed, [
      { type: "instance.requeued", payload: { nodeKey: "done~1", reason: "paused" } },
    ])).toThrow("cannot be requeued from completed");

    const stillStarted = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "busy~1", nodeId: "busy", instancePath: appendNode([], "busy") } },
      { type: "instance.started", payload: { nodeKey: "busy~1" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_busy", nodeKey: "busy~1", nodeId: "busy", attemptNo: 1, ownerEpoch: 1 } },
    ]);
    expect(() => applySchedulerEvents(stillStarted, [
      { type: "instance.requeued", payload: { nodeKey: "busy~1", reason: "paused" } },
    ])).toThrow("cannot be requeued while an attempt is still started");

    const awaitingSignal = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", instancePath: appendNode([], "approve") } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve" } },
    ]);
    expect(() => applySchedulerEvents(awaitingSignal, [
      { type: "instance.requeued", payload: { nodeKey: "approve~1", reason: "paused" } },
    ])).toThrow("cannot be requeued while a signal wait is awaiting");
  });

  it("derives signal timeout events from durable deadlines", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", instancePath: appendNode([], "approve") } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", deadlineAt: "2026-06-30T00:00:00.000Z" } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "later~1", nodeId: "later", deadlineAt: "2026-07-01T00:00:00.000Z" } },
      { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: "done~1", nodeId: "done", deadlineAt: "2026-06-29T00:00:00.000Z" } },
      { type: "signal.consumed", payload: { nodeKey: "done~1", payload: { ok: true }, commandIdempotencyKey: "signal-done" } },
    ]);

    expect(signalTimeoutEvents(projection, new Date("2026-06-30T00:00:01.000Z"))).toEqual([
      { type: "signal.timed_out", payload: { nodeKey: "approve~1", terminalReason: "signal_timeout" } },
      { type: "instance.failed", payload: { nodeKey: "approve~1", error: { reason: "signal_timeout" }, statusReason: "signal_timeout" } },
    ]);
  });

  it("derives attempt timeout events from durable deadlines", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "parallel~1", memberKey: "task~1", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "task~1" } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "task~1", nodeId: "task", instancePath: appendNode([], "task"), readinessSequence: 1 } },
      { type: "instance.started", payload: { nodeKey: "task~1" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "task~1", nodeId: "task", attemptNo: 1, ownerEpoch: 1, deadlineAt: "2026-06-30T00:00:00.000Z" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_later", nodeKey: "later~1", nodeId: "later", attemptNo: 1, ownerEpoch: 1, deadlineAt: "2026-07-01T00:00:00.000Z" } },
    ]);

    expect(attemptTimeoutEvents(projection, new Date("2026-06-30T00:00:01.000Z"))).toEqual([
      { type: "attempt.timed_out", payload: { attemptId: "attempt_1", error: { reason: "attempt_timeout" } } },
      { type: "instance.failed", payload: { nodeKey: "task~1", error: { reason: "attempt_timeout" }, statusReason: "timed_out" } },
      { type: "group.member_failed", payload: { memberKey: "task~1", error: { reason: "attempt_timeout" }, terminalReason: "timed_out" } },
    ]);
  });

  it("rejects group members that do not match the owning group kind", () => {
    const fanout = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "fanout~1", nodeKey: "fanout~1", nodeId: "fanout", kind: "fanout", strategy: "quorum", quorumCount: 1 } },
    ]);
    expect(() => applySchedulerEvents(fanout, [
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout~1", memberKey: "bad.branch", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
    ])).toThrow("Fanout group 'fanout~1' requires fanout item members.");

    const parallel = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "race" } },
    ]);
    expect(() => applySchedulerEvents(parallel, [
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "parallel~1", memberKey: "bad.item", memberKind: "fanout_item", itemKey: "a", itemIndex: 0, readinessSequence: 1 } },
    ])).toThrow("Parallel group 'parallel~1' requires branch members.");
  });

  it("computes all, race, and quorum group terminal behavior", () => {
    expect(evaluateGroupCompletion(group("all"), [
      member("left", "completed", 1),
      member("right", "ready", 2),
    ])).toEqual({ status: "running" });
    expect(evaluateGroupCompletion(group("all"), [
      member("left", "failed", 1),
      member("right", "running", 2),
    ])).toEqual({ status: "failed", reason: "member_failed", cancelRemaining: true });

    expect(evaluateGroupCompletion(group("race"), [
      member("left", "failed", 1),
      member("right", "completed", 2, undefined, 1),
    ])).toEqual({ status: "completed", acceptedMemberKeys: ["right"], cancelRemaining: true });
    expect(evaluateGroupCompletion(group("race"), [
      member("left", "failed", 1),
      member("right", "cancelled", 2),
    ])).toEqual({ status: "failed", reason: "race_no_success", cancelRemaining: false });

    expect(evaluateGroupCompletion(group("quorum", 2), [
      member("a", "completed", 1, undefined, 20, "fanout_item"),
      member("b", "running", 2, undefined, undefined, "fanout_item"),
      member("c", "completed", 3, undefined, 10, "fanout_item"),
    ])).toEqual({ status: "completed", acceptedMemberKeys: ["c", "a"], cancelRemaining: true });
    expect(evaluateGroupCompletion(group("quorum", 2), [
      member("a", "completed", 1, undefined, 1, "fanout_item"),
      member("b", "failed", 2, undefined, undefined, "fanout_item"),
      member("c", "cancelled", 3, undefined, undefined, "fanout_item"),
    ])).toEqual({ status: "failed", reason: "quorum_impossible", cancelRemaining: true });
    const invalidQuorum = {
      runId: "run_1",
      groupKey: "fanout~1",
      nodeKey: "fanout~1",
      nodeId: "fanout",
      kind: "fanout",
      strategy: "quorum",
      quorumCount: 0,
      status: "running",
    } satisfies Extract<GroupProjection, { kind: "fanout" }>;
    expect(() => evaluateGroupCompletion({ ...invalidQuorum, quorumCount: 0 }, [])).toThrow("requires a positive quorum count");
  });

  it("derives composite terminal and cancellation events from group state", () => {
    const all = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "all", memberKey: "all.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "group.member_failed", payload: { memberKey: "all.left", error: { reason: "boom" }, terminalReason: "branch_failed" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "all", memberKey: "all.right", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
      { type: "group.member_started", payload: { memberKey: "all.right" } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "all.right", nodeId: "right", instancePath: appendBranch([], "all", "right"), readinessSequence: 2 } },
      { type: "instance.started", payload: { nodeKey: "all.right" } },
    ]);
    expect(groupCompletionEvents(all, "all")).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "all.right", cancelReason: "parent_failed" } },
      { type: "instance.cancelled", payload: { nodeKey: "all.right", cancelReason: "parent_failed" } },
      { type: "group.failed", payload: { groupKey: "all", error: { reason: "branch_failed" } } },
    ]);

    const race = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "race.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "race.left" } },
      { type: "group.member_completed", payload: { memberKey: "race.left", completionSequence: 5, output: { ok: true } } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "race.right", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
      { type: "group.member_started", payload: { memberKey: "race.right" } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "race.right", nodeId: "right", instancePath: appendBranch([], "race", "right"), readinessSequence: 2 } },
      { type: "instance.started", payload: { nodeKey: "race.right" } },
    ]);
    expect(groupCompletionEvents(race, "race")).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "race.right", cancelReason: "race_lost" } },
      { type: "instance.cancelled", payload: { nodeKey: "race.right", cancelReason: "race_lost" } },
      { type: "group.completed", payload: { groupKey: "race", result: { acceptedMemberKeys: ["race.left"] } } },
    ]);

    const quorum = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "quorum", nodeKey: "quorum", nodeId: "quorum", kind: "fanout", strategy: "quorum", quorumCount: 2 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "quorum", memberKey: "quorum[0]", memberKind: "fanout_item", itemIndex: 0, readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "quorum[0]" } },
      { type: "group.member_completed", payload: { memberKey: "quorum[0]", completionSequence: 20 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "quorum", memberKey: "quorum[1]", memberKind: "fanout_item", itemIndex: 1, readinessSequence: 2 } },
      { type: "group.member_started", payload: { memberKey: "quorum[1]" } },
      { type: "group.member_completed", payload: { memberKey: "quorum[1]", completionSequence: 10 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "quorum", memberKey: "quorum[2]", memberKind: "fanout_item", itemIndex: 2, readinessSequence: 3 } },
      { type: "instance.ready", payload: { runId: "run_1", nodeKey: "quorum[2]", nodeId: "item", instancePath: appendFanoutItem([], "quorum", 2, 2), readinessSequence: 3 } },
    ]);
    expect(groupCompletionEvents(quorum, "quorum")).toEqual([
      { type: "group.member_cancelled", payload: { memberKey: "quorum[2]", cancelReason: "quorum_reached" } },
      { type: "instance.cancelled", payload: { nodeKey: "quorum[2]", cancelReason: "quorum_reached" } },
      { type: "group.completed", payload: { groupKey: "quorum", result: { acceptedMemberKeys: ["quorum[1]", "quorum[0]"] } } },
    ]);
  });

  it("materializes fanout item members with duplicate-key checks", () => {
    expect(materializeFanoutItems({
      runId: "run_1",
      groupKey: "items",
      items: [{ id: "a" }, { id: "b" }],
      keyForItem: item => (item as { id: string }).id,
      readinessSequenceStart: 10,
    }).map(event => event.payload)).toEqual([
      { runId: "run_1", groupKey: "items", memberKey: "items[a]", memberKind: "fanout_item", itemKey: "a", itemIndex: 0, readinessSequence: 10 },
      { runId: "run_1", groupKey: "items", memberKey: "items[b]", memberKind: "fanout_item", itemKey: "b", itemIndex: 1, readinessSequence: 11 },
    ]);

    expect(() => materializeFanoutItems({
      runId: "run_1",
      groupKey: "items",
      items: [{ id: "a" }, { id: "a" }],
      keyForItem: item => (item as { id: string }).id,
      readinessSequenceStart: 1,
    })).toThrow("duplicate item key 'a'");
  });

  it("resolves lexical node scope from the innermost dynamic mapping", () => {
    expect(resolveScopedNodeKey([
      { prepare: "prepare~root", shared: "shared~outer" },
      { shared: "shared~inner" },
    ], "shared")).toBe("shared~inner");

    expect(() => resolveScopedNodeKey([{ prepare: "prepare~root" }], "missing")).toThrow("Node 'missing' is not visible");
  });

  it("classifies loop exhaustion and command retry targets", () => {
    expect(nextLoopStep({ iter: 0, maxIterations: 3, stop: false, result: { iter: 0 } })).toEqual({
      action: "start_iteration",
      iter: 1,
      previous: { iter: 0 },
    });
    expect(nextLoopStep({ iter: 1, maxIterations: 3, stop: true, result: { done: true } })).toEqual({
      action: "complete",
      output: { done: true },
      terminalReason: "stopped",
    });
    expect(nextLoopStep({ iter: 2, maxIterations: 3, stop: false, result: { last: true }, onExhausted: "returnLast" })).toEqual({
      action: "complete",
      output: { last: true },
      terminalReason: "exhausted_return_last",
    });
    expect(nextLoopStep({ iter: 2, maxIterations: 3, stop: false })).toEqual({
      action: "fail",
      error: { message: "Loop exhausted after 3 iterations." },
      terminalReason: "loop_exhausted",
    });
    expect(loopExhaustionResult({ maxIterations: 3, onExhausted: "returnLast", lastResult: { ok: true } })).toEqual({
      status: "completed",
      output: { ok: true },
      terminalReason: "exhausted_return_last",
    });
    expect(loopExhaustionResult({ maxIterations: 3 })).toEqual({
      status: "failed",
      terminalReason: "loop_exhausted",
      error: { message: "Loop exhausted after 3 iterations." },
    });
    expect(retryTargetClass("failed", "terminal")).toBe("retryable");
    expect(retryTargetClass("failed", "retryable")).toBe("not_retryable");
    expect(retryTargetClass("completed")).toBe("not_retryable");
  });
});

function group(strategy: "all" | "race" | "quorum", quorumCount?: number): GroupProjection {
  if (strategy === "quorum") {
    return {
      runId: "run_1",
      groupKey: "fanout~1",
      nodeKey: "fanout~1",
      nodeId: "fanout",
      kind: "fanout",
      strategy: "quorum",
      quorumCount: quorumCount ?? 1,
      status: "running",
    };
  }
  return {
    runId: "run_1",
    groupKey: `${strategy}~1`,
    nodeKey: `${strategy}~1`,
    nodeId: strategy,
    kind: "parallel",
    strategy,
    status: "running",
  };
}

function member(memberKey: string, status: GroupMember["status"], readinessSequence: number, acceptedRank?: number, completionSequence?: number, memberKind: GroupMember["memberKind"] = "branch"): GroupMember {
  return {
    runId: "run_1",
    groupKey: "group~1",
    memberKey,
    memberKind,
    status,
    readinessSequence,
    ...(acceptedRank === undefined ? {} : { acceptedRank }),
    ...(completionSequence === undefined ? {} : { completionSequence }),
  };
}
