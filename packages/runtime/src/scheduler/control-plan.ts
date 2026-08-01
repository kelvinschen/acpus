import { err, ok, type Result } from "neverthrow";
import { ancestorGroupMembersForFrame, ancestorGroupMembersForNode } from "./membership.js";
import { resolveOccurrenceRef } from "./occurrence-ref.js";
import {
  applySchedulerEvents,
  cancellationEventsForFrame,
  cancellationEventsForNode,
  targetedRetryGroupAssessment,
} from "./transitions.js";
import type { SchedulerEvent } from "./events.js";
import { settleFrozenSnapshot, type FrozenSchedulerRun } from "./settle.js";
import {
  SchedulerStoreException,
  schedulerStoreResult,
  type SchedulerSnapshot,
  type SchedulerStoreError,
  type SchedulerStoreResult,
} from "./store-port.js";
import type {
  GroupMember,
  GroupProjection,
  NodeInstance,
  SchedulerFrame,
  SchedulerProjection,
} from "./types.js";

export type RuntimeControlTarget = {
  target: string;
  kind: "node" | "frame";
  nodeId?: string;
};

export type RetryControlPlan = {
  resolvedTarget: string;
  events: SchedulerEvent[];
};

export type CancelControlPlan = {
  resolvedTarget?: string;
  events: SchedulerEvent[];
};

type RetryPlanningContext = {
  membersByGroup: ReadonlyMap<string, readonly GroupMember[]>;
  childrenByFrame: ReadonlyMap<string, readonly SchedulerFrame[]>;
  instancesByFrame: ReadonlyMap<string, readonly NodeInstance[]>;
  groupByFrame: ReadonlyMap<string, GroupProjection>;
  groupAssessments: Map<string, RetryGroupAssessment>;
  dependencyBlockers: Map<string, GroupMember | undefined>;
  framePathEligibility: Map<string, boolean>;
  groupPathEligibility: Map<string, boolean>;
  visitingFramePaths: Set<string>;
  visitingGroupPaths: Set<string>;
};

type RetryGroupPlan = {
  member: GroupMember;
  dependencies: readonly GroupMember[];
  blocker: ReturnType<RetryGroupAssessment["assessment"]["blockerFor"]>;
};

type RetryGroupAssessment = {
  dependencies: readonly GroupMember[];
  assessment: ReturnType<typeof targetedRetryGroupAssessment>;
};

type RetryAssessment = {
  resolvedTarget: string;
  kind: "node" | "frame";
  readinessSequence?: number;
  ancestors: readonly RetryGroupPlan[];
};

type RetryDependencyOutcome = "blocked" | "complete" | "work";

export function planRetryControl(
  snapshot: SchedulerSnapshot,
  target: string,
): SchedulerStoreResult<RetryControlPlan> {
  const context = retryPlanningContext(snapshot.projection);
  return schedulerStoreResult(() => {
    const plan = materializeRetryPlan(assessRetry(snapshot, target, context));
    // Mutation admission retains the reducer's invariant check. Batch
    // capability projection stops at the equivalent pure assessment.
    applySchedulerEvents(snapshot.projection, plan.events);
    return plan;
  });
}

export function validateRetryControlRun(
  snapshot: SchedulerSnapshot,
  target: string,
): SchedulerStoreResult<void> {
  return schedulerStoreResult(() =>
    assertTargetedRetryRunOpen(snapshot.runId, target, snapshot.projection.run.status));
}

export function planCancelControl(
  snapshot: SchedulerSnapshot,
  target?: string,
): SchedulerStoreResult<CancelControlPlan> {
  return schedulerStoreResult(() => {
    const plan = planCancel(snapshot, target);
    if (plan.events.length > 0) applySchedulerEvents(snapshot.projection, plan.events);
    return plan;
  });
}

export function retryControlTargets(snapshot: SchedulerSnapshot): RuntimeControlTarget[] {
  if (!targetedRetryRunOpen(snapshot.projection.run.status)) return [];
  const candidates = [
    ...Object.values(snapshot.projection.frames)
      .filter(frame => frame.status === "failed" && (frame.frameKind === "node" || frame.frameKind === "loop"))
      .map(frame => controlTarget(frame.frameKey, "frame", frame.nodeId)),
    ...Object.values(snapshot.projection.instances)
      .filter(instance => instance.status === "failed")
      .map(instance => controlTarget(instance.nodeKey, "node", instance.nodeId)),
  ].sort(compareControlTargets);
  if (candidates.length === 0) return [];
  const context = retryPlanningContext(snapshot.projection);
  const targets: RuntimeControlTarget[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.target)) {
      throw new Error(`Scheduler control target '${candidate.target}' has both frame and node identities.`);
    }
    seen.add(candidate.target);
    if (retryCandidateEligible(snapshot, candidate, context)) targets.push(candidate);
  }
  return targets;
}

export function settleRetryControlSnapshot(input: {
  frozen: FrozenSchedulerRun;
  snapshot: SchedulerSnapshot;
  now: Date;
}): { snapshot: SchedulerSnapshot; events: SchedulerEvent[] } {
  return targetedRetryRunOpen(input.snapshot.projection.run.status)
    ? settleFrozenSnapshot(input)
    : { snapshot: input.snapshot, events: [] };
}

function retryCandidateEligible(
  snapshot: SchedulerSnapshot,
  candidate: RuntimeControlTarget,
  context: RetryPlanningContext,
): boolean {
  if (candidate.kind === "frame") {
    const frame = snapshot.projection.frames[candidate.target];
    if (!frame) throw new Error(`Retry frame '${candidate.target}' disappeared during planning.`);
    return framePathEligible(snapshot.projection, frame.parentFrameKey, context)
      && groupPathEligible(snapshot.projection, frame.parentFrameKey, context);
  }
  const instance = snapshot.projection.instances[candidate.target];
  if (!instance) throw new Error(`Retry node '${candidate.target}' disappeared during planning.`);
  if (instance.statusReason === "expression_resolution_failed") return false;
  if (!framePathEligible(snapshot.projection, instance.parentFrameKey, context)) return false;
  const directMember = snapshot.projection.groupMembers[candidate.target];
  return (!directMember || groupMemberEligible(snapshot.projection, directMember, context))
    && groupPathEligible(snapshot.projection, instance.parentFrameKey, context);
}

function framePathEligible(
  projection: SchedulerProjection,
  frameKey: string | undefined,
  context: RetryPlanningContext,
): boolean {
  if (frameKey === undefined) return true;
  const cached = context.framePathEligibility.get(frameKey);
  if (cached !== undefined) return cached;
  if (context.visitingFramePaths.has(frameKey)) {
    throw new Error(`Retry target ancestry is cyclic at frame '${frameKey}'.`);
  }
  context.visitingFramePaths.add(frameKey);
  const frame = projection.frames[frameKey];
  if (!frame) throw new Error(`Retry target references missing ancestor frame '${frameKey}'.`);
  let eligible: boolean;
  if (frame.status === "completed" || frame.status === "cancelled") eligible = false;
  else if (frame.status !== "running" && frame.status !== "failed") {
    throw new Error(`Retry target has non-runnable ancestor frame '${frame.frameKey}' in status '${frame.status}'.`);
  } else {
    eligible = framePathEligible(projection, frame.parentFrameKey, context);
  }
  context.visitingFramePaths.delete(frameKey);
  context.framePathEligibility.set(frameKey, eligible);
  return eligible;
}

function groupPathEligible(
  projection: SchedulerProjection,
  frameKey: string | undefined,
  context: RetryPlanningContext,
): boolean {
  if (frameKey === undefined) return true;
  const cached = context.groupPathEligibility.get(frameKey);
  if (cached !== undefined) return cached;
  if (context.visitingGroupPaths.has(frameKey)) {
    throw new Error(`Retry group ancestry is cyclic at frame '${frameKey}'.`);
  }
  context.visitingGroupPaths.add(frameKey);
  const frame = projection.frames[frameKey];
  if (!frame) throw new Error(`Retry target references missing ancestor frame '${frameKey}'.`);
  const member = projection.groupMembers[frameKey];
  const eligible = (!member || groupMemberEligible(projection, member, context))
    && groupPathEligible(projection, frame.parentFrameKey, context);
  context.visitingGroupPaths.delete(frameKey);
  context.groupPathEligibility.set(frameKey, eligible);
  return eligible;
}

function groupMemberEligible(
  projection: SchedulerProjection,
  member: GroupMember,
  context: RetryPlanningContext,
): boolean {
  if (member.status !== "failed") return false;
  const group = projection.groups[member.groupKey];
  if (!group) {
    throw new Error(`Group member '${member.memberKey}' references missing group '${member.groupKey}'.`);
  }
  if (group.status === "completed" || group.status === "cancelled") return false;
  const plan = retryGroupPlan(group, member, context);
  return !plan.blocker
    && !retryDependencyBlocker(projection, group.groupKey, plan.dependencies, context);
}

export function canCancelRun(snapshot: SchedulerSnapshot): boolean {
  const planned = planCancelControl(snapshot);
  return planned.isOk() && planned.value.events.length > 0;
}

function assessRetry(
  snapshot: SchedulerSnapshot,
  target: string,
  context: RetryPlanningContext,
): RetryAssessment {
  assertTargetedRetryRunOpen(snapshot.runId, target, snapshot.projection.run.status);
  const targetKey = retryTargetKey(target, snapshot).match(
    value => value,
    rejectControl,
  );
  const instance = snapshot.projection.instances[targetKey];
  const frame = snapshot.projection.frames[targetKey];
  assertSingleControlIdentity(snapshot.projection, targetKey);
  if (!instance && !frame) {
    rejectControl({
      type: "missing-retry-target",
      runId: snapshot.runId,
      targetKey,
      message: `Retry target '${targetKey}' was not found.`,
    });
  }
  if (frame && !instance) {
    if (frame.status !== "failed") {
      rejectControl({
        type: "invalid-retry-target",
        runId: snapshot.runId,
        targetKey,
        status: frame.status,
        message: `Frame '${targetKey}' cannot be retried from ${frame.status}.`,
      });
    }
    if (frame.frameKind !== "node" && frame.frameKind !== "loop") {
      rejectControl({
        type: "invalid-retry-target",
        runId: snapshot.runId,
        targetKey,
        status: frame.status,
        message: `Frame '${targetKey}' is not a retryable public node frame.`,
      });
    }
    assertRetryableAncestorFrames(snapshot.runId, targetKey, snapshot.projection, frame.parentFrameKey);
    const ancestors = assessRetryAncestorGroups(
      snapshot.runId,
      targetKey,
      snapshot.projection,
      ancestorGroupMembersForFrame(snapshot.projection, frame.parentFrameKey),
      context,
    );
    return { resolvedTarget: targetKey, kind: "frame", ancestors };
  }
  if (!instance) {
    rejectControl({
      type: "missing-retry-target",
      runId: snapshot.runId,
      targetKey,
      message: `Retry target '${targetKey}' was not found.`,
    });
  }
  if (instance.status !== "failed") {
    rejectControl({
      type: "invalid-retry-target",
      runId: snapshot.runId,
      targetKey,
      status: instance.status,
      message: `Node instance '${targetKey}' cannot be retried from ${instance.status}.`,
    });
  }
  if (instance.statusReason === "expression_resolution_failed") {
    rejectControl({
      type: "invalid-retry-target",
      runId: snapshot.runId,
      targetKey,
      status: instance.statusReason,
      message: `Node instance '${targetKey}' failed before execution and must be retried through its containing frame or run.`,
    });
  }
  assertRetryableAncestorFrames(snapshot.runId, targetKey, snapshot.projection, instance.parentFrameKey);
  const ancestors = assessRetryAncestorGroups(
    snapshot.runId,
    targetKey,
    snapshot.projection,
    ancestorGroupMembersForNode(snapshot.projection, targetKey),
    context,
  );
  return {
    resolvedTarget: targetKey,
    kind: "node",
    ...(instance.readinessSequence === undefined
      ? {}
      : { readinessSequence: instance.readinessSequence }),
    ancestors,
  };
}

function materializeRetryPlan(assessment: RetryAssessment): RetryControlPlan {
  const retryDependencyMemberKeys = assessment.ancestors.flatMap(plan =>
    plan.dependencies.map(dependency => dependency.memberKey));
  const dependencies = retryDependencyMemberKeys.length === 0
    ? {}
    : { retryDependencyMemberKeys };
  const targetEvent: SchedulerEvent = assessment.kind === "frame"
    ? {
      type: "frame.retry_requested",
      payload: { frameKey: assessment.resolvedTarget, ...dependencies },
    }
    : {
      type: "instance.retry_requested",
      payload: {
        nodeKey: assessment.resolvedTarget,
        ...(assessment.readinessSequence === undefined
          ? {}
          : { readinessSequence: assessment.readinessSequence }),
        ...dependencies,
      },
    };
  return {
    resolvedTarget: assessment.resolvedTarget,
    events: [
      targetEvent,
      ...assessment.ancestors.map(plan => ({
        type: "group.member_retry_requested",
        payload: {
          memberKey: plan.member.memberKey,
          readinessSequence: plan.member.readinessSequence,
        },
      }) satisfies SchedulerEvent),
    ],
  };
}

function planCancel(snapshot: SchedulerSnapshot, target: string | undefined): CancelControlPlan {
  if (target === undefined && snapshot.projection.run.status === "canceled") return { events: [] };
  const targetKey = target === undefined
    ? "root"
    : cancelTargetKey(target, snapshot).match(value => value, rejectControl);
  assertSingleControlIdentity(snapshot.projection, targetKey);
  const status = snapshot.projection.frames[targetKey]?.status
    ?? snapshot.projection.instances[targetKey]?.status;
  if (status && terminalStatus(status)) {
    rejectControl({
      type: "invalid-cancel-target",
      runId: snapshot.runId,
      targetKey,
      status,
      message: `Cancel target '${targetKey}' is already ${status}.`,
    });
  }
  const events = targetKey === "root"
    && !snapshot.projection.frames.root
    && (snapshot.projection.run.status === "pending"
      || snapshot.projection.run.status === "paused")
    ? [
      { type: "frame.started", payload: { runId: snapshot.runId, frameKey: "root", frameKind: "root" } },
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "operator_cancelled" } },
    ] satisfies SchedulerEvent[]
    : targetKey === "root"
      ? cancellationEventsForFrame(snapshot.projection, "root", "operator_cancelled")
      : snapshot.projection.frames[targetKey]
        ? cancellationEventsForFrame(snapshot.projection, targetKey, "operator_cancelled")
        : cancellationEventsForNode(snapshot.projection, targetKey, "operator_cancelled");
  if (events.length === 0) {
    if (status) {
      rejectControl({
        type: "invalid-cancel-target",
        runId: snapshot.runId,
        targetKey,
        status,
        message: `Cancel target '${targetKey}' is already ${status}.`,
      });
    }
    rejectControl({
      type: "missing-cancel-target",
      runId: snapshot.runId,
      targetKey,
      message: `Cancel target '${targetKey}' was not found.`,
    });
  }
  return {
    ...(target === undefined ? {} : { resolvedTarget: targetKey }),
    events,
  };
}

function retryPlanningContext(projection: SchedulerProjection): RetryPlanningContext {
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
  const groupByFrame = new Map<string, GroupProjection>();
  for (const group of Object.values(projection.groups)) {
    if (groupByFrame.has(group.nodeKey)) {
      throw new Error(`Frame '${group.nodeKey}' owns multiple groups.`);
    }
    groupByFrame.set(group.nodeKey, group);
  }
  return {
    membersByGroup,
    childrenByFrame,
    instancesByFrame,
    groupByFrame,
    groupAssessments: new Map(),
    dependencyBlockers: new Map(),
    framePathEligibility: new Map(),
    groupPathEligibility: new Map(),
    visitingFramePaths: new Set(),
    visitingGroupPaths: new Set(),
  };
}

function assertTargetedRetryRunOpen(
  runId: string,
  targetKey: string,
  status: SchedulerProjection["run"]["status"],
): void {
  if (targetedRetryRunOpen(status)) return;
  rejectControl({
    type: "invalid-retry-target",
    runId,
    targetKey,
    status,
    message: `Cannot retry target '${targetKey}' in a ${status} run.`,
  });
}

function targetedRetryRunOpen(status: SchedulerProjection["run"]["status"]): boolean {
  return status !== "completed" && status !== "canceled" && status !== "paused";
}

function rejectBlockedTargetedRetry(runId: string, targetKey: string, reason: string): never {
  return rejectControl({
    type: "invalid-retry-target",
    runId,
    targetKey,
    status: "blocked",
    message: `Target '${targetKey}' cannot make progress because ${reason}; use run-level retry or fork.`,
  });
}

function assessRetryAncestorGroups(
  runId: string,
  targetKey: string,
  projection: SchedulerProjection,
  members: readonly GroupMember[],
  context: RetryPlanningContext,
): RetryGroupPlan[] {
  const plans: RetryGroupPlan[] = [];
  for (const member of members) {
    if (member.status !== "failed") {
      const detail = member.status === "cancelled" && member.terminalReason === "parent_failed"
        ? " is outside the failed completion path"
        : ` cannot be retried from ${member.status}`;
      rejectControl({
        type: "invalid-retry-target",
        runId,
        targetKey,
        status: member.status,
        message: `Group member '${member.memberKey}'${detail}.`,
      });
    }
    const group = projection.groups[member.groupKey];
    if (!group) {
      throw new Error(`Group member '${member.memberKey}' references missing group '${member.groupKey}'.`);
    }
    if (group.status === "completed" || group.status === "cancelled") {
      rejectControl({
        type: "invalid-retry-target",
        runId,
        targetKey,
        status: group.status,
        message: `Target '${targetKey}' belongs to ${group.status} group '${group.groupKey}'.`,
      });
    }
    const groupPlan = retryGroupPlan(group, member, context);
    const blocker = groupPlan.blocker;
    if (blocker) {
      rejectControl({
        type: "invalid-retry-target",
        runId,
        targetKey,
        status: "blocked",
        message: `Target '${targetKey}' cannot make progress because group '${group.groupKey}' would immediately become ${blocker.status} (${blocker.reason}); use run-level retry or fork.`,
      });
    }
    plans.push(groupPlan);
  }
  for (const plan of plans) {
    const blockedDependency = retryDependencyBlocker(
      projection,
      plan.member.groupKey,
      plan.dependencies,
      context,
    );
    if (blockedDependency) {
      rejectBlockedTargetedRetry(
        runId,
        targetKey,
        `completion dependency '${blockedDependency.memberKey}' contains an independent failure blocker`,
      );
    }
  }
  return plans;
}

function retryGroupPlan(
  group: SchedulerProjection["groups"][string],
  target: GroupMember,
  context: RetryPlanningContext,
): RetryGroupPlan {
  let cached = context.groupAssessments.get(group.groupKey);
  if (!cached) {
    const members = context.membersByGroup.get(group.groupKey) ?? [];
    const dependencies = members
      .filter(member =>
        member.status === "cancelled"
        && member.terminalReason === "parent_failed")
      .sort((left, right) =>
        left.readinessSequence - right.readinessSequence
        || left.memberKey.localeCompare(right.memberKey));
    cached = {
      dependencies,
      assessment: targetedRetryGroupAssessment(
        group,
        members,
        new Set(dependencies.map(dependency => dependency.memberKey)),
      ),
    };
    context.groupAssessments.set(group.groupKey, cached);
  }
  return {
    member: target,
    dependencies: cached.dependencies,
    blocker: cached.assessment.blockerFor(target.memberKey),
  };
}

function retryDependencyBlocker(
  projection: SchedulerProjection,
  groupKey: string,
  dependencies: readonly GroupMember[],
  context: RetryPlanningContext,
): GroupMember | undefined {
  if (context.dependencyBlockers.has(groupKey)) {
    return context.dependencyBlockers.get(groupKey);
  }
  const blocker = dependencies.length === 0
    ? undefined
    : dependencyRecoveryBlocker(projection, dependencies, context);
  context.dependencyBlockers.set(groupKey, blocker);
  return blocker;
}

function dependencyRecoveryBlocker(
  projection: SchedulerProjection,
  dependencies: readonly GroupMember[],
  context: RetryPlanningContext,
): GroupMember | undefined {
  const rootMemberKeys = new Set(dependencies.map(member => member.memberKey));
  const rootFrameKeys = new Set<string>();
  for (const member of dependencies) {
    const rootFrameKey = member.childFrameKey ?? member.memberKey;
    if (projection.frames[rootFrameKey]) rootFrameKeys.add(rootFrameKey);
    else if (member.childFrameKey !== undefined) {
      throw new Error(`Retry dependency member '${member.memberKey}' references missing frame '${member.childFrameKey}'.`);
    }
  }
  const frameKeys = new Set<string>();
  const pending = [...rootFrameKeys];
  while (pending.length > 0) {
    const frameKey = pending.pop()!;
    if (frameKeys.has(frameKey)) continue;
    frameKeys.add(frameKey);
    pending.push(...(context.childrenByFrame.get(frameKey) ?? []).map(frame => frame.frameKey));
  }

  const frameOutcomes = new Map<string, RetryDependencyOutcome>();
  const groupOutcomes = new Map<string, RetryDependencyOutcome>();
  const visitingFrames = new Set<string>();
  const visitingGroups = new Set<string>();
  const parentFailed = (status: string, reason: string | undefined, selected: boolean) =>
    status === "cancelled" && reason === "parent_failed" && selected;

  const instanceOutcome = (instance: NodeInstance): RetryDependencyOutcome => {
    const selected = rootMemberKeys.has(instance.nodeKey)
      || (instance.parentFrameKey !== undefined && frameKeys.has(instance.parentFrameKey));
    if (parentFailed(instance.status, instance.statusReason, selected)) return "work";
    if (instance.status === "completed") return "complete";
    if (instance.status === "failed" || instance.status === "cancelled") return "blocked";
    if (instance.status === "pending") {
      throw new Error(`Retry dependency instance '${instance.nodeKey}' has non-runnable status 'pending'.`);
    }
    return "work";
  };
  const memberOutcome = (member: GroupMember): RetryDependencyOutcome => {
    const selected = rootMemberKeys.has(member.memberKey)
      || (member.childFrameKey !== undefined && frameKeys.has(member.childFrameKey))
      || frameKeys.has(member.memberKey);
    if (!parentFailed(member.status, member.terminalReason, selected)) {
      if (member.status === "completed") return "complete";
      if (member.status === "failed" || member.status === "cancelled") return "blocked";
    }
    const frameKey = member.childFrameKey ?? member.memberKey;
    const frame = projection.frames[frameKey];
    if (frame) return frameOutcome(frame);
    if (member.childFrameKey !== undefined) {
      throw new Error(`Retry dependency member '${member.memberKey}' references missing frame '${member.childFrameKey}'.`);
    }
    const instance = projection.instances[member.memberKey];
    if (!instance) {
      throw new Error(`Retry dependency member '${member.memberKey}' has no runnable backing state.`);
    }
    return instanceOutcome(instance);
  };
  const groupOutcome = (group: GroupProjection): RetryDependencyOutcome => {
    const cached = groupOutcomes.get(group.groupKey);
    if (cached) return cached;
    if (visitingGroups.has(group.groupKey)) {
      throw new Error(`Retry dependency group '${group.groupKey}' has cyclic membership.`);
    }
    visitingGroups.add(group.groupKey);
    const selected = frameKeys.has(group.nodeKey);
    let outcome: RetryDependencyOutcome;
    if (group.status === "completed") outcome = "complete";
    else if (group.status === "failed"
      || (group.status === "cancelled" && !parentFailed(group.status, group.error?.reason as string | undefined, selected))) {
      outcome = "blocked";
    } else {
      const outcomes = (context.membersByGroup.get(group.groupKey) ?? []).map(memberOutcome);
      if (group.strategy === "all") {
        outcome = outcomes.includes("blocked")
          ? "blocked"
          : outcomes.every(candidate => candidate === "complete") ? "complete" : "work";
      } else if (group.strategy === "race") {
        outcome = outcomes.includes("complete")
          ? "complete"
          : outcomes.includes("work") ? "work" : "blocked";
      } else {
        const quorum = group.quorumCount;
        if (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum <= 0) {
          throw new Error(`Quorum group '${group.groupKey}' has invalid quorum count '${quorum}'.`);
        }
        const complete = outcomes.filter(candidate => candidate === "complete").length;
        const possible = complete + outcomes.filter(candidate => candidate === "work").length;
        outcome = complete >= quorum ? "complete" : possible >= quorum ? "work" : "blocked";
      }
    }
    visitingGroups.delete(group.groupKey);
    groupOutcomes.set(group.groupKey, outcome);
    return outcome;
  };
  const frameOutcome = (frame: SchedulerFrame): RetryDependencyOutcome => {
    const cached = frameOutcomes.get(frame.frameKey);
    if (cached) return cached;
    if (visitingFrames.has(frame.frameKey)) {
      throw new Error(`Retry dependency frame '${frame.frameKey}' has cyclic ancestry.`);
    }
    visitingFrames.add(frame.frameKey);
    const selected = frameKeys.has(frame.frameKey);
    let outcome: RetryDependencyOutcome;
    if (frame.status === "completed") outcome = "complete";
    else if (frame.status === "failed"
      || (frame.status === "cancelled" && !parentFailed(frame.status, frame.terminalReason, selected))) {
      outcome = "blocked";
    } else if (frame.status !== "running"
      && !parentFailed(frame.status, frame.terminalReason, selected)) {
      throw new Error(`Retry dependency frame '${frame.frameKey}' has non-runnable status '${frame.status}'.`);
    } else {
      const group = context.groupByFrame.get(frame.frameKey);
      if (group) outcome = groupOutcome(group);
      else {
        const descendants = [
          ...(context.childrenByFrame.get(frame.frameKey) ?? []).map(frameOutcome),
          ...(context.instancesByFrame.get(frame.frameKey) ?? []).map(instanceOutcome),
        ];
        outcome = descendants.includes("blocked") ? "blocked" : "work";
      }
    }
    visitingFrames.delete(frame.frameKey);
    frameOutcomes.set(frame.frameKey, outcome);
    return outcome;
  };

  for (const dependency of dependencies) {
    if (memberOutcome(dependency) === "blocked") return dependency;
  }
  return undefined;
}

function assertRetryableAncestorFrames(
  runId: string,
  targetKey: string,
  projection: SchedulerProjection,
  frameKey: string | undefined,
): void {
  const seen = new Set<string>();
  for (let current = frameKey; current !== undefined;) {
    if (seen.has(current)) {
      throw new Error(`Retry target '${targetKey}' has cyclic frame ancestry at '${current}'.`);
    }
    seen.add(current);
    const frame = projection.frames[current];
    if (!frame) {
      throw new Error(`Retry target '${targetKey}' references missing ancestor frame '${current}'.`);
    }
    if (frame.status === "completed" || frame.status === "cancelled") {
      rejectControl({
        type: "invalid-retry-target",
        runId,
        targetKey,
        status: frame.status,
        message: `Target '${targetKey}' belongs to ${frame.status} frame '${frame.frameKey}'.`,
      });
    }
    if (frame.status !== "running" && frame.status !== "failed") {
      throw new Error(`Retry target '${targetKey}' has non-runnable ancestor frame '${frame.frameKey}' in status '${frame.status}'.`);
    }
    current = frame.parentFrameKey;
  }
}

function retryTargetKey(
  target: string,
  snapshot: SchedulerSnapshot,
): Result<string, SchedulerStoreError> {
  const occurrence = occurrenceControlTargetKey(target, snapshot, "retry");
  if (occurrence) return occurrence;
  if (target !== "root"
    && (snapshot.projection.instances[target] || snapshot.projection.frames[target])) {
    return ok(target);
  }
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && instance.status === "failed")
    .map(instance => instance.nodeKey);
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame =>
      (frame.frameKind === "node" || frame.frameKind === "loop")
      && frame.nodeId === target
      && frame.status === "failed")
    .map(frame => frame.frameKey);
  const matches = [...instanceMatches, ...frameMatches].sort(compareStrings);
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length > 1) {
    return err({
      type: "ambiguous-retry-target",
      runId: snapshot.runId,
      targetKey: target,
      candidateKeys: matches,
      message: `Scheduler retry target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`,
    });
  }
  if (target === "root" && snapshot.projection.frames.root) return ok("root");
  return ok(target);
}

function cancelTargetKey(
  target: string,
  snapshot: SchedulerSnapshot,
): Result<string, SchedulerStoreError> {
  const occurrence = occurrenceControlTargetKey(target, snapshot, "cancel");
  if (occurrence) return occurrence;
  if (target !== "root"
    && (snapshot.projection.instances[target] || snapshot.projection.frames[target])) {
    return ok(target);
  }
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && !terminalStatus(instance.status))
    .map(instance => instance.nodeKey);
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame =>
      (frame.frameKind === "node" || frame.frameKind === "loop")
      && frame.nodeId === target
      && !terminalStatus(frame.status))
    .map(frame => frame.frameKey);
  const matches = [...instanceMatches, ...frameMatches].sort(compareStrings);
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length > 1) {
    return err({
      type: "ambiguous-cancel-target",
      runId: snapshot.runId,
      targetKey: target,
      candidateKeys: matches,
      message: `Scheduler cancel target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`,
    });
  }
  if (target === "root" && snapshot.projection.frames.root) return ok("root");
  return ok(target);
}

function occurrenceControlTargetKey(
  target: string,
  snapshot: SchedulerSnapshot,
  control: "retry" | "cancel",
): Result<string, SchedulerStoreError> | undefined {
  const occurrence = resolveOccurrenceRef(snapshot.projection, target, { attempt: "reject" });
  if (!occurrence) return undefined;
  if (occurrence.ok) {
    if (occurrence.value.kind === "node") return ok(occurrence.value.nodeKey);
    if (occurrence.value.kind === "frame") return ok(occurrence.value.frameKey);
  } else if (occurrence.error.type === "occurrence-ref-collision") {
    const message = `Scheduler ${control} target '${target}' is ambiguous. Candidate target keys: ${occurrence.error.candidateKeys.join(", ")}.`;
    return control === "retry"
      ? err({
          type: "ambiguous-retry-target",
          runId: snapshot.runId,
          targetKey: target,
          candidateKeys: occurrence.error.candidateKeys,
          message,
        })
      : err({
          type: "ambiguous-cancel-target",
          runId: snapshot.runId,
          targetKey: target,
          candidateKeys: occurrence.error.candidateKeys,
          message,
        });
  } else if (occurrence.error.type !== "occurrence-ref-attempt-not-allowed") {
    return undefined;
  }
  const message = `${control === "retry" ? "Retry" : "Cancel"} target '${target}' selects an attempt; ${control} the occurrence without an attempt suffix.`;
  return control === "retry"
    ? err({
        type: "invalid-retry-target",
        runId: snapshot.runId,
        targetKey: target,
        status: "attempt-selector",
        message,
      })
    : err({
        type: "invalid-cancel-target",
        runId: snapshot.runId,
        targetKey: target,
        status: "attempt-selector",
        message,
      });
}

function terminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function assertSingleControlIdentity(
  projection: SchedulerProjection,
  target: string,
): void {
  if (projection.instances[target] && projection.frames[target]) {
    throw new Error(`Scheduler control target '${target}' has both frame and node identities.`);
  }
}

function controlTarget(
  target: string,
  kind: RuntimeControlTarget["kind"],
  nodeId: string | undefined,
): RuntimeControlTarget {
  return {
    target,
    kind,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function compareControlTargets(
  left: RuntimeControlTarget,
  right: RuntimeControlTarget,
): number {
  return compareStrings(left.target, right.target);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectControl(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
}
