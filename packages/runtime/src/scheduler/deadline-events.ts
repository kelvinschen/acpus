import { ancestorGroupMembersForNode } from "./membership.js";
import type { SchedulerEvent } from "./events.js";
import type { SchedulerProjection } from "./types.js";

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
