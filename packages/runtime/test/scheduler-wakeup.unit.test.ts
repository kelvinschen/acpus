import { describe, expect, it } from "vitest";
import { createVersionedWakeup } from "../src/scheduler/wakeup.js";

describe("versioned scheduler wakeup", () => {
  it("does not lose a wake between observing and waiting", async () => {
    const wakeup = createVersionedWakeup();
    const observed = wakeup.current();

    wakeup.wake();

    await expect(wakeup.waitForChange(observed)).resolves.toBe(1);
  });

  it("coalesces concurrent waiters onto the next version", async () => {
    const wakeup = createVersionedWakeup();
    const first = wakeup.waitForChange(0);
    const second = wakeup.waitForChange(0);

    wakeup.wake();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });
});
