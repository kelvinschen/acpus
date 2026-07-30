import type { RunDetails, RunDynamicFrame } from "../store/store.js";

/** Whether an awaiting Signal prevents this subject from making progress. */
export function signalBlocksInspectionTarget(run: RunDetails, nodeKey: string): boolean {
  const dynamic = run.dynamic;
  const instance = dynamic?.nodeInstances.find(candidate => candidate.nodeKey === nodeKey);
  if (!instance) return false;
  const frames = new Map((dynamic?.frames ?? []).map(frame => [frame.frameKey, frame]));
  for (let frame = instance.parentFrameKey ? frames.get(instance.parentFrameKey) : undefined; frame; frame = frame.parentFrameKey ? frames.get(frame.parentFrameKey) : undefined) {
    const group = dynamic?.groups.find(candidate => candidate.nodeKey === frame.nodeKey);
    if (group && (group.strategy === "race" || group.strategy === "quorum") && !groupBlockedBySignals(run, group.groupKey, frames)) {
      return false;
    }
  }
  return true;
}

function groupBlockedBySignals(
  run: RunDetails,
  groupKey: string,
  frames: ReadonlyMap<string, RunDynamicFrame>,
): boolean {
  const members = (run.dynamic?.groupMembers ?? []).filter(member => member.groupKey === groupKey);
  const open = members.filter(member => member.status === "ready" || member.status === "running");
  if (open.length === 0) return false;
  const awaiting = new Set((run.dynamic?.signalWaits ?? [])
    .filter(wait => wait.status === "awaiting")
    .flatMap(wait => groupMemberForWait(run, wait.nodeKey, groupKey, frames)));
  return open.every(member => awaiting.has(member.memberKey));
}

function groupMemberForWait(
  run: RunDetails,
  nodeKey: string,
  groupKey: string,
  frames: ReadonlyMap<string, RunDynamicFrame>,
): string | undefined {
  const instance = run.dynamic?.nodeInstances.find(candidate => candidate.nodeKey === nodeKey);
  for (let frame = instance?.parentFrameKey ? frames.get(instance.parentFrameKey) : undefined; frame; frame = frame.parentFrameKey ? frames.get(frame.parentFrameKey) : undefined) {
    const member = run.dynamic?.groupMembers.find(candidate => candidate.groupKey === groupKey && candidate.childFrameKey === frame.frameKey);
    if (member) return member.memberKey;
  }
  return undefined;
}
