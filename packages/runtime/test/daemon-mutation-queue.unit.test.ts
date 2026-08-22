import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { RuntimeMutationQueue } from "../src/daemon/mutation-queue.js";

describe.concurrent("runtime mutation queue", () => {
  it("continues after a failed mutation", async () => {
    const queue = new RuntimeMutationQueue();
    const failed = Effect.runPromise(queue.enqueue(Effect.sync(() => {
      throw new Error("boom");
    })));
    const recovered = Effect.runPromise(queue.enqueue(Effect.succeed("ok")));

    await expect(failed).rejects.toThrow("boom");
    await expect(recovered).resolves.toBe("ok");
    expect(queue.isIdle()).toBe(true);
  });

  it("provides a completion barrier for accepted mutations", async () => {
    const queue = new RuntimeMutationQueue();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let drained = false;
    const mutation = Effect.runPromise(queue.enqueue(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ));

    await Effect.runPromise(Deferred.await(entered));
    const draining = Effect.runPromise(queue.drain()).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    Deferred.doneUnsafe(release, Effect.void);
    await mutation;
    await draining;
    expect(drained).toBe(true);
  });

  it("finishes an accepted mutation after its caller is interrupted", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const queue = new RuntimeMutationQueue();
      const releaseFirst = Deferred.makeUnsafe<void>();
      let mutated = false;
      const first = yield* Effect.forkChild(
        queue.enqueue(Deferred.await(releaseFirst)),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(
        queue.enqueue(Effect.sync(() => {
          mutated = true;
        })),
        { startImmediately: true },
      );
      const interruption = yield* Effect.forkChild(Fiber.interrupt(second), { startImmediately: true });

      Deferred.doneUnsafe(releaseFirst, Effect.void);
      yield* Fiber.join(first);
      yield* Fiber.join(interruption);

      expect(mutated).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(second))).toBe(true);
      yield* queue.drain();
      expect(queue.isIdle()).toBe(true);
    }));
  });
});
