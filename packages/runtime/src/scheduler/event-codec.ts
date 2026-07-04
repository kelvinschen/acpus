import type { SchedulerEvent } from "./events.js";

const schedulerEventTypes = new Set<string>([
  "control.paused",
  "control.resumed",
  "control.run_retry_requested",
  "frame.started",
  "frame.completed",
  "frame.failed",
  "frame.cancelled",
  "frame.retry_requested",
  "frame.loop_advanced",
  "instance.ready",
  "instance.started",
  "instance.awaiting",
  "instance.requeued",
  "instance.retry_requested",
  "instance.completed",
  "instance.failed",
  "instance.cancelled",
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "attempt.timed_out",
  "attempt.cancelled",
  "attempt.superseded",
  "group.started",
  "group.member_ready",
  "group.member_started",
  "group.member_requeued",
  "group.member_retry_requested",
  "group.member_completed",
  "group.member_failed",
  "group.member_cancelled",
  "group.completed",
  "group.failed",
  "group.cancelled",
  "branch.decided",
  "signal.awaiting",
  "signal.timeout_paused",
  "signal.timeout_resumed",
  "signal.consumed",
  "signal.timed_out",
  "signal.cancelled",
]);

export function isSchedulerEventType(type: string): type is SchedulerEvent["type"] {
  return schedulerEventTypes.has(type);
}

export function decodeSchedulerPayload(payloadJson: string, eventType: string): Record<string, unknown> {
  const envelope = JSON.parse(payloadJson) as unknown;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error(`Scheduler event '${eventType}' has an invalid scheduler envelope.`);
  const payload = (envelope as { schedulerEventVersion?: unknown; payload?: unknown }).payload;
  if ((envelope as { schedulerEventVersion?: unknown }).schedulerEventVersion !== 1 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Scheduler event '${eventType}' has an invalid scheduler envelope.`);
  }
  return payload as Record<string, unknown>;
}
