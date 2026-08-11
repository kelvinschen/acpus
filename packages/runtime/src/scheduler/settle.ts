import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { continueRootEvents } from "./materialize.js";
import type { SchedulerEvent } from "./events.js";
import { attemptTimeoutEvents, signalTimeoutEvents } from "./deadline-events.js";
import { nextGroupCompletionBatchEvents } from "./group-policy.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { applySchedulerEvents } from "./transitions.js";
import type { SchedulerProjection } from "./types.js";

export type FrozenSchedulerRun = {
  ir: WorkflowIR;
  input: JsonValue;
  meta: Record<string, string>;
};

export function frozenRunScope(frozen: FrozenSchedulerRun): EvaluationScope {
  return {
    input: frozen.input,
    nodes: {},
    meta: frozen.meta,
    fanout: {},
    loop: {},
  };
}

export function nextFrozenRunTransitionEvents(
  frozen: FrozenSchedulerRun,
  projection: SchedulerProjection,
  now: Date,
): SchedulerEvent[] {
  return nextSchedulerTransitionEvents(
    projection,
    () => continueRootEvents(frozen.ir, projection, frozenRunScope(frozen)),
    now,
  );
}

export function nextSchedulerTransitionEvents(
  projection: SchedulerProjection,
  materialize: () => SchedulerEvent[],
  now: Date,
): SchedulerEvent[] {
  const groupEvents = nextGroupCompletionBatchEvents(projection);
  if (groupEvents.length > 0) return groupEvents;
  const materializationEvents = materialize();
  if (materializationEvents.length > 0) return materializationEvents;
  const attemptEvents = attemptTimeoutEvents(projection, now);
  return attemptEvents.length > 0 ? attemptEvents : signalTimeoutEvents(projection, now);
}

export function settleFrozenProjection(input: {
  frozen: FrozenSchedulerRun;
  projection: SchedulerProjection;
  initialEvents?: readonly SchedulerEvent[];
  now: Date;
}): { projection: SchedulerProjection; events: SchedulerEvent[] } {
  const events = [...(input.initialEvents ?? [])];
  let projection = events.length === 0 ? input.projection : applySchedulerEvents(input.projection, events);
  for (;;) {
    const derived = nextFrozenRunTransitionEvents(input.frozen, projection, input.now);
    if (derived.length === 0) return { projection, events };
    events.push(...derived);
    projection = applySchedulerEvents(projection, derived);
  }
}

export function settleFrozenSnapshot(input: {
  frozen: FrozenSchedulerRun;
  snapshot: SchedulerSnapshot;
  now: Date;
}): { snapshot: SchedulerSnapshot; events: SchedulerEvent[] } {
  const settled = settleFrozenProjection({
    frozen: input.frozen,
    projection: input.snapshot.projection,
    now: input.now,
  });
  return {
    events: settled.events,
    snapshot: {
      ...input.snapshot,
      version: input.snapshot.version + settled.events.length,
      projection: settled.projection,
    },
  };
}
