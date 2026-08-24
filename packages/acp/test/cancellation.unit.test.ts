import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { interruptOnAbort } from "../src/cancellation.js";

describe("interruptOnAbort", () => {
  it("interrupts on an external AbortSignal and removes its listener", async () => {
    const signal = trackedSignal();
    const running = Effect.runPromiseExit(interruptOnAbort(Effect.never, signal.value));
    await new Promise(resolve => setImmediate(resolve));

    signal.abort();
    const exit = await running;

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(signal.added).toBe(1);
    expect(signal.removed).toBe(1);
  });

  it("removes the listener when the wrapped Effect completes", async () => {
    const signal = trackedSignal();
    const result = await Effect.runPromise(interruptOnAbort(
      Effect.yieldNow.pipe(Effect.as("done")),
      signal.value,
    ));

    expect(result).toBe("done");
    expect(signal.added).toBe(1);
    expect(signal.removed).toBe(1);
  });
});

function trackedSignal(): {
  value: AbortSignal;
  readonly added: number;
  readonly removed: number;
  abort(): void;
} {
  let aborted = false;
  let listener: (() => void) | undefined;
  let added = 0;
  let removed = 0;
  return {
    value: {
      get aborted() { return aborted; },
      addEventListener(_type: string, next: EventListenerOrEventListenerObject | null) {
        added += 1;
        listener = typeof next === "function" ? next as () => void : () => next?.handleEvent(new Event("abort"));
      },
      removeEventListener() {
        removed += 1;
        listener = undefined;
      },
    } as unknown as AbortSignal,
    get added() { return added; },
    get removed() { return removed; },
    abort() {
      aborted = true;
      listener?.();
    },
  };
}
