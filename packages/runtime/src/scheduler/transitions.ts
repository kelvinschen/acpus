import { stableJson } from "../stable-json.js";
import { isTerminalAttemptStatus, isTerminalFrameStatus, isTerminalGroupMemberStatus, isTerminalInstanceStatus, type SchedulerEvent } from "./events.js";
import { ancestorGroupMembersForNode, descendantFramesForFrame, descendantGroupKeysForFrame, descendantGroupMembersForFrame, descendantInstancesForFrame } from "./membership.js";
import { parseLoopTransition } from "./loop-transition.js";
import type {
  GroupMember,
  GroupProjection,
  NodeInstance,
  SchedulerFrame,
  SchedulerProjection,
} from "./types.js";

type SchedulerProjectionTiming = {
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

export function applySchedulerEvents(projection: SchedulerProjection, events: readonly SchedulerEvent[]): SchedulerProjection {
  const next = cloneProjection(projection);
  for (const event of events) applyMutable(next, event);
  return next;
}

function applyMutable(projection: SchedulerProjection, event: SchedulerEvent): void {
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
  if (event.type === "control.agent_steer_requested") {
    const instance = requireKey(projection.instances, event.payload.nodeKey, "node instance");
    if (instance.status !== "running" && instance.status !== "awaiting") {
      throw new Error(`Steer target '${instance.nodeKey}' is not active.`);
    }
    projection.instances[instance.nodeKey] = compactInstance({
      ...instance,
      pendingSteerId: event.payload.steerId,
    });
    return;
  }
  if (event.type === "control.agent_steer_blocked") return;
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
    applyFrameRetryEvent(projection, event.payload.frameKey, event.payload.retryDependencyMemberKeys);
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
        const transition = parseLoopTransition(frame.loop.transition);
        if (!transition.ok) throw new Error(`Loop frame '${frame.frameKey}' cannot advance before iteration ${frame.loop.iter} has a valid transition.`);
        if (event.payload.state === undefined || stableJson(event.payload.state) !== stableJson(transition.state)) {
          throw new Error(`Loop frame '${frame.frameKey}' next state must match iteration ${frame.loop.iter} transition state.`);
        }
      }
      if (event.payload.iter === frame.loop.iter && frame.loop.transition !== undefined && event.payload.transition !== undefined && stableJson(frame.loop.transition) !== stableJson(event.payload.transition)) {
        throw new Error(`Loop frame '${frame.frameKey}' already recorded a different transition for iteration ${event.payload.iter}.`);
      }
      if (event.payload.iter === frame.loop.iter && event.payload.state !== undefined && frame.loop.state !== undefined && stableJson(frame.loop.state) !== stableJson(event.payload.state)) {
        const transition = parseLoopTransition(event.payload.transition);
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
      ...(event.payload.steerId === undefined ? {} : { steerId: event.payload.steerId }),
      ...(event.payload.steerEventSequence === undefined
        ? {}
        : { steerEventSequence: event.payload.steerEventSequence }),
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
    if ((event.payload.reason === "steered") !== (event.payload.steerEventSequence !== undefined)) {
      throw new Error(`Node instance '${event.payload.nodeKey}' Steer lineage is inconsistent.`);
    }
    if ((event.payload.reason === "steered") !== (event.payload.steerId !== undefined)) {
      throw new Error(`Node instance '${event.payload.nodeKey}' steer requeue metadata is inconsistent.`);
    }
    const interruptedAttempt = event.payload.reason === "paused" || event.payload.reason === "superseded"
      ? Object.values(projection.attempts)
        .filter(attempt => attempt.nodeKey === instance.nodeKey && attempt.status !== "started")
        .sort((left, right) => right.attemptNo - left.attemptNo)[0]
      : undefined;
    projection.instances[event.payload.nodeKey] = compactInstance({
      ...instance,
      status: "ready",
      ...(event.payload.readinessSequence === undefined ? {} : { readinessSequence: event.payload.readinessSequence }),
      statusReason: (event.payload.reason === "paused" || event.payload.reason === "superseded")
        && interruptedAttempt?.steerId !== undefined
        ? "steered"
        : event.payload.reason,
      pendingSteerId: event.payload.steerId ?? interruptedAttempt?.steerId,
      pendingSteerEventSequence: event.payload.steerEventSequence
        ?? interruptedAttempt?.steerEventSequence,
    });
    return;
  }
  if (event.type === "instance.retry_requested") {
    assertInstanceRetryable(instance);
    reopenForControlNodeRetry(projection, instance);
    delete projection.signalWaits[event.payload.nodeKey];
    projection.instances[event.payload.nodeKey] = compactInstance({
      runId: instance.runId,
      nodeKey: instance.nodeKey,
      nodeId: instance.nodeId,
      status: "ready",
      instancePath: instance.instancePath,
      ...(instance.parentFrameKey === undefined ? {} : { parentFrameKey: instance.parentFrameKey }),
      readinessSequence: event.payload.readinessSequence ?? instance.readinessSequence,
      ...(instance.timeoutMs === undefined ? {} : { timeoutMs: instance.timeoutMs }),
      statusReason: "retry",
    });
    reopenRetryDependencies(projection, event.payload.retryDependencyMemberKeys);
    return;
  }
  assertInstanceOpen(instance);
  if (event.type === "instance.started") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "running", statusReason: undefined, pendingSteerId: undefined, pendingSteerEventSequence: undefined, ...(event.payload.replayIdentity === undefined ? {} : { replayIdentity: event.payload.replayIdentity }) });
  if (event.type === "instance.awaiting") {
    projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "awaiting", ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }), ...(event.payload.replayIdentity === undefined ? {} : { replayIdentity: event.payload.replayIdentity }) });
    startReadyAncestorMembers(projection, event.payload.nodeKey);
  }
  if (event.type === "instance.completed") {
    projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "completed", statusReason: undefined, pendingSteerId: undefined, pendingSteerEventSequence: undefined, error: undefined, ...(event.payload.output === undefined ? {} : { output: event.payload.output }), ...(event.payload.acceptedAttemptId === undefined ? {} : { acceptedAttemptId: event.payload.acceptedAttemptId }), ...(event.payload.replayIdentity === undefined ? {} : { replayIdentity: event.payload.replayIdentity }), ...(event.payload.reusedFrom === undefined ? {} : { reusedFrom: event.payload.reusedFrom }) });
    startReadyAncestorMembers(projection, event.payload.nodeKey);
  }
  if (event.type === "instance.failed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "failed", pendingSteerId: undefined, pendingSteerEventSequence: undefined, error: event.payload.error, ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
  if (event.type === "instance.cancelled") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "cancelled", pendingSteerId: undefined, pendingSteerEventSequence: undefined, statusReason: event.payload.cancelReason });
}

function startReadyAncestorMembers(projection: SchedulerProjection, nodeKey: string): void {
  for (const member of ancestorGroupMembersForNode(projection, nodeKey)) {
    if (member.status === "ready") projection.groupMembers[member.memberKey] = compactMember({ ...member, status: "running" });
  }
}

function applyAttemptEvent(projection: SchedulerProjection, event: SchedulerEvent): void {
  if (!("attemptId" in event.payload) || event.payload.attemptId === undefined) return;
  const attemptId = event.payload.attemptId;
  const attempt = requireKey(projection.attempts, attemptId, "attempt");
  assertAttemptOpen(attempt);
  if (event.type === "attempt.completed") projection.attempts[attemptId] = compactAttempt({ ...attempt, status: "completed", ...(event.payload.result === undefined ? {} : { result: event.payload.result }) });
  if (event.type === "attempt.failed") projection.attempts[attemptId] = compactAttempt({ ...attempt, status: "failed", error: event.payload.error, ...(event.payload.terminalReason === undefined ? {} : { terminalReason: event.payload.terminalReason }) });
  if (event.type === "attempt.timed_out") projection.attempts[attemptId] = compactAttempt({ ...attempt, status: "timed_out", ...(event.payload.error === undefined ? {} : { error: event.payload.error }), terminalReason: "timed_out" });
  if (event.type === "attempt.cancelled") projection.attempts[attemptId] = compactAttempt({ ...attempt, status: "cancelled", cancelReason: event.payload.cancelReason });
  if (event.type === "attempt.superseded") projection.attempts[attemptId] = compactAttempt({ ...attempt, status: "superseded", cancelReason: event.payload.cancelReason ?? "superseded" });
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
      reopenGroupForControlRetry(projection, member.groupKey);
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

function applyFrameRetryEvent(projection: SchedulerProjection, frameKey: string, retryDependencyMemberKeys: string[] | undefined): void {
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
  reopenRetryDependencies(projection, retryDependencyMemberKeys);
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

function reopenRetryDependencies(projection: SchedulerProjection, memberKeys: readonly string[] | undefined): void {
  if (!memberKeys || memberKeys.length === 0) return;
  const rootMemberKeys = new Set<string>();
  const rootFrameKeys = new Set<string>();
  for (const memberKey of memberKeys) {
    if (rootMemberKeys.has(memberKey)) throw new Error(`Retry dependency member '${memberKey}' is duplicated.`);
    const member = requireKey(projection.groupMembers, memberKey, "group member");
    if (member.status !== "cancelled" || member.terminalReason !== "parent_failed") {
      throw new Error(`Group member '${member.memberKey}' is not a parent-failed retry dependency.`);
    }
    rootMemberKeys.add(memberKey);
    const rootFrameKey = member.childFrameKey ?? member.memberKey;
    if (projection.frames[rootFrameKey]) rootFrameKeys.add(rootFrameKey);
    else if (member.childFrameKey !== undefined) throw new Error(`Retry dependency member '${memberKey}' references missing frame '${member.childFrameKey}'.`);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const frame of Object.values(projection.frames)) {
    if (frame.parentFrameKey === undefined) continue;
    const children = childrenByParent.get(frame.parentFrameKey) ?? [];
    children.push(frame.frameKey);
    childrenByParent.set(frame.parentFrameKey, children);
  }
  const frameKeys = new Set<string>();
  const pending = [...rootFrameKeys];
  while (pending.length > 0) {
    const frameKey = pending.pop()!;
    if (frameKeys.has(frameKey)) continue;
    frameKeys.add(frameKey);
    pending.push(...(childrenByParent.get(frameKey) ?? []));
  }

  const attemptedNodeKeys = new Set(Object.values(projection.attempts).map(attempt => attempt.nodeKey));
  for (const instance of Object.values(projection.instances)) {
    if (!rootMemberKeys.has(instance.nodeKey)
      && (instance.parentFrameKey === undefined || !frameKeys.has(instance.parentFrameKey))) continue;
    if (instance.status !== "cancelled" || instance.statusReason !== "parent_failed") continue;
    const wait = projection.signalWaits[instance.nodeKey];
    if (wait?.status === "cancelled" && wait.terminalReason === "parent_failed") delete projection.signalWaits[instance.nodeKey];
    projection.instances[instance.nodeKey] = compactInstance({
      ...instance,
      status: "ready",
      statusReason: attemptedNodeKeys.has(instance.nodeKey) ? "retry" : undefined,
      output: undefined,
      error: undefined,
      acceptedAttemptId: undefined,
    });
  }

  for (const frameKey of frameKeys) {
    const frame = projection.frames[frameKey]!;
    if (frame.status !== "cancelled" || frame.terminalReason !== "parent_failed") continue;
    projection.frames[frame.frameKey] = compactFrame({
      ...frame,
      status: "running",
      terminalReason: undefined,
      result: undefined,
      error: undefined,
    });
  }

  for (const group of Object.values(projection.groups)) {
    if (!frameKeys.has(group.nodeKey) || group.status !== "cancelled" || group.error?.reason !== "parent_failed") continue;
    projection.groups[group.groupKey] = compactGroup({
      ...group,
      status: "running",
      result: undefined,
      error: undefined,
    });
  }

  for (const child of Object.values(projection.groupMembers)) {
    if (!rootMemberKeys.has(child.memberKey)
      && !(child.childFrameKey !== undefined && frameKeys.has(child.childFrameKey))
      && !frameKeys.has(child.memberKey)) continue;
    if (child.status !== "cancelled" || child.terminalReason !== "parent_failed") continue;
    projection.groupMembers[child.memberKey] = compactMember({
      ...child,
      status: "ready",
      completionSequence: undefined,
      acceptedRank: undefined,
      terminalReason: undefined,
      output: undefined,
      error: undefined,
    });
  }
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
      if (wait.commandIdempotencyKey === event.payload.commandIdempotencyKey && wait.payload !== undefined && stableJson(wait.payload) === stableJson(event.payload.payload)) return;
      throw new Error(`Signal wait '${event.payload.nodeKey}' has already consumed a different payload.`);
    }
    assertSignalOpen(wait.status, event.payload.nodeKey);
    projection.signalWaits[event.payload.nodeKey] = compactSignalWait({
      ...wait,
      status: "consumed",
      payload: event.payload.payload,
      commandIdempotencyKey: event.payload.commandIdempotencyKey,
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

function requireKey<T>(values: Record<string, T>, key: string, label: string): T {
  const value = values[key];
  if (!value) throw new Error(`Unknown ${label} '${key}'.`);
  return value;
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
