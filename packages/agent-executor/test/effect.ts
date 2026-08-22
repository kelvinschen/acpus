import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export function settle<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}
