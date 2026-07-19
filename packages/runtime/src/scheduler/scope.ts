import type { JsonValue } from "@acpus/expression/ir";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import type { InstancePath, InstancePathSegment, SchedulerFrame, SchedulerProjection } from "./types.js";

export function baseScopeForFrame(projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): EvaluationScope {
  if (frame.frameKey === "root") return baseScope;
  if (!frame.parentFrameKey) throw new Error(`Scheduler frame '${frame.frameKey}' has no parent frame.`);
  const parent = projection.frames[frame.parentFrameKey];
  if (!parent) throw new Error(`Scheduler frame '${frame.frameKey}' references missing parent frame '${frame.parentFrameKey}'.`);
  const containingFrameKey = parent && (parent.frameKind === "node" || parent.frameKind === "loop")
    ? parent.parentFrameKey
    : frame.parentFrameKey;
  let scope = containingFrameKey ? completedScopeForFrame(projection, containingFrameKey, baseScope) : baseScope;
  if (frame.frameKind === "fanout_item") {
    const member = projection.groupMembers[frame.frameKey];
    const group = member ? projection.groups[member.groupKey] : undefined;
    if (member?.memberKind !== "fanout_item" || group?.kind !== "fanout") {
      throw new Error(`Fanout item frame '${frame.frameKey}' has inconsistent group membership.`);
    }
    scope = scopeWithFanoutItem(scope, group.nodeId, member.item, member.itemIndex);
  }
  if (frame.frameKind === "loop_iteration") {
    const segment = lastSegment(frame.instancePath);
    if (segment?.kind !== "loop" || parent.frameKind !== "loop") {
      throw new Error(`Loop iteration frame '${frame.frameKey}' has inconsistent identity.`);
    }
    scope = scopeWithLoopIteration(scope, segment.nodeId, segment.iter, parent.loop?.state);
  }
  return scope;
}

export function completedScopeForFrame(projection: SchedulerProjection, frameKey: string, baseScope: EvaluationScope): EvaluationScope {
  const frame = projection.frames[frameKey];
  if (!frame) throw new Error(`Scheduler scope references missing frame '${frameKey}'.`);
  const expectedChildren = expectedScopeChildren(frame);
  const children = new Map<string, { status: string; output?: JsonValue }>();
  for (const [key, instance] of Object.entries(projection.instances)) {
    if (instance.parentFrameKey !== frameKey) continue;
    addScopeChild(frameKey, expectedChildren, children, key, instance.nodeKey, instance.nodeId, instance.status, instance.output);
  }
  for (const [key, child] of Object.entries(projection.frames)) {
    if (child.parentFrameKey !== frameKey) continue;
    if (child.nodeKey === undefined || child.nodeId === undefined) {
      throw new Error(`Scheduler scope frame '${frameKey}' has inconsistent child '${key}'.`);
    }
    addScopeChild(frameKey, expectedChildren, children, key, child.nodeKey, child.nodeId, child.status, child.result);
  }
  let scope = baseScopeForFrame(projection, frame, baseScope);
  for (const [nodeId, nodeKey] of Object.entries(frame.scope)) {
    const child = children.get(nodeKey);
    if (child?.status === "completed") scope = scopeWithNodeOutput(scope, nodeId, child.output);
  }
  return scope;
}

function expectedScopeChildren(frame: SchedulerFrame): Map<string, string> {
  const value = frame.scope as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Scheduler scope frame '${frame.frameKey}' has an invalid durable scope mapping.`);
  }
  const expected = new Map<string, string>();
  for (const [nodeId, nodeKey] of Object.entries(value)) {
    if (nodeId.length === 0 || typeof nodeKey !== "string" || nodeKey.length === 0 || expected.has(nodeKey)) {
      throw new Error(`Scheduler scope frame '${frame.frameKey}' has an invalid durable scope mapping.`);
    }
    expected.set(nodeKey, nodeId);
  }
  return expected;
}

function addScopeChild(
  frameKey: string,
  expected: ReadonlyMap<string, string>,
  children: Map<string, { status: string; output?: JsonValue }>,
  projectionKey: string,
  nodeKey: string,
  nodeId: string,
  status: string,
  output: JsonValue | undefined,
): void {
  const expectedNodeId = expected.get(projectionKey);
  if (projectionKey !== nodeKey || expectedNodeId !== nodeId || children.has(nodeKey)) {
    throw new Error(`Scheduler scope frame '${frameKey}' has inconsistent child '${projectionKey}'.`);
  }
  children.set(nodeKey, { status, ...(output === undefined ? {} : { output }) });
}

export function scopeForNodeAttempt(baseScope: EvaluationScope, projection: SchedulerProjection, nodeKey: string): EvaluationScope {
  const instance = projection.instances[nodeKey];
  if (!instance) throw new Error(`Scheduler attempt references missing node instance '${nodeKey}'.`);
  return instance.parentFrameKey
    ? completedScopeForFrame(projection, instance.parentFrameKey, baseScope)
    : completedScopeForFrame(projection, "root", baseScope);
}

export function scopeWithNodeOutput(scope: EvaluationScope, nodeId: string, output: JsonValue | undefined): EvaluationScope {
  return { ...scope, nodes: { ...scope.nodes, [nodeId]: { status: "completed", output } } };
}

export function scopeWithFanoutItem(scope: EvaluationScope, nodeId: string, item: JsonValue, itemIndex: number): EvaluationScope {
  return { ...scope, fanout: { ...scope.fanout, [nodeId]: { item, itemIndex } } };
}

export function scopeWithLoopIteration(scope: EvaluationScope, nodeId: string, iteration: number, state?: JsonValue): EvaluationScope {
  return { ...scope, loop: { ...scope.loop, [nodeId]: { index: iteration, round: iteration + 1, ...(state === undefined ? {} : { state }) } } };
}

function lastSegment(path: InstancePath | undefined): InstancePathSegment | undefined {
  return path?.[path.length - 1];
}
