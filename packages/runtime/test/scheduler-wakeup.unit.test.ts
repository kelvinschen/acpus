import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { createVersionedWakeup } from "../src/scheduler/wakeup.js";

describe("versioned scheduler wakeup", () => {
  it("does not lose a wake between observing and waiting", async () => {
    const wakeup = createVersionedWakeup();
    const observed = wakeup.current();

    wakeup.wake();

    await expect(Effect.runPromise(wakeup.waitForChange(observed))).resolves.toBe(1);
  });

  it("coalesces concurrent waiters onto the next version", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const wakeup = createVersionedWakeup();
      const first = yield* Effect.forkChild(wakeup.waitForChange(0), { startImmediately: true });
      const second = yield* Effect.forkChild(wakeup.waitForChange(0), { startImmediately: true });

      wakeup.wake();

      expect(yield* Fiber.joinAll([first, second])).toEqual([1, 1]);
    }));
  });

  it("rotates the pulse across repeated versions", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const wakeup = createVersionedWakeup();
      const first = yield* Effect.forkChild(wakeup.waitForChange(0), { startImmediately: true });
      wakeup.wake();
      expect(yield* Fiber.join(first)).toBe(1);

      const second = yield* Effect.forkChild(wakeup.waitForChange(1), { startImmediately: true });
      wakeup.wake();
      expect(yield* Fiber.join(second)).toBe(2);
    }));
  });

  it("interrupts one waiter without consuming the wake for another", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const wakeup = createVersionedWakeup();
      const interrupted = yield* Effect.forkChild(wakeup.waitForChange(0), { startImmediately: true });
      const live = yield* Effect.forkChild(wakeup.waitForChange(0), { startImmediately: true });

      yield* Fiber.interrupt(interrupted);
      const interruptedExit = yield* Fiber.await(interrupted);
      expect(Exit.hasInterrupts(interruptedExit)).toBe(true);
      wakeup.wake();
      expect(yield* Fiber.join(live)).toBe(1);
    }));
  });
});
