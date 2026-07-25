import { ancestorGroupMembersForNode } from "./membership.js";
import type { GroupMember, NodeInstance, SchedulerProjection } from "./types.js";

export type SchedulerAdmission = {
  kind: "executor" | "signal";
  instance: NodeInstance;
};

export type SelectNextAdmissionInput = {
  projection: SchedulerProjection;
  maxLeafConcurrency: number;
  ownerLocalUnsettled: number;
  ownerLocalUnsettledExecutorResources?: ReadonlySet<string>;
  executorResourceFor?: (instance: NodeInstance) => string | undefined;
  signalNodeIds: ReadonlySet<string>;
};

/** Call again only after the returned instance has durably left ready state. */
export function selectNextAdmission(input: SelectNextAdmissionInput): SchedulerAdmission | undefined {
  if (!runCanAdmit(input.projection)) return undefined;

  const durableStarted = Object.values(input.projection.attempts)
    .filter(attempt => attempt.status === "started").length;
  const executorCapacityAvailable = durableStarted < input.maxLeafConcurrency
    && input.ownerLocalUnsettled < input.maxLeafConcurrency;
  const runningMembers = runningMemberKeysByGroup(input.projection);

  for (const instance of Object.values(input.projection.instances).filter(instance => instance.status === "ready").sort(byReadiness)) {
    const kind = input.signalNodeIds.has(instance.nodeId) ? "signal" : "executor";
    if (kind === "executor" && !executorCapacityAvailable) continue;
    if (kind === "executor" && executorResourceBlocked(input, instance)) continue;
    if (!groupsAdmit(input.projection, instance.nodeKey, runningMembers)) continue;
    return { kind, instance };
  }
  return undefined;
}

function executorResourceBlocked(input: SelectNextAdmissionInput, instance: NodeInstance): boolean {
  const resource = input.executorResourceFor?.(instance);
  return resource !== undefined && input.ownerLocalUnsettledExecutorResources?.has(resource) === true;
}

function runCanAdmit(projection: SchedulerProjection): boolean {
  return !projection.run.paused
    && (projection.run.status === "pending" || projection.run.status === "running" || projection.run.status === "awaiting");
}

function runningMemberKeysByGroup(projection: SchedulerProjection): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>();
  for (const member of Object.values(projection.groupMembers)) {
    if (member.status !== "running") continue;
    const memberKeys = byGroup.get(member.groupKey) ?? new Set<string>();
    memberKeys.add(member.memberKey);
    byGroup.set(member.groupKey, memberKeys);
  }
  return byGroup;
}

function groupsAdmit(
  projection: SchedulerProjection,
  nodeKey: string,
  runningMembers: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const checked = new Set<string>();
  for (const member of ancestorGroupMembersForNode(projection, nodeKey)) {
    const identity = memberIdentity(member);
    if (checked.has(identity)) continue;
    checked.add(identity);
    if (member.status !== "ready" && member.status !== "running") return false;

    const group = projection.groups[member.groupKey];
    if (!group) throw new Error(`Group member '${member.memberKey}' references missing group '${member.groupKey}'.`);
    if (group.status !== "running") return false;
    if (member.status === "running" || group.maxConcurrency === undefined) continue;
    if ((runningMembers.get(member.groupKey)?.size ?? 0) >= group.maxConcurrency) return false;
  }
  return true;
}

function memberIdentity(member: GroupMember): string {
  return `${member.groupKey}\u0000${member.memberKey}`;
}

function byReadiness(left: NodeInstance, right: NodeInstance): number {
  const readiness = (left.readinessSequence ?? Number.MAX_SAFE_INTEGER) - (right.readinessSequence ?? Number.MAX_SAFE_INTEGER);
  if (readiness !== 0 || left.nodeKey === right.nodeKey) return readiness;
  return left.nodeKey < right.nodeKey ? -1 : 1;
}
