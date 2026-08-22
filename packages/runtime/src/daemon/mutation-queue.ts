import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export class RuntimeMutationQueue {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private depth = 0;

  enqueue<Success, Failure, Requirements>(
    work: Effect.Effect<Success, Failure, Requirements>,
  ): Effect.Effect<Success, Failure, Requirements> {
    return Effect.uninterruptible(Effect.suspend(() => {
      this.depth += 1;
      return this.semaphore.withPermit(work).pipe(
        Effect.ensuring(Effect.sync(() => {
          this.depth -= 1;
        })),
      );
    }));
  }

  isIdle(): boolean {
    return this.depth === 0;
  }

  drain(): Effect.Effect<void> {
    return this.semaphore.withPermit(Effect.void);
  }
}
