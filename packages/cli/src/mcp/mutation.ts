import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Replay the same durable request when its caller leaves before receiving the receipt. */
export function settleMutation<A extends { run: { id: string } }, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return operation.pipe(Effect.onInterrupt(() =>
    operation.pipe(Effect.timeoutOption(30_000), Effect.matchEffect({
      onFailure: () => unknownOutcome,
      onSuccess: confirmed => Option.isSome(confirmed)
        ? Effect.logInfo(`Detached MCP mutation confirmed for Run '${confirmed.value.run.id}'.`)
        : unknownOutcome,
    })),
  ));
}

const unknownOutcome = Effect.logWarning("Detached MCP mutation outcome is unknown. Inspect workspace Runs before repeating the operation.");
