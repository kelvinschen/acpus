import type { NodeIR } from "@acpus/core/ir";
import { resolveAgentSessionIdentity } from "../execution/agent-session.js";
import { indexNodes } from "./ir-walk.js";
import { resolveOccurrenceRef } from "./occurrence-ref.js";
import { scopeForNodeAttempt } from "./scope.js";
import { frozenRunScope, type FrozenSchedulerRun } from "./settle.js";
import {
  SchedulerStoreException,
  schedulerStoreResult,
  type SchedulerSnapshot,
  type SchedulerStoreError,
  type SchedulerStoreResult,
} from "./store-port.js";
import type { SchedulerProjection } from "./types.js";

/** One exact active Agent attempt that the steer planner has approved. */
export type SteerControlTarget = {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
};

export type SteerControlPlan = {
  target: SteerControlTarget;
};

/**
 * Resolves and validates one steer operand against one immutable scheduler
 * snapshot. Mutation repeats this plan in its final transaction; inspection
 * uses the batch projection below for advisory-free capability display.
 */
export function planSteerControl(
  frozen: FrozenSchedulerRun,
  snapshot: SchedulerSnapshot,
  target: string,
): SchedulerStoreResult<SteerControlPlan> {
  const nodes = indexNodes(frozen.ir.root);
  return schedulerStoreResult(() => ({
    target: resolveSteerTarget(target, snapshot, nodes, frozen),
  }));
}

/**
 * Returns exactly the active Agent attempts that would pass the same planner
 * when addressed by their exact attempt id. This is intentionally a compact
 * capability projection: it does not expose rejected targets or diagnostics.
 */
export function steerControlTargets(
  frozen: FrozenSchedulerRun,
  snapshot: SchedulerSnapshot,
): SteerControlTarget[] {
  const nodes = indexNodes(frozen.ir.root);
  const baseScope = frozenRunScope(frozen);
  const candidates = Object.values(snapshot.projection.attempts)
    .filter(attempt => attempt.status === "started")
    .flatMap(attempt => {
      const node = nodes.get(attempt.nodeId);
      if (!node || node.kind !== "agent") return [];
      const identity = resolveAgentSessionIdentity(
        node,
        scopeForNodeAttempt(baseScope, snapshot.projection, attempt.nodeKey),
        attempt.runId,
        attempt.nodeKey,
      );
      return identity.isErr()
        ? []
        : [{ attempt: steerTarget(attempt), sessionName: identity.value.sessionName }];
    });
  const sessionUseCount = new Map<string, number>();
  for (const candidate of candidates) {
    sessionUseCount.set(candidate.sessionName, (sessionUseCount.get(candidate.sessionName) ?? 0) + 1);
  }
  return candidates
    .filter(candidate => sessionUseCount.get(candidate.sessionName) === 1)
    .filter(candidate => activeInstance(snapshot.projection, candidate.attempt.nodeKey))
    .map(candidate => candidate.attempt)
    .sort(compareSteerTargets);
}

function resolveSteerTarget(
  target: string,
  snapshot: SchedulerSnapshot,
  nodes: ReadonlyMap<string, NodeIR>,
  frozen: FrozenSchedulerRun,
): SteerControlTarget {
  const occurrence = resolveOccurrenceRef(
    snapshot.projection,
    target,
    { attempt: "allow" },
  );
  if (occurrence && !occurrence.ok) {
    if (occurrence.error.type === "occurrence-ref-collision") {
      rejectSteer({
        type: "ambiguous-steer-target",
        runId: snapshot.runId,
        targetKey: target,
        candidateKeys: occurrence.error.candidateKeys,
        message: `Scheduler steer target '${target}' is ambiguous. Candidate keys: ${occurrence.error.candidateKeys.join(", ")}.`,
      });
    }
    rejectSteer({
      type: "missing-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      message: `Scheduler steer target '${target}' was not found.`,
    });
  }
  if (occurrence?.value.kind === "frame") {
    rejectSteer({
      type: "invalid-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      status: occurrence.value.kind,
      message: `Steer target '${target}' resolves to a frame, not an Agent node occurrence.`,
    });
  }
  const resolvedTarget = occurrence?.value.kind === "attempt"
    ? occurrence.value.attemptId
    : occurrence?.value.nodeKey ?? target;
  const exactAttempt = snapshot.projection.attempts[resolvedTarget];
  if (exactAttempt) {
    if (exactAttempt.status !== "started") {
      rejectSteer({
        type: "invalid-steer-target",
        runId: snapshot.runId,
        targetKey: target,
        status: exactAttempt.status,
        message: `Steer target attempt '${target}' is already ${exactAttempt.status}.`,
      });
    }
    assertSteerInstanceActive(snapshot, exactAttempt.nodeKey, target);
    return assertAgentSteerSessionAvailable(frozen, snapshot.projection, steerTarget(exactAttempt), nodes);
  }

  const exactInstance = snapshot.projection.instances[resolvedTarget];
  if (exactInstance) {
    const attempts = Object.values(snapshot.projection.attempts)
      .filter(attempt => attempt.nodeKey === resolvedTarget && attempt.status === "started");
    if (attempts.length > 1) throw new Error(`Node instance '${resolvedTarget}' has multiple started attempts.`);
    if (attempts.length === 1) {
      assertSteerInstanceActive(snapshot, resolvedTarget, target);
      return assertAgentSteerSessionAvailable(frozen, snapshot.projection, steerTarget(attempts[0]!), nodes);
    }
    rejectSteer({
      type: "invalid-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      status: exactInstance.status,
      message: `Steer target node instance '${target}' has no started attempt.`,
    });
  }

  const staticNode = nodes.get(target);
  if (staticNode && staticNode.kind !== "agent") {
    rejectSteer({
      type: "invalid-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      status: staticNode.kind,
      message: `Steer target '${target}' is not an Agent node.`,
    });
  }

  const activeMatches = Object.values(snapshot.projection.attempts)
    .filter(attempt => attempt.nodeId === target && attempt.status === "started")
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (activeMatches.length === 1) {
    assertSteerInstanceActive(snapshot, activeMatches[0]!.nodeKey, target);
    return assertAgentSteerSessionAvailable(frozen, snapshot.projection, steerTarget(activeMatches[0]!), nodes);
  }
  if (activeMatches.length > 1) {
    const candidateKeys = [...new Set(activeMatches.map(attempt => attempt.nodeKey))].sort();
    rejectSteer({
      type: "ambiguous-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      candidateKeys,
      message: `Scheduler steer target '${target}' is ambiguous. Candidate nodeKeys: ${candidateKeys.join(", ")}.`,
    });
  }

  const historical = Object.values(snapshot.projection.attempts)
    .filter(attempt => attempt.nodeId === target)
    .sort((left, right) => right.attemptNo - left.attemptNo)[0];
  if (historical) {
    rejectSteer({
      type: "invalid-steer-target",
      runId: snapshot.runId,
      targetKey: target,
      status: historical.status,
      message: `Steer target '${target}' has no started attempt.`,
    });
  }
  rejectSteer({
    type: "missing-steer-target",
    runId: snapshot.runId,
    targetKey: target,
    message: `Scheduler steer target '${target}' was not found.`,
  });
}

function assertSteerInstanceActive(snapshot: SchedulerSnapshot, nodeKey: string, requestedTarget: string): void {
  if (activeInstance(snapshot.projection, nodeKey)) return;
  const instance = snapshot.projection.instances[nodeKey];
  rejectSteer({
    type: "invalid-steer-target",
    runId: snapshot.runId,
    targetKey: requestedTarget,
    status: instance?.status ?? "missing",
    message: `Steer target '${requestedTarget}' does not belong to an active node instance.`,
  });
}

function activeInstance(projection: SchedulerProjection, nodeKey: string): boolean {
  const status = projection.instances[nodeKey]?.status;
  return status === "running" || status === "awaiting";
}

function assertAgentSteerSessionAvailable(
  frozen: FrozenSchedulerRun,
  projection: SchedulerProjection,
  target: SteerControlTarget,
  nodes: ReadonlyMap<string, NodeIR>,
): SteerControlTarget {
  const targetNode = nodes.get(target.nodeId);
  if (!targetNode || targetNode.kind !== "agent") {
    rejectSteer({
      type: "invalid-steer-target",
      runId: target.runId,
      targetKey: target.attemptId,
      status: targetNode?.kind ?? "missing_node",
      message: `Steer target '${target.attemptId}' is not an Agent attempt.`,
    });
  }
  const baseScope = frozenRunScope(frozen);
  const targetIdentity = resolveAgentSessionIdentity(
    targetNode,
    scopeForNodeAttempt(baseScope, projection, target.nodeKey),
    target.runId,
    target.nodeKey,
  );
  if (targetIdentity.isErr()) {
    rejectSteer({
      type: "invalid-steer-target",
      runId: target.runId,
      targetKey: target.attemptId,
      status: "session_resolution_failed",
      message: `Steer target '${target.attemptId}' Agent session identity could not be resolved.`,
    });
  }

  const candidateKeys = Object.values(projection.attempts)
    .filter(attempt => attempt.attemptId !== target.attemptId && attempt.status === "started")
    .flatMap(attempt => {
      const node = nodes.get(attempt.nodeId);
      if (!node || node.kind !== "agent") return [];
      const identity = resolveAgentSessionIdentity(
        node,
        scopeForNodeAttempt(baseScope, projection, attempt.nodeKey),
        attempt.runId,
        attempt.nodeKey,
      );
      if (identity.isErr()) return [];
      return identity.value.sessionName === targetIdentity.value.sessionName ? [attempt.nodeKey] : [];
    })
    .sort();
  if (candidateKeys.length > 0) {
    rejectSteer({
      type: "steer-session-conflict",
      runId: target.runId,
      targetKey: target.nodeKey,
      candidateKeys,
      message: `Agent session for steer target '${target.nodeKey}' is also used by active nodeKeys: ${candidateKeys.join(", ")}.`,
    });
  }
  return target;
}

function steerTarget(attempt: SchedulerProjection["attempts"][string]): SteerControlTarget {
  return {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    nodeKey: attempt.nodeKey,
    nodeId: attempt.nodeId,
    attemptNo: attempt.attemptNo,
  };
}

function compareSteerTargets(left: SteerControlTarget, right: SteerControlTarget): number {
  return left.nodeKey.localeCompare(right.nodeKey)
    || left.attemptNo - right.attemptNo
    || left.attemptId.localeCompare(right.attemptId);
}

function rejectSteer(error: Extract<SchedulerStoreError,
  | { type: "missing-steer-target" }
  | { type: "ambiguous-steer-target" }
  | { type: "invalid-steer-target" }
  | { type: "steer-session-conflict" }
>): never {
  throw new SchedulerStoreException(error);
}
