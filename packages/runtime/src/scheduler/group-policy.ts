import { stableJson } from "../stable-json.js";
import { isTerminalFrameStatus, type SchedulerEvent } from "./events.js";
import { ancestorGroupMembersForNode, descendantFramesForFrame } from "./membership.js";
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

type TargetedRetryGroupBlocker = { status: "completed" | "failed"; reason: string };

export function targetedRetryGroupAssessment(
  group: GroupProjection,
  members: readonly GroupMember[],
  reopenedDependencyKeys: ReadonlySet<string>,
): {
  blockerFor(targetMemberKey: string): TargetedRetryGroupBlocker | undefined;
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

function assertMemberKindMatchesGroup(group: GroupProjection, memberKind: GroupMember["memberKind"]): void {
  if (group.kind === "parallel" && memberKind !== "branch") throw new Error(`Parallel group '${group.groupKey}' requires branch members.`);
  if (group.kind === "fanout" && memberKind !== "fanout_item") throw new Error(`Fanout group '${group.groupKey}' requires fanout item members.`);
}
