import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export type VersionedWakeup = {
  current(): number;
  waitForChange(after: number): Effect.Effect<number>;
  wake(): void;
};

export function createVersionedWakeup(): VersionedWakeup {
  let version = 0;
  let pulse = Deferred.makeUnsafe<number>();
  return {
    current: () => version,
    waitForChange: after => Effect.suspend(() =>
      after === version ? Deferred.await(pulse) : Effect.succeed(version)),
    wake: () => {
      version += 1;
      const current = pulse;
      pulse = Deferred.makeUnsafe<number>();
      Deferred.doneUnsafe(current, Effect.succeed(version));
    },
  };
}
