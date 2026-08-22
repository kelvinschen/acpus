import * as Result from "effect/Result";
import type { AgentSessionCheckpoint } from "../execution/agent-operation-plan.js";
import type { SchedulerEvent } from "./events.js";

export type RuntimeSteerProjection = Readonly<{
  steerId: string;
  delivery: "interrupt_continue";
  fencedAttemptId: string;
}> & (
  | Readonly<{ phase: "draining" | "queued" }>
  | Readonly<{ phase: "replacement_started"; replacementAttemptId: string }>
  | Readonly<{ phase: "blocked"; blockedCheckpoint: "acceptance_unknown" | "terminal_unknown" }>
);

export type SteerLifecycleError = Readonly<{
  type: "invalid_steer_lifecycle";
  steerId: string;
  message: string;
}>;

export type SequencedSchedulerEvent = Readonly<{
  sequence: number;
  event: SchedulerEvent;
}>;

export function projectSteerLifecycle(
  steerId: string,
  events: readonly SequencedSchedulerEvent[],
  checkpoint?: AgentSessionCheckpoint,
): Result.Result<RuntimeSteerProjection, SteerLifecycleError> {
  if (events.some((item, index) => !Number.isInteger(item.sequence)
    || item.sequence < 1
    || (index > 0 && events[index - 1]!.sequence >= item.sequence))) {
    return invalid(steerId, "requires strictly increasing durable event sequences");
  }
  const requested = events.filter((item): item is SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "control.agent_steer_requested" }> } =>
    item.event.type === "control.agent_steer_requested" && item.event.payload.steerId === steerId);
  if (requested.length !== 1) return invalid(steerId, "requires exactly one requested event");
  const request = requested[0]!;
  const superseded = events.filter((item): item is SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "attempt.superseded" }> } =>
    item.event.type === "attempt.superseded" && item.event.payload.attemptId === request.event.payload.fencedAttemptId);
  if (superseded.length !== 1) return invalid(steerId, "requires exactly one matching supersede event");
  const supersede = superseded[0]!;
  if (supersede.event.payload.cancelReason !== "operator_steered" || supersede.sequence <= request.sequence) {
    return invalid(steerId, "requires an operator-steered fence after the request");
  }

  const requeued = events.filter((item): item is SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "instance.requeued" }> } =>
    item.event.type === "instance.requeued" && item.event.payload.reason === "steered" && item.event.payload.steerId === steerId);
  const replacements = events.filter((item): item is SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "attempt.started" }> } =>
    item.event.type === "attempt.started" && item.event.payload.steerId === steerId);
  const blocked = events.filter((item): item is SequencedSchedulerEvent & { event: Extract<SchedulerEvent, { type: "control.agent_steer_blocked" }> } =>
    item.event.type === "control.agent_steer_blocked" && item.event.payload.steerId === steerId);

  if (blocked.length > 0) {
    if (blocked.length !== 1 || requeued.length > 0 || replacements.length > 0) {
      return invalid(steerId, "blocked lifecycle cannot also queue or start a replacement");
    }
    const block = blocked[0]!;
    const failed = events.filter(item =>
      item.event.type === "instance.failed" && item.event.payload.nodeKey === block.event.payload.nodeKey);
    if (failed.length !== 1 || block.event.payload.fencedAttemptId !== request.event.payload.fencedAttemptId) {
      return invalid(steerId, "blocked lifecycle requires matching fenced Attempt and instance failure");
    }
    if (block.event.payload.nodeKey !== request.event.payload.nodeKey
      || block.sequence <= supersede.sequence
      || failed[0]!.sequence <= block.sequence) {
      return invalid(steerId, "blocked lifecycle events are out of order");
    }
    if (checkpoint !== block.event.payload.checkpoint) return invalid(steerId, "blocked checkpoint does not match durable Session state");
    return Result.succeed({
      steerId,
      delivery: request.event.payload.delivery,
      fencedAttemptId: request.event.payload.fencedAttemptId,
      phase: "blocked",
      blockedCheckpoint: block.event.payload.checkpoint,
    });
  }

  if (requeued.length > 1 || replacements.length > 1) return invalid(steerId, "lifecycle contains duplicate queue or replacement events");
  if (requeued.length === 0) {
    if (replacements.length > 0) return invalid(steerId, "replacement started before the directive was queued");
    return Result.succeed({ steerId, delivery: request.event.payload.delivery, fencedAttemptId: request.event.payload.fencedAttemptId, phase: "draining" });
  }
  const queued = requeued[0]!;
  if (queued.event.payload.nodeKey !== request.event.payload.nodeKey
    || queued.event.payload.steerEventSequence !== request.sequence) {
    return invalid(steerId, "queue event does not reference the requested target and control authority");
  }
  if (queued.sequence <= supersede.sequence) return invalid(steerId, "directive was queued before the fenced Attempt settled");
  if (replacements.length === 0) {
    if (checkpoint !== "terminal_observed") return invalid(steerId, "queue requires a terminal-observed checkpoint");
    return Result.succeed({ steerId, delivery: request.event.payload.delivery, fencedAttemptId: request.event.payload.fencedAttemptId, phase: "queued" });
  }
  const replacement = replacements[0]!;
  if (replacement.sequence <= queued.sequence) return invalid(steerId, "replacement started before the directive was queued");
  if (replacement.event.payload.nodeKey !== request.event.payload.nodeKey
    || replacement.event.payload.steerEventSequence !== request.sequence) {
    return invalid(steerId, "replacement Attempt does not preserve queue admission lineage");
  }
  return Result.succeed({
    steerId,
    delivery: request.event.payload.delivery,
    fencedAttemptId: request.event.payload.fencedAttemptId,
    phase: "replacement_started",
    replacementAttemptId: replacement.event.payload.attemptId,
  });
}

function invalid(steerId: string, reason: string): Result.Result<never, SteerLifecycleError> {
  return Result.fail({
    type: "invalid_steer_lifecycle",
    steerId,
    message: `Steer '${steerId}' ${reason}.`,
  });
}
