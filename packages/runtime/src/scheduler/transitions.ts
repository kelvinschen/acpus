import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { isTerminalAttemptStatus, isTerminalFrameStatus, isTerminalGroupMemberStatus, isTerminalInstanceStatus, type SchedulerEvent } from "./events.js";
import type {
  FailureClass,
  GroupMember,
  GroupProjection,
  NodeInstance,
  RetryTargetStatus,
  SchedulerFrame,
  SchedulerProjection,
} from "./types.js";

export type GroupCompletion =
  | { status: "running" }
  | { status: "completed"; acceptedMemberKeys: string[]; cancelRemaining: boolean }
  | { status: "failed"; reason: string; cancelRemaining: boolean };

export type FanoutItemInput = {
  runId: string;
  groupKey: string;
  items: readonly JsonValue[];
  keyForItem?: (item: JsonValue, itemIndex: number) => string | number;
  readinessSequenceStart: number;
};

export type LoopNextStep =
  | { action: "start_iteration"; iter: number; previous?: JsonValue }
  | { action: "complete"; output: JsonValue; terminalReason: "stopped" | "exhausted_return_last" }
  | { action: "fail"; error: JsonObject; terminalReason: "loop_exhausted" };

export function signalTimeoutEvents(projection: SchedulerProjection, now: Date): SchedulerEvent[] {
  return Object.values(projection.signalWaits).flatMap(wait => {
    if (wait.status !== "awaiting" || wait.deadlineAt === undefined || wait.deadlineAt > now.toISOString()) return [];
    const instance = projection.instances[wait.nodeKey];
    return [
      { type: "signal.timed_out", payload: { nodeKey: wait.nodeKey, terminalReason: "signal_timeout" } },
      ...(instance && instance.status === "awaiting"
        ? [{ type: "instance.failed", payload: { nodeKey: wait.nodeKey, error: { reason: "signal_timeout" }, statusReason: "signal_timeout" } } satisfies SchedulerEvent]
        : []),
    ];
  });
}

export function attemptTimeoutEvents(projection: SchedulerProjection, now: Date): SchedulerEvent[] {
  return Object.values(projection.attempts).flatMap(attempt => {
    if (attempt.status !== "started" || attempt.deadlineAt === undefined || attempt.deadlineAt > now.toISOString()) return [];
    const instance = projection.instances[attempt.nodeKey];
    const member = projection.groupMembers[attempt.nodeKey];
    const error = { reason: "attempt_timeout" };
    return [
      { type: "attempt.timed_out", payload: { attemptId: attempt.attemptId, error } },
      ...(instance && (instance.status === "running" || instance.status === "awaiting")
        ? [{ type: "instance.failed", payload: { nodeKey: instance.nodeKey, error, statusReason: "timed_out" } } satisfies SchedulerEvent]
        : []),
      ...(member?.status === "running"
        ? [{ type: "group.member_failed", payload: { memberKey: member.memberKey, error, terminalReason: "timed_out" } } satisfies SchedulerEvent]
        : []),
    ];
  });
}

export function createSchedulerProjection(runId: string): SchedulerProjection {
  return {
    run: { runId, status: "pending", paused: false },
    frames: {},
    instances: {},
    attempts: {},
    groups: {},
    groupMembers: {},
    signalWaits: {},
    branchDecisions: {},
  };
}

export function applySchedulerEvent(projection: SchedulerProjection, event: SchedulerEvent): SchedulerProjection {
  const next = cloneProjection(projection);
  applyMutable(next, event);
  return next;
}

export function applySchedulerEvents(projection: SchedulerProjection, events: readonly SchedulerEvent[]): SchedulerProjection {
  return events.reduce((current, event) => applySchedulerEvent(current, event), projection);
}

export function evaluateGroupCompletion(group: GroupProjection, members: readonly GroupMember[]): GroupCompletion {
  if (group.status === "completed") return { status: "completed", acceptedMemberKeys: [], cancelRemaining: false };
  if (group.status !== "running") return { status: "failed", reason: group.error?.message as string ?? "group_not_running", cancelRemaining: false };
  if (group.strategy === "all") {
    const failed = members.find(member => member.status === "failed");
    if (failed) return { status: "failed", reason: failed.terminalReason ?? "member_failed", cancelRemaining: true };
    return members.every(member => member.status === "completed")
      ? { status: "completed", acceptedMemberKeys: members.map(member => member.memberKey), cancelRemaining: false }
      : { status: "running" };
  }
  if (group.strategy === "race") {
    const winner = members
      .filter(member => member.status === "completed")
      .sort(byCompletionSequence)[0];
    if (winner) return { status: "completed", acceptedMemberKeys: [winner.memberKey], cancelRemaining: true };
    return members.every(member => member.status === "failed" || member.status === "cancelled")
      ? { status: "failed", reason: "race_no_success", cancelRemaining: false }
      : { status: "running" };
  }
  const quorum = requirePositiveQuorum(group);
  const completed = members
    .filter(member => member.status === "completed")
    .sort(byCompletionSequence);
  if (completed.length >= quorum) {
    return {
      status: "completed",
      acceptedMemberKeys: completed.slice(0, quorum).map(member => member.memberKey),
      cancelRemaining: true,
    };
  }
  const possible = completed.length + members.filter(member => member.status === "ready" || member.status === "running").length;
  return possible < quorum
    ? { status: "failed", reason: "quorum_impossible", cancelRemaining: true }
    : { status: "running" };
}

export function groupCompletionEvents(projection: SchedulerProjection, groupKey: string): SchedulerEvent[] {
  const group = requireKey(projection.groups, groupKey, "group");
  if (group.status !== "running") return [];
  const members = Object.values(projection.groupMembers).filter(member => member.groupKey === groupKey);
  const completion = evaluateGroupCompletion(group, members);
  if (completion.status === "running") return [];
  if (completion.status === "completed") {
    const accepted = new Set(completion.acceptedMemberKeys);
    return [
      ...completion.cancelRemaining ? members
        .filter(member => !accepted.has(member.memberKey) && (member.status === "ready" || member.status === "running"))
        .flatMap(member => cancellationEventsForMember(projection, member, group.strategy === "race" ? "race_lost" : "quorum_reached")) : [],
      { type: "group.completed", payload: { groupKey, result: { acceptedMemberKeys: completion.acceptedMemberKeys } } },
    ];
  }
  return [
    ...completion.cancelRemaining ? members
      .filter(member => member.status === "ready" || member.status === "running")
      .flatMap(member => cancellationEventsForMember(projection, member, "parent_failed")) : [],
    { type: "group.failed", payload: { groupKey, error: { reason: completion.reason } } },
  ];
}

function cancellationEventsForMember(projection: SchedulerProjection, member: GroupMember, cancelReason: "parent_failed" | "race_lost" | "quorum_reached"): SchedulerEvent[] {
  const instances = memberInstances(projection, member);
  const attempts = instances.flatMap(instance =>
    Object.values(projection.attempts).filter(attempt => attempt.nodeKey === instance.nodeKey && attempt.status === "started"),
  );
  return [
    { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason } },
    ...attempts.map(attempt => ({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason } }) satisfies SchedulerEvent),
    ...instances
      .filter(instance => instance.status === "ready" || instance.status === "running" || instance.status === "awaiting")
      .map(instance => ({ type: "instance.cancelled", payload: { nodeKey: instance.nodeKey, cancelReason } }) satisfies SchedulerEvent),
  ];
}

function memberInstances(projection: SchedulerProjection, member: GroupMember): NodeInstance[] {
  const direct = projection.instances[member.memberKey];
  if (direct) return [direct];
  return Object.values(projection.instances).filter(instance => instance.parentFrameKey === member.memberKey);
}

export function materializeFanoutItems(input: FanoutItemInput): Extract<SchedulerEvent, { type: "group.member_ready" }>[] {
  const seen = new Set<string>();
  return input.items.map((item, itemIndex) => {
    const itemKey = input.keyForItem?.(item, itemIndex) ?? itemIndex;
    const normalizedKey = String(itemKey);
    if (seen.has(normalizedKey)) throw new Error(`Fanout group '${input.groupKey}' has duplicate item key '${normalizedKey}'.`);
    seen.add(normalizedKey);
    return {
      type: "group.member_ready",
      payload: {
        runId: input.runId,
        groupKey: input.groupKey,
        memberKey: `${input.groupKey}[${normalizedKey}]`,
        memberKind: "fanout_item",
        itemKey,
        itemIndex,
        readinessSequence: input.readinessSequenceStart + itemIndex,
      },
    };
  });
}

export function nextLoopStep(input: {
  iter: number;
  maxIterations: number;
  stop: boolean;
  result?: JsonValue;
  previous?: JsonValue;
  onExhausted?: "fail" | "returnLast";
}): LoopNextStep {
  if (input.stop) {
    if (input.result === undefined) throw new Error("Loop stop requires the current iteration result.");
    return { action: "complete", output: input.result, terminalReason: "stopped" };
  }
  const nextIter = input.iter + 1;
  if (nextIter < input.maxIterations) {
    return input.result === undefined
      ? { action: "start_iteration", iter: nextIter }
      : { action: "start_iteration", iter: nextIter, previous: input.result };
  }
  const lastResult = input.result ?? input.previous;
  const exhausted = loopExhaustionResult({
    maxIterations: input.maxIterations,
    ...(input.onExhausted === undefined ? {} : { onExhausted: input.onExhausted }),
    ...(lastResult === undefined ? {} : { lastResult }),
  });
  return exhausted.status === "completed"
    ? { action: "complete", output: exhausted.output, terminalReason: exhausted.terminalReason }
    : { action: "fail", error: exhausted.error, terminalReason: exhausted.terminalReason };
}

export function resolveScopedNodeKey(scopes: readonly Record<string, string>[], nodeId: string): string {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const found = scopes[index]?.[nodeId];
    if (found) return found;
  }
  throw new Error(`Node '${nodeId}' is not visible in the current execution scope.`);
}

export function retryTargetClass(status: RetryTargetStatus, failureClass?: FailureClass): "retryable" | "not_retryable" {
  return status === "failed" && failureClass !== "retryable" ? "retryable" : "not_retryable";
}

export function loopExhaustionResult(input: {
  onExhausted?: "fail" | "returnLast";
  lastResult?: JsonValue;
  maxIterations: number;
}): { status: "completed"; output: JsonValue; terminalReason: "exhausted_return_last" } | { status: "failed"; error: JsonObject; terminalReason: "loop_exhausted" } {
  if (input.onExhausted === "returnLast" && input.lastResult !== undefined) {
    return { status: "completed", output: input.lastResult, terminalReason: "exhausted_return_last" };
  }
  return {
    status: "failed",
    terminalReason: "loop_exhausted",
    error: { message: `Loop exhausted after ${input.maxIterations} iterations.` },
  };
}

function applyMutable(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (event.type === "control.run_retry_requested") {
    if (projection.run.status !== "failed") throw new Error(`Cannot retry run from ${projection.run.status}.`);
    const fresh = createSchedulerProjection(projection.run.runId);
    projection.run = fresh.run;
    projection.frames = fresh.frames;
    projection.instances = fresh.instances;
    projection.attempts = fresh.attempts;
    projection.groups = fresh.groups;
    projection.groupMembers = fresh.groupMembers;
    projection.signalWaits = fresh.signalWaits;
    projection.branchDecisions = fresh.branchDecisions;
    return;
  }
  if (event.type === "control.paused") {
    assertRunControllable(projection.run.status, "pause");
    projection.run = { ...projection.run, status: "paused", paused: true };
    return;
  }
  if (event.type === "control.resumed") {
    if (projection.run.status !== "paused") throw new Error(`Cannot resume run from ${projection.run.status}.`);
    projection.run = { ...projection.run, status: "pending", paused: false };
    return;
  }
  if (event.type === "frame.started") {
    if (projection.frames[event.payload.frameKey]) throw new Error(`Frame '${event.payload.frameKey}' already exists.`);
    projection.frames[event.payload.frameKey] = compactFrame({
      runId: event.payload.runId,
      frameKey: event.payload.frameKey,
      frameKind: event.payload.frameKind,
      status: "running",
      scope: event.payload.scope ?? {},
      ...(event.payload.instancePath === undefined ? {} : { instancePath: event.payload.instancePath }),
      ...(event.payload.parentFrameKey === undefined ? {} : { parentFrameKey: event.payload.parentFrameKey }),
      ...(event.payload.nodeKey === undefined ? {} : { nodeKey: event.payload.nodeKey }),
      ...(event.payload.nodeId === undefined ? {} : { nodeId: event.payload.nodeId }),
      ...(event.payload.strategy === undefined ? {} : { strategy: event.payload.strategy }),
    });
    return;
  }
  if (event.type === "frame.completed" || event.type === "frame.failed" || event.type === "frame.cancelled") {
    const frame = requireKey(projection.frames, event.payload.frameKey, "frame");
    assertFrameOpen(frame);
    if (event.type === "frame.completed") {
      projection.frames[event.payload.frameKey] = compactFrame({ ...frame, status: "completed", ...(event.payload.result === undefined ? {} : { result: event.payload.result }), ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
      if (event.payload.frameKey === "root") projection.run = { ...projection.run, status: "completed" };
    }
    if (event.type === "frame.failed") {
      projection.frames[event.payload.frameKey] = compactFrame({ ...frame, status: "failed", error: event.payload.error, ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
      if (event.payload.frameKey === "root") projection.run = { ...projection.run, status: "failed" };
    }
    if (event.type === "frame.cancelled") {
      projection.frames[event.payload.frameKey] = compactFrame({ ...frame, status: "cancelled", terminalReason: event.payload.cancelReason });
      if (event.payload.frameKey === "root") projection.run = { ...projection.run, status: "failed" };
    }
    return;
  }
  if (event.type === "frame.loop_advanced") {
    const frame = requireKey(projection.frames, event.payload.frameKey, "frame");
    assertFrameOpen(frame);
    if (frame.loop) {
      if (event.payload.iter < frame.loop.iter) throw new Error(`Loop frame '${frame.frameKey}' cannot move from iteration ${frame.loop.iter} back to ${event.payload.iter}.`);
      if (event.payload.iter > frame.loop.iter) {
        if (event.payload.iter !== frame.loop.iter + 1) throw new Error(`Loop frame '${frame.frameKey}' cannot skip from iteration ${frame.loop.iter} to ${event.payload.iter}.`);
        if (frame.loop.result === undefined) throw new Error(`Loop frame '${frame.frameKey}' cannot advance before iteration ${frame.loop.iter} has a result.`);
        if (stableJson(event.payload.previous) !== stableJson(frame.loop.result)) {
          throw new Error(`Loop frame '${frame.frameKey}' next previous value must match iteration ${frame.loop.iter} result.`);
        }
      }
      if (event.payload.iter === frame.loop.iter && frame.loop.result !== undefined && event.payload.result !== undefined && stableJson(frame.loop.result) !== stableJson(event.payload.result)) {
        throw new Error(`Loop frame '${frame.frameKey}' already recorded a different result for iteration ${event.payload.iter}.`);
      }
      if (event.payload.iter === frame.loop.iter && stableJson(frame.loop.previous) !== stableJson(event.payload.previous)) {
        throw new Error(`Loop frame '${frame.frameKey}' already recorded a different previous value for iteration ${event.payload.iter}.`);
      }
    }
    if (!frame.loop && event.payload.iter !== 0) throw new Error(`Loop frame '${frame.frameKey}' must start at iteration 0.`);
    const sameIter = frame.loop?.iter === event.payload.iter;
    projection.frames[event.payload.frameKey] = compactFrame({
      ...frame,
      loop: {
        iter: event.payload.iter,
        previous: event.payload.previous ?? (sameIter ? frame.loop?.previous : undefined),
        result: event.payload.result ?? (sameIter ? frame.loop?.result : undefined),
      },
    });
    return;
  }
  if (event.type === "instance.ready") {
    if (projection.instances[event.payload.nodeKey]) throw new Error(`Node instance '${event.payload.nodeKey}' already exists.`);
    projection.instances[event.payload.nodeKey] = compactInstance({
      runId: event.payload.runId,
      nodeKey: event.payload.nodeKey,
      nodeId: event.payload.nodeId,
      status: "ready",
      instancePath: event.payload.instancePath,
      ...(event.payload.parentFrameKey === undefined ? {} : { parentFrameKey: event.payload.parentFrameKey }),
      ...(event.payload.readinessSequence === undefined ? {} : { readinessSequence: event.payload.readinessSequence }),
    });
    return;
  }
  if (event.type.startsWith("instance.")) {
    applyInstanceEvent(projection, event);
    return;
  }
  if (event.type === "attempt.started") {
    if (projection.attempts[event.payload.attemptId]) throw new Error(`Attempt '${event.payload.attemptId}' already exists.`);
    projection.attempts[event.payload.attemptId] = compactAttempt({
      runId: event.payload.runId,
      attemptId: event.payload.attemptId,
      nodeKey: event.payload.nodeKey,
      nodeId: event.payload.nodeId,
      attemptNo: event.payload.attemptNo,
      ownerEpoch: event.payload.ownerEpoch,
      status: "started",
      ...(event.payload.deadlineAt === undefined ? {} : { deadlineAt: event.payload.deadlineAt }),
    });
    return;
  }
  if (event.type.startsWith("attempt.")) {
    applyAttemptEvent(projection, event);
    return;
  }
  if (event.type === "group.started") {
    if (projection.groups[event.payload.groupKey]) throw new Error(`Group '${event.payload.groupKey}' already exists.`);
    assertGroupKindStrategy(event.payload.kind, event.payload.strategy, event.payload.groupKey);
    const quorumCount = event.payload.quorumCount;
    if (event.payload.strategy === "quorum" && (typeof quorumCount !== "number" || !Number.isInteger(quorumCount) || quorumCount <= 0)) {
      throw new Error(`Quorum group '${event.payload.groupKey}' requires a positive quorum count.`);
    }
    projection.groups[event.payload.groupKey] = compactGroup({
      runId: event.payload.runId,
      groupKey: event.payload.groupKey,
      nodeKey: event.payload.nodeKey,
      nodeId: event.payload.nodeId,
      kind: event.payload.kind,
      strategy: event.payload.strategy,
      status: "running",
      ...(quorumCount === undefined ? {} : { quorumCount }),
    });
    return;
  }
  if (event.type.startsWith("group.")) {
    applyGroupEvent(projection, event);
    return;
  }
  if (event.type === "branch.decided") {
    requireKey(projection.frames, event.payload.frameKey, "frame");
    const existing = projection.branchDecisions[event.payload.frameKey];
    if (existing !== undefined && existing !== event.payload.branchId) throw new Error(`Branch decision for frame '${event.payload.frameKey}' is already '${existing}'.`);
    projection.branchDecisions[event.payload.frameKey] = event.payload.branchId;
    return;
  }
  if (event.type === "signal.awaiting" || event.type === "signal.consumed" || event.type === "signal.timed_out") applySignalEvent(projection, event);
}

function applyInstanceEvent(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (!("nodeKey" in event.payload)) return;
  const instance = requireKey(projection.instances, event.payload.nodeKey, "node instance");
  if (event.type === "instance.requeued") {
    assertInstanceRequeueable(projection, instance);
    projection.instances[event.payload.nodeKey] = compactInstance({
      ...instance,
      status: "ready",
      ...(event.payload.readinessSequence === undefined ? {} : { readinessSequence: event.payload.readinessSequence }),
      statusReason: event.payload.reason,
    });
    return;
  }
  if (event.type === "instance.retry_requested") {
    assertInstanceRetryable(instance);
    if (event.payload.source === "control") reopenForControlNodeRetry(projection, instance);
    projection.instances[event.payload.nodeKey] = compactInstance({
      runId: instance.runId,
      nodeKey: instance.nodeKey,
      nodeId: instance.nodeId,
      status: "ready",
      instancePath: instance.instancePath,
      ...(instance.parentFrameKey === undefined ? {} : { parentFrameKey: instance.parentFrameKey }),
      readinessSequence: event.payload.readinessSequence ?? instance.readinessSequence,
      statusReason: event.payload.source === "scheduler" ? "scheduler_retry" : "retry",
    });
    return;
  }
  assertInstanceOpen(instance);
  if (event.type === "instance.started") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "running" });
  if (event.type === "instance.awaiting") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "awaiting", ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
  if (event.type === "instance.completed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "completed", ...(event.payload.output === undefined ? {} : { output: event.payload.output }), ...(event.payload.acceptedAttemptId === undefined ? {} : { acceptedAttemptId: event.payload.acceptedAttemptId }) });
  if (event.type === "instance.failed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "failed", error: event.payload.error, ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
  if (event.type === "instance.cancelled") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "cancelled", statusReason: event.payload.cancelReason });
}

function applyAttemptEvent(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (!("attemptId" in event.payload)) return;
  const attempt = requireKey(projection.attempts, event.payload.attemptId, "attempt");
  assertAttemptOpen(attempt);
  if (event.type === "attempt.completed") projection.attempts[event.payload.attemptId] = compactAttempt({ ...attempt, status: "completed", ...(event.payload.result === undefined ? {} : { result: event.payload.result }) });
  if (event.type === "attempt.failed") projection.attempts[event.payload.attemptId] = compactAttempt({ ...attempt, status: "failed", error: event.payload.error, ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
  if (event.type === "attempt.timed_out") projection.attempts[event.payload.attemptId] = compactAttempt({ ...attempt, status: "timed_out", ...(event.payload.error === undefined ? {} : { error: event.payload.error }), terminalReason: "timed_out" });
  if (event.type === "attempt.cancelled") projection.attempts[event.payload.attemptId] = compactAttempt({ ...attempt, status: "cancelled", cancelReason: event.payload.cancelReason });
  if (event.type === "attempt.superseded") projection.attempts[event.payload.attemptId] = compactAttempt({ ...attempt, status: "superseded", cancelReason: event.payload.cancelReason ?? "superseded" });
}

function applyGroupEvent(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (event.type === "group.member_ready") {
    if (projection.groupMembers[event.payload.memberKey]) throw new Error(`Group member '${event.payload.memberKey}' already exists.`);
    const group = requireKey(projection.groups, event.payload.groupKey, "group");
    assertMemberKindMatchesGroup(group, event.payload.memberKind);
    projection.groupMembers[event.payload.memberKey] = {
      runId: event.payload.runId,
      groupKey: event.payload.groupKey,
      memberKey: event.payload.memberKey,
      memberKind: event.payload.memberKind,
      status: "ready",
      readinessSequence: event.payload.readinessSequence,
      ...(event.payload.branchId === undefined ? {} : { branchId: event.payload.branchId }),
      ...(event.payload.itemKey === undefined ? {} : { itemKey: event.payload.itemKey }),
      ...(event.payload.itemIndex === undefined ? {} : { itemIndex: event.payload.itemIndex }),
      ...(event.payload.item === undefined ? {} : { item: event.payload.item }),
    };
    return;
  }
  if ("memberKey" in event.payload) {
    const member = requireKey(projection.groupMembers, event.payload.memberKey, "group member");
    if (event.type === "group.member_requeued") {
      assertGroupMemberRequeueable(projection, member);
      projection.groupMembers[event.payload.memberKey] = compactMember({
        ...member,
        status: "ready",
        ...(event.payload.readinessSequence === undefined ? {} : { readinessSequence: event.payload.readinessSequence }),
      });
      return;
    }
    if (event.type === "group.member_retry_requested") {
      assertGroupMemberRetryable(member);
      if (event.payload.source === "control") reopenGroupForControlRetry(projection, member.groupKey);
      projection.groupMembers[event.payload.memberKey] = compactMember({
        runId: member.runId,
        groupKey: member.groupKey,
        memberKey: member.memberKey,
        memberKind: member.memberKind,
        status: "ready",
        readinessSequence: event.payload.readinessSequence ?? member.readinessSequence,
        ...(member.branchId === undefined ? {} : { branchId: member.branchId }),
        ...(member.itemKey === undefined ? {} : { itemKey: member.itemKey }),
        ...(member.itemIndex === undefined ? {} : { itemIndex: member.itemIndex }),
        ...(member.item === undefined ? {} : { item: member.item }),
      });
      return;
    }
    assertGroupMemberOpen(member);
    if (event.type === "group.member_started") projection.groupMembers[event.payload.memberKey] = compactMember({ ...member, status: "running" });
    if (event.type === "group.member_completed") projection.groupMembers[event.payload.memberKey] = compactMember({ ...member, status: "completed", completionSequence: event.payload.completionSequence, ...(event.payload.output === undefined ? {} : { output: event.payload.output }), ...(event.payload.acceptedRank === undefined ? {} : { acceptedRank: event.payload.acceptedRank }) });
    if (event.type === "group.member_failed") projection.groupMembers[event.payload.memberKey] = compactMember({ ...member, status: "failed", error: event.payload.error, ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
    if (event.type === "group.member_cancelled") projection.groupMembers[event.payload.memberKey] = compactMember({ ...member, status: "cancelled", terminalReason: event.payload.cancelReason });
    return;
  }
  if ("groupKey" in event.payload) {
    const group = requireKey(projection.groups, event.payload.groupKey, "group");
    assertGroupOpen(group);
    if (event.type === "group.completed") projection.groups[event.payload.groupKey] = compactGroup({ ...group, status: "completed", ...(event.payload.result === undefined ? {} : { result: event.payload.result }) });
    if (event.type === "group.failed") projection.groups[event.payload.groupKey] = compactGroup({ ...group, status: "failed", error: event.payload.error });
    if (event.type === "group.cancelled") projection.groups[event.payload.groupKey] = compactGroup({ ...group, status: "cancelled", error: { reason: event.payload.cancelReason } });
  }
}

function reopenForControlNodeRetry(projection: SchedulerProjection, instance: NodeInstance): void {
  if (projection.run.status === "failed") projection.run = { ...projection.run, status: "pending", paused: false };
  reopenFrameForControlRetry(projection, "root");
  for (let frameKey = instance.parentFrameKey; frameKey !== undefined;) {
    const frame = projection.frames[frameKey];
    if (!frame) break;
    reopenFrameForControlRetry(projection, frameKey);
    frameKey = frame.parentFrameKey;
  }
}

function reopenFrameForControlRetry(projection: SchedulerProjection, frameKey: string): void {
  const frame = projection.frames[frameKey];
  if (!frame || frame.status !== "failed") return;
  projection.frames[frameKey] = compactFrame({
    ...frame,
    status: "running",
    result: undefined,
    error: undefined,
    terminalReason: undefined,
  });
}

function reopenGroupForControlRetry(projection: SchedulerProjection, groupKey: string): void {
  const group = projection.groups[groupKey];
  if (!group || group.status !== "failed") return;
  projection.groups[groupKey] = compactGroup({
    ...group,
    status: "running",
    result: undefined,
    error: undefined,
  });
  reopenFrameForControlRetry(projection, group.nodeKey);
}

function applySignalEvent(projection: SchedulerProjection, event: Extract<SchedulerEvent, { type: "signal.awaiting" | "signal.consumed" | "signal.timed_out" }>): void {
  if (event.type === "signal.awaiting") {
    if (projection.signalWaits[event.payload.nodeKey]) throw new Error(`Signal wait '${event.payload.nodeKey}' already exists.`);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      runId: event.payload.runId,
      nodeKey: event.payload.nodeKey,
      nodeId: event.payload.nodeId,
      status: "awaiting",
      ...(event.payload.deadlineAt === undefined ? {} : { deadlineAt: event.payload.deadlineAt }),
    });
    return;
  }
  const wait = requireKey(projection.signalWaits, event.payload.nodeKey, "signal wait");
  if (event.type === "signal.consumed") {
    if (wait.status === "consumed") {
      if (wait.commandIdempotencyKey === event.payload.commandIdempotencyKey && stableJson(wait.payload) === stableJson(event.payload.payload)) return;
      throw new Error(`Signal wait '${event.payload.nodeKey}' has already consumed a different payload.`);
    }
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      ...wait,
      status: "consumed",
      payload: event.payload.payload,
      ...(event.payload.payloadDigest === undefined ? {} : { payloadDigest: event.payload.payloadDigest }),
      ...(event.payload.commandIdempotencyKey === undefined ? {} : { commandIdempotencyKey: event.payload.commandIdempotencyKey }),
    });
  }
  if (event.type === "signal.timed_out") {
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({ ...wait, status: "timed_out", ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
  }
}

function cloneProjection(projection: SchedulerProjection): SchedulerProjection {
  return {
    run: { ...projection.run },
    frames: { ...projection.frames },
    instances: { ...projection.instances },
    attempts: { ...projection.attempts },
    groups: { ...projection.groups },
    groupMembers: { ...projection.groupMembers },
    signalWaits: { ...projection.signalWaits },
    branchDecisions: { ...projection.branchDecisions },
  };
}

function requireKey<T>(values: Record<string, T>, key: string, label: string): T {
  const value = values[key];
  if (!value) throw new Error(`Unknown ${label} '${key}'.`);
  return value;
}

function byCompletionSequence(left: GroupMember, right: GroupMember): number {
  return requireCompletionSequence(left) - requireCompletionSequence(right);
}

function requireCompletionSequence(member: GroupMember): number {
  if (member.completionSequence === undefined) throw new Error(`Completed group member '${member.memberKey}' is missing completion sequence.`);
  return member.completionSequence;
}

function requirePositiveQuorum(group: GroupProjection): number {
  const quorum = group.quorumCount;
  if (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum <= 0) throw new Error(`Quorum group '${group.groupKey}' requires a positive quorum count.`);
  return quorum;
}

function assertFrameOpen(frame: SchedulerFrame): void {
  if (isTerminalFrameStatus(frame.status)) throw new Error(`Frame '${frame.frameKey}' is already ${frame.status}.`);
}

function assertInstanceOpen(instance: NodeInstance): void {
  if (isTerminalInstanceStatus(instance.status)) throw new Error(`Node instance '${instance.nodeKey}' is already ${instance.status}.`);
}

function assertInstanceRequeueable(projection: SchedulerProjection, instance: NodeInstance): void {
  if (instance.status !== "running" && instance.status !== "awaiting") throw new Error(`Node instance '${instance.nodeKey}' cannot be requeued from ${instance.status}.`);
  assertNoStartedAttemptForNode(projection, instance.nodeKey);
  if (projection.signalWaits[instance.nodeKey]?.status === "awaiting") {
    throw new Error(`Node instance '${instance.nodeKey}' cannot be requeued while a signal wait is awaiting.`);
  }
}

function assertInstanceRetryable(instance: NodeInstance): void {
  if (instance.status !== "failed") throw new Error(`Node instance '${instance.nodeKey}' cannot be retried from ${instance.status}.`);
}

function assertAttemptOpen(attempt: SchedulerProjection["attempts"][string]): void {
  if (isTerminalAttemptStatus(attempt.status)) throw new Error(`Attempt '${attempt.attemptId}' is already ${attempt.status}.`);
}

function assertGroupOpen(group: GroupProjection): void {
  if (group.status !== "running") throw new Error(`Group '${group.groupKey}' is already ${group.status}.`);
}

function assertGroupMemberOpen(member: GroupMember): void {
  if (isTerminalGroupMemberStatus(member.status)) throw new Error(`Group member '${member.memberKey}' is already ${member.status}.`);
}

function assertGroupMemberRequeueable(projection: SchedulerProjection, member: GroupMember): void {
  if (member.status !== "running") throw new Error(`Group member '${member.memberKey}' cannot be requeued from ${member.status}.`);
  assertNoStartedAttemptForNode(projection, member.memberKey);
}

function assertGroupMemberRetryable(member: GroupMember): void {
  if (member.status !== "failed") throw new Error(`Group member '${member.memberKey}' cannot be retried from ${member.status}.`);
}

function assertNoStartedAttemptForNode(projection: SchedulerProjection, nodeKey: string): void {
  if (Object.values(projection.attempts).some(attempt => attempt.nodeKey === nodeKey && attempt.status === "started")) {
    throw new Error(`Node instance '${nodeKey}' cannot be requeued while an attempt is still started.`);
  }
}

function assertSignalOpen(status: SchedulerProjection["signalWaits"][string]["status"], nodeKey: string): void {
  if (status !== "awaiting") throw new Error(`Signal wait '${nodeKey}' is already ${status}.`);
}

function assertRunControllable(status: SchedulerProjection["run"]["status"], action: string): void {
  if (status === "completed" || status === "failed") throw new Error(`Cannot ${action} ${status} run.`);
}

function assertGroupKindStrategy(kind: GroupProjection["kind"], strategy: GroupProjection["strategy"], groupKey: string): void {
  if (kind === "parallel" && strategy !== "all" && strategy !== "race") throw new Error(`Parallel group '${groupKey}' does not support ${strategy}.`);
  if (kind === "fanout" && strategy !== "all" && strategy !== "quorum") throw new Error(`Fanout group '${groupKey}' does not support ${strategy}.`);
}

function assertMemberKindMatchesGroup(group: GroupProjection, memberKind: GroupMember["memberKind"]): void {
  if (group.kind === "parallel" && memberKind !== "branch") throw new Error(`Parallel group '${group.groupKey}' requires branch members.`);
  if (group.kind === "fanout" && memberKind !== "fanout_item") throw new Error(`Fanout group '${group.groupKey}' requires fanout item members.`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => [key, sortJson(field)]));
}

function compactFrame(frame: object): SchedulerFrame {
  return dropUndefined(frame) as SchedulerFrame;
}

function compactInstance(instance: object): NodeInstance {
  return dropUndefined(instance) as NodeInstance;
}

function compactAttempt(attempt: object): SchedulerProjection["attempts"][string] {
  return dropUndefined(attempt) as SchedulerProjection["attempts"][string];
}

function compactGroup(group: object): GroupProjection {
  return dropUndefined(group) as GroupProjection;
}

function compactMember(member: object): GroupMember {
  return dropUndefined(member) as GroupMember;
}

function compactSignalWait(wait: object): SchedulerProjection["signalWaits"][string] {
  return dropUndefined(wait) as SchedulerProjection["signalWaits"][string];
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
