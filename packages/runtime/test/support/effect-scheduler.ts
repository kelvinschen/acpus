import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeNodeProcessHost } from "@acpus/owned-process";
import {
  advanceRun as advanceRunEffect,
  type AdvanceRunInput,
  type AdvanceRunSummary,
} from "../../src/scheduler/advance.js";
import {
  advanceFrozenRun as advanceFrozenRunEffect,
  type AdvanceFrozenRunInput,
} from "../../src/scheduler/runtime-runner.js";

export function advanceRun(input: AdvanceRunInput): Promise<AdvanceRunSummary> {
  return Effect.runPromise(advanceRunEffect(input));
}

export function advanceFrozenRun(
  input: Omit<AdvanceFrozenRunInput, "processes"> & Partial<Pick<AdvanceFrozenRunInput, "processes">>,
): Promise<AdvanceRunSummary> {
  return Effect.runPromise(advanceFrozenRunEffect({
    ...input,
    processes: input.processes ?? makeNodeProcessHost(),
  }));
}

export function interruptFrozenRunWhen(
  input: Omit<AdvanceFrozenRunInput, "processes"> & Partial<Pick<AdvanceFrozenRunInput, "processes">>,
  shouldInterrupt: () => boolean,
): Promise<void> {
  const reached = Deferred.makeUnsafe<void>();
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(advanceFrozenRunEffect({
      ...input,
      processes: input.processes ?? makeNodeProcessHost(),
      onCheckpoint: () => shouldInterrupt()
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void,
    }));
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(fiber);
  })));
}
