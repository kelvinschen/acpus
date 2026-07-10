import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { isTerminalAttemptStatus, isTerminalFrameStatus, isTerminalGroupMemberStatus, isTerminalInstanceStatus, type SchedulerEvent } from "./events.js";
import { ancestorGroupMembersForNode, descendantFramesForFrame, descendantFramesForMember, descendantGroupKeysForFrame, descendantGroupKeysForMember, descendantGroupMembersForFrame, descendantGroupMembersForMember, descendantInstancesForFrame, descendantInstancesForMember } from "./membership.js";
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

export type LoopNextStep =
  | { action: "start_iteration"; iter: number; state?: JsonValue }
  | { action: "complete"; output: JsonValue; terminalReason: "stopped" }
  | { action: "fail"; error: JsonObject; terminalReason: "invalid_loop_transition" };

export type TimestampedSchedulerEvent = {
  event: SchedulerEvent;
  createdAt: string;
};

export type SchedulerProjectionTiming = {
  createdAt: string;
  updatedAt: string;
};

export type SchedulerProjectionTimings = {
  frame: Map<string, SchedulerProjectionTiming>;
  instance: Map<string, SchedulerProjectionTiming>;
  attempt: Map<string, SchedulerProjectionTiming>;
  member: Map<string, SchedulerProjectionTiming>;
  signal: Map<string, SchedulerProjectionTiming>;
};

export function signalTimeoutEvents(projection: SchedulerProjection, now: Date): SchedulerEvent[] {
  if (projection.run.status === "paused") return [];
  return Object.values(projection.signalWaits).flatMap(wait => {
    if (wait.status !== "awaiting" || wait.deadlineAt === undefined || wait.deadlineAt > now.toISOString()) return [];
    const instance = projection.instances[wait.nodeKey];
    const error = {
      reason: "signal_timeout",
      ...(wait.timeoutMessage === undefined ? {} : { message: wait.timeoutMessage }),
    };
    const members = ancestorGroupMembersForNode(projection, wait.nodeKey).filter(member => member.status === "running");
    return [
      { type: "signal.timed_out", payload: { nodeKey: wait.nodeKey, terminalReason: "signal_timeout", ...(wait.timeoutMessage === undefined ? {} : { message: wait.timeoutMessage }) } },
      ...(instance && instance.status === "awaiting"
        ? [{ type: "instance.failed", payload: { nodeKey: wait.nodeKey, error, statusReason: "signal_timeout" } } satisfies SchedulerEvent]
        : []),
      ...members.map(member => ({ type: "group.member_failed", payload: { memberKey: member.memberKey, error, terminalReason: "signal_timeout" } }) satisfies SchedulerEvent),
    ];
  });
}

export function attemptTimeoutEvents(projection: SchedulerProjection, now: Date): SchedulerEvent[] {
  return Object.values(projection.attempts).flatMap(attempt => {
    if (attempt.status !== "started" || attempt.deadlineAt === undefined || attempt.deadlineAt > now.toISOString()) return [];
    const instance = projection.instances[attempt.nodeKey];
    const members = ancestorGroupMembersForNode(projection, attempt.nodeKey).filter(member => member.status === "running");
    const error = { reason: "attempt_timeout" };
    return [
      { type: "attempt.timed_out", payload: { attemptId: attempt.attemptId, error } },
      ...(instance && (instance.status === "running" || instance.status === "awaiting")
        ? [{ type: "instance.failed", payload: { nodeKey: instance.nodeKey, error, statusReason: "timed_out" } } satisfies SchedulerEvent]
        : []),
      ...members.map(member => ({ type: "group.member_failed", payload: { memberKey: member.memberKey, error, terminalReason: "timed_out" } }) satisfies SchedulerEvent),
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

export function applyTimestampedSchedulerEvents(runId: string, events: readonly TimestampedSchedulerEvent[]): { projection: SchedulerProjection; timings: SchedulerProjectionTimings } {
  let projection = createSchedulerProjection(runId);
  const timings: SchedulerProjectionTimings = {
    frame: new Map(),
    instance: new Map(),
    attempt: new Map(),
    member: new Map(),
    signal: new Map(),
  };
  for (const item of events) {
    const next = applySchedulerEvent(projection, item.event);
    syncTimingMap(timings.frame, projection.frames, next.frames, item.createdAt, frame => frame.status);
    syncTimingMap(timings.instance, projection.instances, next.instances, item.createdAt, instance => instance.status);
    syncTimingMap(timings.attempt, projection.attempts, next.attempts, item.createdAt, attempt => attempt.status);
    syncTimingMap(timings.member, projection.groupMembers, next.groupMembers, item.createdAt, member => member.status);
    syncTimingMap(timings.signal, projection.signalWaits, next.signalWaits, item.createdAt, wait => wait.status);
    projection = next;
  }
  return { projection, timings };
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

export function cancellationEventsForFrame(projection: SchedulerProjection, frameKey: string, cancelReason: "operator_cancelled"): SchedulerEvent[] {
  if (!projection.frames[frameKey]) return [];
  const frames = descendantFramesForFrame(projection, frameKey);
  const frameKeys = new Set(frames.map(frame => frame.frameKey));
  const instances = Object.values(projection.instances)
    .filter(instance => instance.parentFrameKey !== undefined && frameKeys.has(instance.parentFrameKey));
  return cancellationEventsForSubtree(projection, frames, instances, cancelReason);
}

export function cancellationEventsForNode(projection: SchedulerProjection, nodeKey: string, cancelReason: "operator_cancelled"): SchedulerEvent[] {
  const instance = projection.instances[nodeKey];
  if (!instance) return [];
  const member = ancestorGroupMembersForNode(projection, nodeKey)[0];
  return member ? cancellationEventsForMember(projection, member, cancelReason) : cancellationEventsForSubtree(projection, [], [instance], cancelReason);
}

function cancellationEventsForSubtree(
  projection: SchedulerProjection,
  frames: readonly SchedulerFrame[],
  instances: readonly NodeInstance[],
  cancelReason: "operator_cancelled",
): SchedulerEvent[] {
  const frameKeys = new Set(frames.map(frame => frame.frameKey));
  const nodeKeys = new Set(instances.map(instance => instance.nodeKey));
  const groupMembers = Object.values(projection.groupMembers)
    .filter(member => (member.childFrameKey !== undefined && frameKeys.has(member.childFrameKey)) || frameKeys.has(member.memberKey));
  const groupKeys = new Set(Object.values(projection.groups)
    .filter(group => frameKeys.has(group.nodeKey))
    .map(group => group.groupKey));
  const attempts = Object.values(projection.attempts)
    .filter(attempt => attempt.status === "started" && nodeKeys.has(attempt.nodeKey));
  const signalWaits = Object.values(projection.signalWaits)
    .filter(wait => wait.status === "awaiting" && nodeKeys.has(wait.nodeKey));
  return [
    ...attempts.map(attempt => ({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason } }) satisfies SchedulerEvent),
    ...signalWaits.map(wait => ({ type: "signal.cancelled", payload: { nodeKey: wait.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...instances
      .filter(instance => instance.status === "ready" || instance.status === "running" || instance.status === "awaiting")
      .map(instance => ({ type: "instance.cancelled", payload: { nodeKey: instance.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...groupMembers
      .filter(member => member.status === "ready" || member.status === "running")
      .map(member => ({ type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason } }) satisfies SchedulerEvent),
    ...Object.values(projection.groups)
      .filter(group => groupKeys.has(group.groupKey) && group.status === "running")
      .map(group => ({ type: "group.cancelled", payload: { groupKey: group.groupKey, cancelReason } }) satisfies SchedulerEvent),
    ...frames
      .filter(frame => frame.status === "ready" || frame.status === "running" || frame.status === "awaiting")
      .map(frame => ({ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason } }) satisfies SchedulerEvent),
  ];
}

function cancellationEventsForMember(projection: SchedulerProjection, member: GroupMember, cancelReason: "parent_failed" | "race_lost" | "quorum_reached" | "operator_cancelled"): SchedulerEvent[] {
  const instances = memberInstances(projection, member);
  const frames = memberFrames(projection, member);
  const childMembers = descendantGroupMembersForMember(projection, member);
  const childGroupKeys = descendantGroupKeysForMember(projection, member);
  const attempts = instances.flatMap(instance =>
    Object.values(projection.attempts).filter(attempt => attempt.nodeKey === instance.nodeKey && attempt.status === "started"),
  );
  const signalWaits = instances.flatMap(instance => {
    const wait = projection.signalWaits[instance.nodeKey];
    return wait?.status === "awaiting" ? [wait] : [];
  });
  return [
    { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason } },
    ...childMembers
      .filter(child => child.status === "ready" || child.status === "running")
      .map(child => ({ type: "group.member_cancelled", payload: { memberKey: child.memberKey, cancelReason } }) satisfies SchedulerEvent),
    ...childGroupKeys
      .filter(groupKey => projection.groups[groupKey]?.status === "running")
      .map(groupKey => ({ type: "group.cancelled", payload: { groupKey, cancelReason } }) satisfies SchedulerEvent),
    ...attempts.map(attempt => ({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason } }) satisfies SchedulerEvent),
    ...signalWaits.map(wait => ({ type: "signal.cancelled", payload: { nodeKey: wait.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...instances
      .filter(instance => instance.status === "ready" || instance.status === "running" || instance.status === "awaiting")
      .map(instance => ({ type: "instance.cancelled", payload: { nodeKey: instance.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...frames
      .filter(frame => !isTerminalFrameStatus(frame.status))
      .sort((left, right) => frameDepth(right) - frameDepth(left))
      .map(frame => ({ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason } }) satisfies SchedulerEvent),
  ];
}

function memberInstances(projection: SchedulerProjection, member: GroupMember): NodeInstance[] {
  return descendantInstancesForMember(projection, member);
}

function memberFrames(projection: SchedulerProjection, member: GroupMember): SchedulerFrame[] {
  return descendantFramesForMember(projection, member);
}

function frameDepth(frame: SchedulerFrame): number {
  return frame.instancePath?.length ?? 0;
}

export function nextLoopStep(input: { iter: number; transition?: JsonValue }): LoopNextStep {
  const transition = loopTransition(input.transition);
  if (!transition.ok) return { action: "fail", error: { reason: "invalid_loop_transition", message: transition.message }, terminalReason: "invalid_loop_transition" };
  return transition.stop
    ? { action: "complete", output: transition.state, terminalReason: "stopped" }
    : { action: "start_iteration", iter: input.iter + 1, state: transition.state };
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

function loopTransition(value: JsonValue | undefined): { ok: true; state: JsonValue; stop: boolean } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Loop body must return an object with { state, stop }." };
  if (!Object.prototype.hasOwnProperty.call(value, "state")) return { ok: false, message: "Loop body transition is missing 'state'." };
  if (!Object.prototype.hasOwnProperty.call(value, "stop")) return { ok: false, message: "Loop body transition is missing 'stop'." };
  const transition = value as JsonObject;
  if (typeof transition.stop !== "boolean") return { ok: false, message: "Loop body transition 'stop' must be boolean." };
  return { ok: true, state: transition.state as JsonValue, stop: transition.stop };
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
  if (event.type === "frame.retry_requested") {
    applyFrameRetryEvent(projection, event.payload.frameKey);
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
      if (event.payload.frameKey === "root") {
        projection.run = {
          ...projection.run,
          status: event.payload.cancelReason === "operator_cancelled" ? "canceled" : "failed",
          paused: false,
        };
      }
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
        const transition = loopTransition(frame.loop.transition);
        if (!transition.ok) throw new Error(`Loop frame '${frame.frameKey}' cannot advance before iteration ${frame.loop.iter} has a valid transition.`);
        if (stableJson(event.payload.state) !== stableJson(transition.state)) {
          throw new Error(`Loop frame '${frame.frameKey}' next state must match iteration ${frame.loop.iter} transition state.`);
        }
      }
      if (event.payload.iter === frame.loop.iter && frame.loop.transition !== undefined && event.payload.transition !== undefined && stableJson(frame.loop.transition) !== stableJson(event.payload.transition)) {
        throw new Error(`Loop frame '${frame.frameKey}' already recorded a different transition for iteration ${event.payload.iter}.`);
      }
      if (event.payload.iter === frame.loop.iter && event.payload.state !== undefined && frame.loop.state !== undefined && stableJson(frame.loop.state) !== stableJson(event.payload.state)) {
        const transition = loopTransition(event.payload.transition);
        const stateMatchesTransition = transition.ok && stableJson(event.payload.state) === stableJson(transition.state);
        if (!stateMatchesTransition) throw new Error(`Loop frame '${frame.frameKey}' already recorded a different state for iteration ${event.payload.iter}.`);
      }
    }
    if (!frame.loop && event.payload.iter !== 0) throw new Error(`Loop frame '${frame.frameKey}' must start at iteration 0.`);
    const sameIter = frame.loop?.iter === event.payload.iter;
    projection.frames[event.payload.frameKey] = compactFrame({
      ...frame,
      loop: {
        iter: event.payload.iter,
        index: event.payload.iter,
        round: event.payload.iter + 1,
        state: event.payload.state ?? (sameIter ? frame.loop?.state : undefined),
        transition: event.payload.transition ?? (sameIter ? frame.loop?.transition : undefined),
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
      ...(event.payload.timeoutMs === undefined ? {} : { timeoutMs: event.payload.timeoutMs }),
    });
    return;
  }
  if (isInstanceEvent(event)) {
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
  if (isAttemptEvent(event)) {
    applyAttemptEvent(projection, event);
    return;
  }
  if (event.type === "group.started") {
    if (projection.groups[event.payload.groupKey]) throw new Error(`Group '${event.payload.groupKey}' already exists.`);
    assertGroupKindStrategy(event.payload.kind, event.payload.strategy, event.payload.groupKey);
    const quorumCount = event.payload.quorumCount;
    const maxConcurrency = event.payload.maxConcurrency;
    if (event.payload.strategy === "quorum" && (typeof quorumCount !== "number" || !Number.isInteger(quorumCount) || quorumCount <= 0)) {
      throw new Error(`Quorum group '${event.payload.groupKey}' requires a positive quorum count.`);
    }
    if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0)) {
      throw new Error(`Group '${event.payload.groupKey}' requires a positive maxConcurrency.`);
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
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    });
    return;
  }
  if (isGroupEvent(event)) {
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
  if (isSignalEvent(event)) {
    applySignalEvent(projection, event);
    return;
  }
  assertNever(event);
}

function isInstanceEvent(event: SchedulerEvent): event is Extract<SchedulerEvent, { type: "instance.ready" | "instance.started" | "instance.awaiting" | "instance.requeued" | "instance.retry_requested" | "instance.completed" | "instance.failed" | "instance.cancelled" }> {
  switch (event.type) {
    case "instance.ready":
    case "instance.started":
    case "instance.awaiting":
    case "instance.requeued":
    case "instance.retry_requested":
    case "instance.completed":
    case "instance.failed":
    case "instance.cancelled":
      return true;
    default:
      return false;
  }
}

function isAttemptEvent(event: SchedulerEvent): event is Extract<SchedulerEvent, { type: "attempt.started" | "attempt.completed" | "attempt.failed" | "attempt.timed_out" | "attempt.cancelled" | "attempt.superseded" }> {
  switch (event.type) {
    case "attempt.started":
    case "attempt.completed":
    case "attempt.failed":
    case "attempt.timed_out":
    case "attempt.cancelled":
    case "attempt.superseded":
      return true;
    default:
      return false;
  }
}

function isGroupEvent(event: SchedulerEvent): event is Extract<SchedulerEvent, { type: "group.started" | "group.member_ready" | "group.member_started" | "group.member_requeued" | "group.member_retry_requested" | "group.member_completed" | "group.member_failed" | "group.member_cancelled" | "group.completed" | "group.failed" | "group.cancelled" }> {
  switch (event.type) {
    case "group.started":
    case "group.member_ready":
    case "group.member_started":
    case "group.member_requeued":
    case "group.member_retry_requested":
    case "group.member_completed":
    case "group.member_failed":
    case "group.member_cancelled":
    case "group.completed":
    case "group.failed":
    case "group.cancelled":
      return true;
    default:
      return false;
  }
}

function isSignalEvent(event: SchedulerEvent): event is Extract<SchedulerEvent, { type: "signal.awaiting" | "signal.timeout_paused" | "signal.timeout_resumed" | "signal.consumed" | "signal.timed_out" | "signal.cancelled" }> {
  switch (event.type) {
    case "signal.awaiting":
    case "signal.timeout_paused":
    case "signal.timeout_resumed":
    case "signal.consumed":
    case "signal.timed_out":
    case "signal.cancelled":
      return true;
    default:
      return false;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled scheduler event: ${String(value)}`);
}

function applyInstanceEvent(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (!("nodeKey" in event.payload)) return;
  const instance = requireKey(projection.instances, event.payload.nodeKey!, "node instance");
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
    delete projection.signalWaits[event.payload.nodeKey];
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
  if (event.type === "instance.started") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "running", statusReason: undefined });
  if (event.type === "instance.awaiting") {
    projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "awaiting", ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
    startReadyAncestorMembers(projection, event.payload.nodeKey);
  }
  if (event.type === "instance.completed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "completed", statusReason: undefined, error: undefined, ...(event.payload.output === undefined ? {} : { output: event.payload.output }), ...(event.payload.acceptedAttemptId === undefined ? {} : { acceptedAttemptId: event.payload.acceptedAttemptId }) });
  if (event.type === "instance.failed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "failed", error: event.payload.error, ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
  if (event.type === "instance.cancelled") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "cancelled", statusReason: event.payload.cancelReason });
}

function startReadyAncestorMembers(projection: SchedulerProjection, nodeKey: string): void {
  for (const member of ancestorGroupMembersForNode(projection, nodeKey)) {
    if (member.status === "ready") projection.groupMembers[member.memberKey] = compactMember({ ...member, status: "running" });
  }
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
    const member = {
      runId: event.payload.runId,
      groupKey: event.payload.groupKey,
      memberKey: event.payload.memberKey,
      status: "ready" as const,
      readinessSequence: event.payload.readinessSequence,
      ...(event.payload.childFrameKey === undefined ? {} : { childFrameKey: event.payload.childFrameKey }),
    };
    projection.groupMembers[event.payload.memberKey] = event.payload.memberKind === "branch"
      ? { ...member, memberKind: "branch", branchId: event.payload.branchId }
      : { ...member, memberKind: "fanout_item", itemIndex: event.payload.itemIndex, item: event.payload.item };
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
        ...member,
        status: "ready",
        readinessSequence: event.payload.readinessSequence ?? member.readinessSequence,
        completionSequence: undefined,
        acceptedRank: undefined,
        terminalReason: undefined,
        output: undefined,
        error: undefined,
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

function applyFrameRetryEvent(projection: SchedulerProjection, frameKey: string): void {
  const frame = requireKey(projection.frames, frameKey, "frame");
  assertFrameRetryable(frame);
  const instances = descendantInstancesForFrame(projection, frameKey);
  const instanceKeys = new Set(instances.map(instance => instance.nodeKey));
  const members = descendantGroupMembersForFrame(projection, frameKey);
  const groupKeys = descendantGroupKeysForFrame(projection, frameKey);
  const frames = descendantFramesForFrame(projection, frameKey);
  if (projection.run.status === "failed") projection.run = { ...projection.run, status: "pending", paused: false };
  reopenFrameForControlRetry(projection, "root");
  for (let parentKey = frame.parentFrameKey; parentKey !== undefined;) {
    const parent = projection.frames[parentKey];
    if (!parent) break;
    reopenFrameForControlRetry(projection, parentKey);
    parentKey = parent.parentFrameKey;
  }

  for (const attempt of Object.values(projection.attempts)) {
    if (instanceKeys.has(attempt.nodeKey)) delete projection.attempts[attempt.attemptId];
  }
  for (const wait of Object.values(projection.signalWaits)) {
    if (instanceKeys.has(wait.nodeKey)) delete projection.signalWaits[wait.nodeKey];
  }
  for (const instance of instances) delete projection.instances[instance.nodeKey];
  for (const member of members) delete projection.groupMembers[member.memberKey];
  for (const groupKey of groupKeys) delete projection.groups[groupKey];
  for (const child of frames) {
    delete projection.branchDecisions[child.frameKey];
    delete projection.frames[child.frameKey];
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

function applySignalEvent(projection: SchedulerProjection, event: Extract<SchedulerEvent, { type: "signal.awaiting" | "signal.timeout_paused" | "signal.timeout_resumed" | "signal.consumed" | "signal.timed_out" | "signal.cancelled" }>): void {
  if (event.type === "signal.awaiting") {
    if (projection.signalWaits[event.payload.nodeKey]) throw new Error(`Signal wait '${event.payload.nodeKey}' already exists.`);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      runId: event.payload.runId,
      nodeKey: event.payload.nodeKey,
      nodeId: event.payload.nodeId,
      status: "awaiting",
      ...(event.payload.deadlineAt === undefined ? {} : { deadlineAt: event.payload.deadlineAt }),
      ...(event.payload.timeoutMessage === undefined ? {} : { timeoutMessage: event.payload.timeoutMessage }),
      ...(event.payload.renderedPrompt === undefined ? {} : { renderedPrompt: event.payload.renderedPrompt }),
    });
    return;
  }
  const wait = requireKey(projection.signalWaits, event.payload.nodeKey, "signal wait");
  if (event.type === "signal.timeout_paused") {
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      ...wait,
      deadlineAt: undefined,
      timeoutRemainingMs: event.payload.remainingMs,
    });
    return;
  }
  if (event.type === "signal.timeout_resumed") {
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      ...wait,
      deadlineAt: event.payload.deadlineAt,
      timeoutRemainingMs: undefined,
    });
    return;
  }
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
  if (event.type === "signal.cancelled") {
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({ ...wait, status: "cancelled", terminalReason: event.payload.cancelReason });
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

function syncTimingMap<T>(
  timings: Map<string, SchedulerProjectionTiming>,
  before: Record<string, T>,
  after: Record<string, T>,
  at: string,
  statusOf: (value: T) => string,
): void {
  for (const key of [...timings.keys()]) {
    if (!(key in after)) timings.delete(key);
  }
  for (const [key, current] of Object.entries(after)) {
    const previous = before[key];
    if (!previous) {
      timings.set(key, { createdAt: at, updatedAt: at });
      continue;
    }
    if (stableJson(previous) === stableJson(current)) continue;
    const existing = timings.get(key);
    timings.set(key, {
      createdAt: resetsLifecycle(statusOf(previous), statusOf(current)) ? at : existing?.createdAt ?? at,
      updatedAt: at,
    });
  }
}

function resetsLifecycle(previous: string, current: string): boolean {
  return terminalProjectionStatus(previous) && !terminalProjectionStatus(current);
}

function terminalProjectionStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled" || status === "timed_out" || status === "consumed" || status === "superseded";
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

function assertFrameRetryable(frame: SchedulerFrame): void {
  if (frame.status !== "failed") throw new Error(`Frame '${frame.frameKey}' cannot be retried from ${frame.status}.`);
  if (frame.frameKind !== "node" && frame.frameKind !== "loop") throw new Error(`Frame '${frame.frameKey}' is not a retryable public node frame.`);
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
  if (status === "completed" || status === "failed" || status === "canceled") throw new Error(`Cannot ${action} ${status} run.`);
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
