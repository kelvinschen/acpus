import type { EvaluationScope } from "../evaluation/evaluator.js";
import type { InstancePath, InstancePathSegment, SchedulerFrame, SchedulerProjection } from "./types.js";

export function baseScopeForFrame(projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): EvaluationScope {
  if (frame.frameKey === "root") return baseScope;
  const parent = frame.parentFrameKey ? projection.frames[frame.parentFrameKey] : undefined;
  const containingFrameKey = parent && (parent.frameKind === "node" || parent.frameKind === "loop")
    ? parent.parentFrameKey
    : frame.parentFrameKey;
  let scope = containingFrameKey ? completedScopeForFrame(projection, containingFrameKey, baseScope) : baseScope;
  if (frame.frameKind === "fanout_item") {
    const member = projection.groupMembers[frame.frameKey];
    const group = member ? projection.groups[member.groupKey] : undefined;
    if (member && group?.kind === "fanout") scope = withFanout(scope, group.nodeId, member.item, member.itemIndex ?? 0);
  }
  if (frame.frameKind === "loop_iteration") {
    const segment = lastSegment(frame.instancePath);
    const loopFrame = frame.parentFrameKey ? projection.frames[frame.parentFrameKey] : undefined;
    if (segment?.kind === "loop") scope = loopScopeForIteration(scope, segment.nodeId, segment.iter, loopFrame?.loop?.state);
  }
  return scope;
}

export function completedScopeForFrame(projection: SchedulerProjection, frameKey: string, baseScope: EvaluationScope): EvaluationScope {
  const frame = projection.frames[frameKey];
  if (!frame) return baseScope;
  let scope = baseScopeForFrame(projection, frame, baseScope);
  for (const instance of Object.values(projection.instances)) {
    if (instance.parentFrameKey === frameKey && instance.status === "completed") scope = withNodeOutput(scope, instance.nodeId, instance.output);
  }
  for (const child of Object.values(projection.frames)) {
    if (child.parentFrameKey === frameKey && child.nodeKey && child.nodeId && child.status === "completed") scope = withNodeOutput(scope, child.nodeId, child.result);
  }
  return scope;
}

export function scopeForNodeAttempt(baseScope: EvaluationScope, projection: SchedulerProjection, nodeKey: string): EvaluationScope {
  const instance = projection.instances[nodeKey];
  return instance?.parentFrameKey
    ? completedScopeForFrame(projection, instance.parentFrameKey, baseScope)
    : completedScopeForFrame(projection, "root", baseScope);
}

function withNodeOutput(scope: EvaluationScope, nodeId: string, output: unknown): EvaluationScope {
  return { ...scope, nodes: { ...scope.nodes, [nodeId]: { status: "completed", output } } };
}

function withFanout(scope: EvaluationScope, nodeId: string, item: unknown, itemIndex: number): EvaluationScope {
  return { ...scope, fanout: { ...scope.fanout, [nodeId]: { item, itemIndex } } };
}

function loopScopeForIteration(scope: EvaluationScope, nodeId: string, iter: number, state?: unknown): EvaluationScope {
  return { ...scope, loop: { ...scope.loop, [nodeId]: { index: iter, round: iter + 1, ...(state === undefined ? {} : { state }) } } };
}

function lastSegment(path: InstancePath | undefined): InstancePathSegment | undefined {
  return path?.[path.length - 1];
}
