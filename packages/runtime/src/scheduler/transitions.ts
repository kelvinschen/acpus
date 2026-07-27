import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { stableJson } from "../stable-json.js";
import { isTerminalAttemptStatus, isTerminalFrameStatus, isTerminalGroupMemberStatus, isTerminalInstanceStatus, type SchedulerEvent } from "./events.js";
import { ancestorGroupMembersForNode, descendantFramesForFrame, descendantGroupKeysForFrame, descendantGroupMembersForFrame, descendantInstancesForFrame } from "./membership.js";
import type {
  GroupMember,
  GroupProjection,
  NodeInstance,
  SchedulerFrame,
  SchedulerProjection,
} from "./types.js";

type GroupCompletion =
  | { status: "running" }
  | { status: "completed"; acceptedMemberKeys: string[]; cancelRemaining: boolean }
  | { status: "failed"; reason: string; cancelRemaining: boolean };

export type LoopNextStep =
  | { action: "start_iteration"; iter: number; state?: JsonValue }
  | { action: "complete"; output: JsonValue; terminalReason: "stopped" }
  | { action: "fail"; error: JsonObject; terminalReason: "invalid_loop_transition" };

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
        ? [{ type: "instance.failed", payload: { nodeKey: instance.nodeKey, attemptId: attempt.attemptId, error, statusReason: "timed_out" } } satisfies SchedulerEvent]
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

export function applySchedulerEvents(projection: SchedulerProjection, events: readonly SchedulerEvent[]): SchedulerProjection {
  const next = cloneProjection(projection);
  for (const event of events) applyMutable(next, event);
  return next;
}

function evaluateGroupCompletion(group: GroupProjection, members: readonly GroupMember[]): GroupCompletion {
  if (group.status === "completed") return { status: "completed", acceptedMemberKeys: [], cancelRemaining: false };
  if (group.status !== "running") return { status: "failed", reason: group.error?.message as string ?? "group_not_running", cancelRemaining: false };
  if (group.strategy === "all") {
    const failed = members.find(member => member.status === "failed");
    if (failed) return { status: "failed", reason: failed.terminalReason ?? "member_failed", cancelRemaining: true };
    const cancelled = members.find(member => member.status === "cancelled");
    if (cancelled) return { status: "failed", reason: cancelled.terminalReason ?? "member_cancelled", cancelRemaining: true };
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

export function targetedRetryGroupBlocker(
  group: GroupProjection,
  members: readonly GroupMember[],
  reopenedMemberKeys: ReadonlySet<string>,
): { status: "completed" | "failed"; reason: string } | undefined {
  const completion = evaluateGroupCompletion(
    { ...group, status: "running" },
    members.map(member => reopenedMemberKeys.has(member.memberKey)
      ? compactMember({ ...member, status: "ready", terminalReason: undefined })
      : member),
  );
  if (completion.status === "running") return undefined;
  return completion.status === "failed"
    ? { status: "failed", reason: completion.reason }
    : { status: "completed", reason: "group_would_complete_without_retry" };
}

export function targetedRetryGroupAssessment(
  group: GroupProjection,
  members: readonly GroupMember[],
  reopenedDependencyKeys: ReadonlySet<string>,
): {
  blockerFor(targetMemberKey: string): ReturnType<typeof targetedRetryGroupBlocker>;
} {
  const membersByKey = new Map<string, GroupMember>();
  for (const member of members) {
    if (membersByKey.has(member.memberKey)) {
      throw new Error(`Retry group '${group.groupKey}' contains duplicate member identity '${member.memberKey}'.`);
    }
    membersByKey.set(member.memberKey, member);
  }
  const failed = members.filter(member =>
    member.status === "failed" && !reopenedDependencyKeys.has(member.memberKey));
  const cancelled = members.filter(member =>
    member.status === "cancelled" && !reopenedDependencyKeys.has(member.memberKey));
  const completedMembers = members
    .filter(member =>
      member.status === "completed" && !reopenedDependencyKeys.has(member.memberKey));
  if (group.strategy === "race" || group.strategy === "quorum") {
    completedMembers.sort(byCompletionSequence);
  }
  const completed = completedMembers.length;
  const open = members.filter(member =>
    (member.status === "ready" || member.status === "running")
    && !reopenedDependencyKeys.has(member.memberKey)).length;
  const reopenedDependencies = members.filter(member =>
    reopenedDependencyKeys.has(member.memberKey)).length;

  return {
    blockerFor(targetMemberKey) {
      const target = membersByKey.get(targetMemberKey);
      if (!target) {
        throw new Error(`Retry group '${group.groupKey}' has no target member '${targetMemberKey}'.`);
      }
      if (group.strategy === "all") {
        const remainingFailure = failed.find(member => member.memberKey !== targetMemberKey);
        if (remainingFailure) {
          return {
            status: "failed",
            reason: remainingFailure.terminalReason ?? "member_failed",
          };
        }
        const remainingCancellation = cancelled.find(member => member.memberKey !== targetMemberKey);
        return remainingCancellation
          ? {
            status: "failed",
            reason: remainingCancellation.terminalReason ?? "member_cancelled",
          }
          : undefined;
      }
      if (group.strategy === "race") {
        return completed > 0
          ? { status: "completed", reason: "group_would_complete_without_retry" }
          : undefined;
      }
      const quorum = requirePositiveQuorum(group);
      if (completed >= quorum) {
        return { status: "completed", reason: "group_would_complete_without_retry" };
      }
      const reopenedTargets = reopenedDependencyKeys.has(targetMemberKey)
        ? 0
        : 1;
      const reopened = reopenedDependencies + reopenedTargets;
      return completed + open + reopened < quorum
        ? { status: "failed", reason: "quorum_impossible" }
        : undefined;
    },
  };
}

type RetryDependencyOutcome = "blocked" | "complete" | "work";

export function targetedRetryDependencyBlocker(
  projection: SchedulerProjection,
  memberKeys: readonly string[],
): { memberKey: string } | undefined {
  const membersByGroup = new Map<string, GroupMember[]>();
  for (const member of Object.values(projection.groupMembers)) {
    const members = membersByGroup.get(member.groupKey) ?? [];
    members.push(member);
    membersByGroup.set(member.groupKey, members);
  }
  const childrenByFrame = new Map<string, SchedulerFrame[]>();
  for (const frame of Object.values(projection.frames)) {
    if (frame.parentFrameKey === undefined) continue;
    const children = childrenByFrame.get(frame.parentFrameKey) ?? [];
    children.push(frame);
    childrenByFrame.set(frame.parentFrameKey, children);
  }
  const instancesByFrame = new Map<string, NodeInstance[]>();
  for (const instance of Object.values(projection.instances)) {
    if (instance.parentFrameKey === undefined) continue;
    const instances = instancesByFrame.get(instance.parentFrameKey) ?? [];
    instances.push(instance);
    instancesByFrame.set(instance.parentFrameKey, instances);
  }
  const groupsByFrame = new Map<string, GroupProjection>();
  for (const group of Object.values(projection.groups)) {
    if (groupsByFrame.has(group.nodeKey)) throw new Error(`Frame '${group.nodeKey}' owns multiple groups.`);
    groupsByFrame.set(group.nodeKey, group);
  }
  const frameOutcomes = new Map<string, RetryDependencyOutcome>();
  const visiting = new Set<string>();

  const instanceOutcome = (instance: NodeInstance): RetryDependencyOutcome => {
    if (instance.status === "completed") return "complete";
    if (instance.status === "failed" || instance.status === "cancelled") return "blocked";
    if (instance.status === "pending") throw new Error(`Retry dependency instance '${instance.nodeKey}' has non-runnable status 'pending'.`);
    return "work";
  };
  const memberOutcome = (member: GroupMember): RetryDependencyOutcome => {
    if (member.status === "completed") return "complete";
    if (member.status === "failed" || member.status === "cancelled") return "blocked";
    const frameKey = member.childFrameKey ?? member.memberKey;
    const frame = projection.frames[frameKey];
    if (frame) return frameOutcome(frame);
    if (member.childFrameKey !== undefined) throw new Error(`Retry dependency member '${member.memberKey}' references missing frame '${member.childFrameKey}'.`);
    const instance = projection.instances[member.memberKey];
    if (!instance) throw new Error(`Retry dependency member '${member.memberKey}' has no runnable backing state.`);
    return instanceOutcome(instance);
  };
  const groupOutcome = (group: GroupProjection): RetryDependencyOutcome => {
    if (group.status === "completed") return "complete";
    if (group.status === "failed" || group.status === "cancelled") return "blocked";
    const outcomes = (membersByGroup.get(group.groupKey) ?? []).map(memberOutcome);
    if (group.strategy === "all") {
      if (outcomes.includes("blocked")) return "blocked";
      return outcomes.every(outcome => outcome === "complete") ? "complete" : "work";
    }
    if (group.strategy === "race") {
      if (outcomes.includes("complete")) return "complete";
      return outcomes.includes("work") ? "work" : "blocked";
    }
    const quorum = requirePositiveQuorum(group);
    const complete = outcomes.filter(outcome => outcome === "complete").length;
    if (complete >= quorum) return "complete";
    const possible = complete + outcomes.filter(outcome => outcome === "work").length;
    return possible >= quorum ? "work" : "blocked";
  };
  const frameOutcome = (frame: SchedulerFrame): RetryDependencyOutcome => {
    const cached = frameOutcomes.get(frame.frameKey);
    if (cached) return cached;
    if (visiting.has(frame.frameKey)) throw new Error(`Retry dependency frame '${frame.frameKey}' has cyclic ancestry.`);
    visiting.add(frame.frameKey);
    let outcome: RetryDependencyOutcome;
    if (frame.status === "completed") outcome = "complete";
    else if (frame.status === "failed" || frame.status === "cancelled") outcome = "blocked";
    else if (frame.status !== "running") throw new Error(`Retry dependency frame '${frame.frameKey}' has non-runnable status '${frame.status}'.`);
    else {
      const group = groupsByFrame.get(frame.frameKey);
      if (group) outcome = groupOutcome(group);
      else {
        const descendants = [
          ...(childrenByFrame.get(frame.frameKey) ?? []).map(frameOutcome),
          ...(instancesByFrame.get(frame.frameKey) ?? []).map(instanceOutcome),
        ];
        outcome = descendants.includes("blocked") ? "blocked" : "work";
      }
    }
    visiting.delete(frame.frameKey);
    frameOutcomes.set(frame.frameKey, outcome);
    return outcome;
  };

  for (const memberKey of memberKeys) {
    const member = projection.groupMembers[memberKey];
    if (!member) throw new Error(`Retry dependency member '${memberKey}' is missing.`);
    if (memberOutcome(member) === "blocked") return { memberKey };
  }
  return undefined;
}

export function groupCompletionEvents(projection: SchedulerProjection, groupKey: string): SchedulerEvent[] {
  const group = requireKey(projection.groups, groupKey, "group");
  if (group.status !== "running") return [];
  const members = Object.values(projection.groupMembers).filter(member => member.groupKey === groupKey);
  const completion = evaluateGroupCompletion(group, members);
  const cancellation = completionCancellation(group, members, completion);
  return completionEventsForGroup(
    projection,
    group,
    completion,
    cancellation,
    indexMemberCancellations(projection, cancellation?.members ?? []),
  );
}

function completionEventsForGroup(
  projection: SchedulerProjection,
  group: GroupProjection,
  completion: GroupCompletion,
  cancellation: GroupCompletionCancellation | undefined,
  cancellationIndex: MemberCancellationIndex,
): SchedulerEvent[] {
  if (completion.status === "running") return [];
  const cancellationEvents = cancellation?.members.flatMap(member =>
    cancellationEventsForMember(projection, member, cancellation.cancelReason, cancellationIndex),
  ) ?? [];
  if (completion.status === "completed") {
    return [
      ...cancellationEvents,
      { type: "group.completed", payload: { groupKey: group.groupKey, result: { acceptedMemberKeys: completion.acceptedMemberKeys } } },
    ];
  }
  return [
    ...cancellationEvents,
    { type: "group.failed", payload: { groupKey: group.groupKey, error: { reason: completion.reason } } },
  ];
}

type GroupCompletionCancellation = {
  members: GroupMember[];
  cancelReason: "parent_failed" | "race_lost" | "quorum_reached";
};

function completionCancellation(
  group: GroupProjection,
  members: readonly GroupMember[],
  completion: GroupCompletion,
): GroupCompletionCancellation | undefined {
  if (completion.status === "running" || !completion.cancelRemaining) return undefined;
  if (completion.status === "failed") {
    return {
      members: members.filter(member => member.status === "ready" || member.status === "running"),
      cancelReason: "parent_failed",
    };
  }
  const accepted = new Set(completion.acceptedMemberKeys);
  return {
    members: members.filter(member => !accepted.has(member.memberKey) && (member.status === "ready" || member.status === "running")),
    cancelReason: group.strategy === "race" ? "race_lost" : "quorum_reached",
  };
}

export function nextGroupCompletionBatchEvents(projection: SchedulerProjection): SchedulerEvent[] {
  for (const group of Object.values(projection.groups)) {
    if (group.groupKey !== group.nodeKey || projection.groups[group.nodeKey] !== group) {
      throw new Error(`Group '${group.groupKey}' has inconsistent owner key '${group.nodeKey}'.`);
    }
    requireGroupOwnerFrame(projection, group);
  }
  const membersByGroup = new Map<string, GroupMember[]>();
  const identitiesByGroup = new Map<string, Set<string>>();
  for (const member of Object.values(projection.groupMembers)) {
    validateGroupMemberIdentity(projection, member);
    const identity = member.memberKind === "branch" ? `branch:${member.branchId}` : `item:${member.itemIndex}`;
    const identities = identitiesByGroup.get(member.groupKey) ?? new Set<string>();
    if (identities.has(identity)) throw new Error(`Group '${member.groupKey}' contains duplicate member identity '${identity}'.`);
    identities.add(identity);
    identitiesByGroup.set(member.groupKey, identities);
    const members = membersByGroup.get(member.groupKey) ?? [];
    members.push(member);
    membersByGroup.set(member.groupKey, members);
  }
  let deepest = -1;
  const frameDepths = new Map<string, number>();
  let candidates: Array<{ group: GroupProjection; members: GroupMember[]; completion: GroupCompletion }> = [];
  for (const group of Object.values(projection.groups)) {
    if (group.status !== "running") continue;
    const depth = groupFrameDepth(projection, group, frameDepths);
    const members = membersByGroup.get(group.groupKey) ?? [];
    const completion = evaluateGroupCompletion(group, members);
    if (completion.status === "running") continue;
    if (depth > deepest) {
      deepest = depth;
      candidates = [{ group, members, completion }];
    } else if (depth === deepest) {
      candidates.push({ group, members, completion });
    }
  }
  const planned = candidates.map(candidate => ({
    ...candidate,
    cancellation: completionCancellation(candidate.group, candidate.members, candidate.completion),
  }));
  const cancellationIndex = indexMemberCancellations(
    projection,
    planned.flatMap(candidate => candidate.cancellation?.members ?? []),
  );
  return planned.flatMap(candidate => completionEventsForGroup(
    projection,
    candidate.group,
    candidate.completion,
    candidate.cancellation,
    cancellationIndex,
  ));
}

function groupFrameDepth(
  projection: SchedulerProjection,
  group: GroupProjection,
  depths: Map<string, number>,
): number {
  requireGroupOwnerFrame(projection, group);
  const seen = new Set<string>();
  const path: string[] = [];
  let frameKey = group.nodeKey;
  for (;;) {
    const knownDepth = depths.get(frameKey);
    if (knownDepth !== undefined) {
      let depth = knownDepth;
      for (let index = path.length - 1; index >= 0; index -= 1) {
        depth += 1;
        depths.set(path[index]!, depth);
      }
      return depths.get(group.nodeKey)!;
    }
    if (seen.has(frameKey)) throw new Error(`Group '${group.groupKey}' has a cyclic frame ancestry.`);
    seen.add(frameKey);
    const frame = projection.frames[frameKey];
    if (!frame) throw new Error(`Group '${group.groupKey}' references missing frame '${frameKey}'.`);
    path.push(frameKey);
    if (frame.parentFrameKey === undefined) {
      let depth = 0;
      for (let index = path.length - 1; index >= 0; index -= 1) {
        depths.set(path[index]!, depth);
        depth += 1;
      }
      return depths.get(group.nodeKey)!;
    }
    frameKey = frame.parentFrameKey;
  }
}

function requireGroupOwnerFrame(projection: SchedulerProjection, group: GroupProjection): SchedulerFrame {
  const frame = projection.frames[group.nodeKey];
  if (!frame) throw new Error(`Group '${group.groupKey}' references missing frame '${group.nodeKey}'.`);
  const tail = frame.instancePath?.at(-1);
  const statusMatches = group.status === "running"
    ? frame.status === "running"
    : group.status === "completed"
      ? frame.status === "running" || frame.status === "completed" || frame.status === "cancelled"
      : group.status === "failed"
        ? frame.status === "running" || frame.status === "failed" || frame.status === "cancelled"
        : frame.status === "running" || frame.status === "cancelled";
  if (frame.frameKind !== "node"
    || !statusMatches
    || frame.nodeKey !== group.nodeKey
    || frame.nodeId !== group.nodeId
    || frame.strategy !== group.strategy
    || (tail !== undefined && (tail.kind !== "node" || tail.nodeId !== group.nodeId))) {
    throw new Error(`Group '${group.groupKey}' has inconsistent owner frame '${group.nodeKey}'.`);
  }
  return frame;
}

function validateGroupMemberIdentity(projection: SchedulerProjection, member: GroupMember): void {
  const group = projection.groups[member.groupKey];
  if (!group) throw new Error(`Group member '${member.memberKey}' references missing group '${member.groupKey}'.`);
  assertMemberKindMatchesGroup(group, member.memberKind);
  if (group.status !== "running" && (member.status === "ready" || member.status === "running")) {
    throw new Error(`Terminal group '${group.groupKey}' contains open member '${member.memberKey}'.`);
  }
  if (member.memberKind === "fanout_item" && (!Number.isSafeInteger(member.itemIndex) || member.itemIndex < 0)) {
    throw new Error(`Fanout group member '${member.memberKey}' has invalid item index '${member.itemIndex}'.`);
  }
  const open = member.status === "ready" || member.status === "running";
  const childFrameKey = member.childFrameKey ?? (projection.frames[member.memberKey] ? member.memberKey : undefined);
  if (childFrameKey === undefined) {
    const instance = projection.instances[member.memberKey];
    if (open && !instance) throw new Error(`Open group member '${member.memberKey}' has no child frame or instance.`);
    if (open && instance && instance.status !== "ready" && instance.status !== "running" && instance.status !== "awaiting") {
      throw new Error(`Open group member '${member.memberKey}' references non-runnable instance '${instance.nodeKey}'.`);
    }
    return;
  }
  const frame = projection.frames[childFrameKey];
  if (!frame) throw new Error(`Group member '${member.memberKey}' references missing child frame '${childFrameKey}'.`);
  const expectedKind = member.memberKind === "branch" ? "branch" : "fanout_item";
  const tail = frame.instancePath?.at(-1);
  const tailMatches = tail === undefined
    || (member.memberKind === "branch"
      ? tail.kind === "branch" && tail.nodeId === group.nodeId && tail.branchId === member.branchId
      : tail.kind === "fanout" && tail.nodeId === group.nodeId && tail.itemIndex === member.itemIndex);
  const ownerPath = projection.frames[group.nodeKey]?.instancePath;
  const pathPrefixMatches = frame.instancePath === undefined || ownerPath === undefined
    || stableJson(frame.instancePath.slice(0, -1)) === stableJson(ownerPath.slice(0, -1));
  if ((member.childFrameKey !== undefined && member.childFrameKey !== member.memberKey)
    || frame.frameKind !== expectedKind
    || frame.parentFrameKey !== group.nodeKey
    || (frame.nodeId !== undefined && frame.nodeId !== group.nodeId)
    || (frame.strategy !== undefined && frame.strategy !== group.strategy)
    || !tailMatches
    || !pathPrefixMatches) {
    throw new Error(`Group member '${member.memberKey}' has inconsistent child frame '${childFrameKey}'.`);
  }
  if (open && frame.status !== "running") {
    throw new Error(`Open group member '${member.memberKey}' references non-running child frame '${childFrameKey}'.`);
  }
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

type MemberCancellationBucket = {
  member: GroupMember;
  frames: SchedulerFrame[];
  descendantInstances: NodeInstance[];
  childMembers: GroupMember[];
  childGroupKeys: string[];
};

type MemberCancellationIndex = {
  buckets: Map<string, MemberCancellationBucket>;
  attemptsByNode: Map<string, SchedulerProjection["attempts"][string][]>;
};

function indexMemberCancellations(projection: SchedulerProjection, members: readonly GroupMember[]): MemberCancellationIndex {
  const buckets = new Map<string, MemberCancellationBucket>();
  for (const member of members) {
    if (buckets.has(member.memberKey)) throw new Error(`Group member '${member.memberKey}' is scheduled for cancellation more than once.`);
    buckets.set(member.memberKey, { member, frames: [], descendantInstances: [], childMembers: [], childGroupKeys: [] });
  }
  const attemptsByNode = new Map<string, SchedulerProjection["attempts"][string][]>();
  if (members.length === 0) return { buckets, attemptsByNode };

  const childrenByParent = new Map<string, string[]>();
  for (const frame of Object.values(projection.frames)) {
    if (frame.parentFrameKey === undefined) continue;
    const children = childrenByParent.get(frame.parentFrameKey) ?? [];
    children.push(frame.frameKey);
    childrenByParent.set(frame.parentFrameKey, children);
  }
  const ownerByFrame = new Map<string, string>();
  for (const member of members) {
    const rootFrameKey = member.childFrameKey ?? member.memberKey;
    if (!projection.frames[rootFrameKey]) continue;
    const pending = [rootFrameKey];
    while (pending.length > 0) {
      const frameKey = pending.pop()!;
      const owner = ownerByFrame.get(frameKey);
      if (owner === member.memberKey) continue;
      if (owner !== undefined) throw new Error(`Cancellation members '${owner}' and '${member.memberKey}' have overlapping frame subtrees.`);
      ownerByFrame.set(frameKey, member.memberKey);
      pending.push(...(childrenByParent.get(frameKey) ?? []));
    }
  }

  for (const frame of Object.values(projection.frames)) {
    const owner = ownerByFrame.get(frame.frameKey);
    if (owner !== undefined) buckets.get(owner)!.frames.push(frame);
  }
  for (const instance of Object.values(projection.instances)) {
    if (instance.parentFrameKey === undefined) continue;
    const owner = ownerByFrame.get(instance.parentFrameKey);
    if (owner !== undefined) buckets.get(owner)!.descendantInstances.push(instance);
  }
  for (const child of Object.values(projection.groupMembers)) {
    if (buckets.has(child.memberKey)) continue;
    const owner = (child.childFrameKey === undefined ? undefined : ownerByFrame.get(child.childFrameKey))
      ?? ownerByFrame.get(child.memberKey);
    if (owner !== undefined) buckets.get(owner)!.childMembers.push(child);
  }
  for (const group of Object.values(projection.groups)) {
    const owner = ownerByFrame.get(group.nodeKey);
    if (owner === undefined || group.nodeKey === buckets.get(owner)!.member.groupKey) continue;
    buckets.get(owner)!.childGroupKeys.push(group.groupKey);
  }
  for (const attempt of Object.values(projection.attempts)) {
    const attempts = attemptsByNode.get(attempt.nodeKey) ?? [];
    attempts.push(attempt);
    attemptsByNode.set(attempt.nodeKey, attempts);
  }
  return { buckets, attemptsByNode };
}

function cancellationEventsForMember(
  projection: SchedulerProjection,
  member: GroupMember,
  cancelReason: "parent_failed" | "race_lost" | "quorum_reached" | "operator_cancelled",
  index: MemberCancellationIndex = indexMemberCancellations(projection, [member]),
): SchedulerEvent[] {
  const bucket = index.buckets.get(member.memberKey);
  if (!bucket) throw new Error(`Group member '${member.memberKey}' is missing from the cancellation index.`);
  const instances = [
    ...(projection.instances[member.memberKey] ? [projection.instances[member.memberKey]!] : []),
    ...bucket.descendantInstances,
  ];
  const attempts = instances.flatMap(instance =>
    (index.attemptsByNode.get(instance.nodeKey) ?? []).filter(attempt => attempt.status === "started"),
  );
  const signalWaits = instances.flatMap(instance => {
    const wait = projection.signalWaits[instance.nodeKey];
    return wait?.status === "awaiting" ? [wait] : [];
  });
  return [
    { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason } },
    ...bucket.childMembers
      .filter(child => child.status === "ready" || child.status === "running")
      .map(child => ({ type: "group.member_cancelled", payload: { memberKey: child.memberKey, cancelReason } }) satisfies SchedulerEvent),
    ...bucket.childGroupKeys
      .filter(groupKey => projection.groups[groupKey]?.status === "running")
      .map(groupKey => ({ type: "group.cancelled", payload: { groupKey, cancelReason } }) satisfies SchedulerEvent),
    ...attempts.map(attempt => ({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason } }) satisfies SchedulerEvent),
    ...signalWaits.map(wait => ({ type: "signal.cancelled", payload: { nodeKey: wait.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...instances
      .filter(instance => instance.status === "ready" || instance.status === "running" || instance.status === "awaiting")
      .map(instance => ({ type: "instance.cancelled", payload: { nodeKey: instance.nodeKey, cancelReason } }) satisfies SchedulerEvent),
    ...bucket.frames
      .filter(frame => !isTerminalFrameStatus(frame.status))
      .sort((left, right) => frameDepth(right) - frameDepth(left))
      .map(frame => ({ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason } }) satisfies SchedulerEvent),
  ];
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
  if (event.type === "control.agent_steer_requested") return;
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
        const transition = loopTransition(frame.loop.transition);
        if (!transition.ok) throw new Error(`Loop frame '${frame.frameKey}' cannot advance before iteration ${frame.loop.iter} has a valid transition.`);
        if (event.payload.state === undefined || stableJson(event.payload.state) !== stableJson(transition.state)) {
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
      ...(event.payload.steerId === undefined ? {} : { steerId: event.payload.steerId }),
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
    if ((event.payload.reason === "steered") !== (event.payload.steerId !== undefined)) {
      throw new Error(`Node instance '${event.payload.nodeKey}' steer requeue metadata is inconsistent.`);
    }
    projection.instances[event.payload.nodeKey] = compactInstance({
      ...instance,
      status: "ready",
      ...(event.payload.readinessSequence === undefined ? {} : { readinessSequence: event.payload.readinessSequence }),
      statusReason: event.payload.reason,
      pendingSteerId: event.payload.steerId,
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
  if (event.type === "instance.started") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "running", statusReason: undefined, pendingSteerId: undefined });
  if (event.type === "instance.awaiting") {
    projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "awaiting", ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
    startReadyAncestorMembers(projection, event.payload.nodeKey);
  }
  if (event.type === "instance.completed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "completed", statusReason: undefined, pendingSteerId: undefined, error: undefined, ...(event.payload.output === undefined ? {} : { output: event.payload.output }), ...(event.payload.acceptedAttemptId === undefined ? {} : { acceptedAttemptId: event.payload.acceptedAttemptId }) });
  if (event.type === "instance.failed") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "failed", pendingSteerId: undefined, error: event.payload.error, ...(event.payload.statusReason === undefined ? {} : { statusReason: event.payload.statusReason }) });
  if (event.type === "instance.cancelled") projection.instances[event.payload.nodeKey] = compactInstance({ ...instance, status: "cancelled", pendingSteerId: undefined, statusReason: event.payload.cancelReason });
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
