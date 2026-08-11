import { describe, expect, it } from "vitest";
import { RuntimeMutationQueue } from "../src/daemon/mutation-queue.js";

describe.concurrent("runtime mutation queue", () => {
  it("runs enqueued work in FIFO order", async () => {
    const queue = new RuntimeMutationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      return "first";
    });
    const second = queue.enqueue(() => {
      order.push("second");
      return "second";
    });

    expect(queue.isIdle()).toBe(false);
    await waitUntil(() => order.includes("first:start"));
    expect(order).toEqual(["first:start"]);
    releaseFirst();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.isIdle()).toBe(true);
  });

  it("continues after a failed mutation", async () => {
    const queue = new RuntimeMutationQueue();
    const failed = queue.enqueue(() => {
      throw new Error("boom");
    });
    const recovered = queue.enqueue(() => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(recovered).resolves.toBe("ok");
    expect(queue.isIdle()).toBe(true);
  });

  it("provides a completion barrier for accepted mutations", async () => {
    const queue = new RuntimeMutationQueue();
    let release!: () => void;
    let drained = false;
    const mutation = queue.enqueue(() => new Promise<void>(resolve => {
      release = resolve;
    }));

    await waitUntil(() => release !== undefined);
    const draining = queue.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await mutation;
    await draining;
    expect(drained).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
