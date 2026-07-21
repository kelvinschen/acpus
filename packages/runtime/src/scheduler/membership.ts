import type { GroupMember, NodeInstance, SchedulerFrame, SchedulerProjection } from "./types.js";

export function ancestorGroupMembersForNode(projection: SchedulerProjection, nodeKey: string): GroupMember[] {
  const direct = projection.groupMembers[nodeKey];
  const ancestors = ancestorGroupMembersForFrame(projection, projection.instances[nodeKey]?.parentFrameKey);
  return direct ? [direct, ...ancestors] : ancestors;
}

export function ancestorGroupMembersForFrame(projection: SchedulerProjection, frameKey: string | undefined): GroupMember[] {
  return frameAncestors(projection, frameKey)
    .map(frame => projection.groupMembers[frame.frameKey])
    .filter(member => member !== undefined);
}

export function descendantFramesForFrame(projection: SchedulerProjection, frameKey: string): SchedulerFrame[] {
  if (!projection.frames[frameKey]) return [];
  const keys = new Set<string>([frameKey]);
  for (;;) {
    const before = keys.size;
    for (const frame of Object.values(projection.frames)) {
      if (frame.parentFrameKey && keys.has(frame.parentFrameKey)) keys.add(frame.frameKey);
    }
    if (keys.size === before) return Object.values(projection.frames).filter(frame => keys.has(frame.frameKey));
  }
}

export function descendantInstancesForFrame(projection: SchedulerProjection, frameKey: string): NodeInstance[] {
  const frameKeys = new Set(descendantFramesForFrame(projection, frameKey).map(frame => frame.frameKey));
  return Object.values(projection.instances).filter(instance => instance.parentFrameKey !== undefined && frameKeys.has(instance.parentFrameKey));
}

export function descendantGroupMembersForFrame(projection: SchedulerProjection, frameKey: string): GroupMember[] {
  const frameKeys = new Set(descendantFramesForFrame(projection, frameKey).map(frame => frame.frameKey));
  return Object.values(projection.groupMembers)
    .filter(member => (member.childFrameKey !== undefined && frameKeys.has(member.childFrameKey)) || frameKeys.has(member.memberKey));
}

export function descendantGroupKeysForFrame(projection: SchedulerProjection, frameKey: string): string[] {
  const frameKeys = new Set(descendantFramesForFrame(projection, frameKey).map(frame => frame.frameKey));
  return Object.values(projection.groups)
    .filter(group => frameKeys.has(group.nodeKey))
    .map(group => group.groupKey);
}

function frameAncestors(projection: SchedulerProjection, frameKey: string | undefined): SchedulerFrame[] {
  const frames: SchedulerFrame[] = [];
  for (let current = frameKey; current !== undefined;) {
    const frame = projection.frames[current];
    if (!frame) return frames;
    frames.push(frame);
    current = frame.parentFrameKey;
  }
  return frames;
}
