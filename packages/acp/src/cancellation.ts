import * as Effect from "effect/Effect";

export function interruptOnAbort<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
  signal: AbortSignal,
): Effect.Effect<Success, Failure, Requirements> {
  const aborted = Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return Effect.raceFirst(effect, aborted);
}
