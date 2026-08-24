import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import { CoalescingNodeProgressWriter, type NodeProgressWriter } from "../src/progress/writer.js";
import type { WriteNodeProgressInput } from "../src/store/store.js";

describe("coalescing node progress writer", () => {
  it.effect("coalesces active progress by owned attempt", () => Effect.scoped(Effect.gen(function* () {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);
      yield* writer.start(yield* Effect.scope);

      writer.writeNodeProgress(progress("first"));
      writer.writeNodeProgress(progress("second"));
      expect(writes).toEqual([]);

      yield* TestClock.adjust(1_000);
      expect(writes).toMatchObject([{ message: "second" }]);
  })));

  it.effect("does not let stale ownership replace a pending current-attempt update", () => Effect.scoped(Effect.gen(function* () {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);
      yield* writer.start(yield* Effect.scope);

      writer.writeNodeProgress(progress("current"));
      writer.writeNodeProgress({ ...progress("stale"), attemptId: "attempt_old", ownerEpoch: 1 });
      yield* TestClock.adjust(1_000);

      expect(writes.map(write => write.message)).toEqual(["current", "stale"]);
  })));

  it.effect("flushes terminal progress immediately", () => Effect.scoped(Effect.gen(function* () {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);
      yield* writer.start(yield* Effect.scope);

      writer.writeNodeProgress(progress("running"));
      writer.writeNodeProgress(progress("done", "completed"));

      expect(writes).toMatchObject([{ message: "done", status: "completed" }]);
      yield* TestClock.adjust(1_000);
      expect(writes).toHaveLength(1);
  })));

  it.effect("does not fail when best-effort progress writes fail", () => Effect.scoped(Effect.gen(function* () {
      const writer = new CoalescingNodeProgressWriter({
        writeNodeProgress: () => {
          throw new Error("store busy");
        },
      }, 1_000);
      yield* writer.start(yield* Effect.scope);

      writer.writeNodeProgress(progress("running"));
      yield* TestClock.adjust(1_000);
      writer.writeNodeProgress(progress("terminal", "completed"));
      expect(() => writer.flushAll()).not.toThrow();
  })));

  it.effect("flushes matching pending progress before the interval", () => Effect.scoped(Effect.gen(function* () {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);
      yield* writer.start(yield* Effect.scope);

      writer.writeNodeProgress(progress("run-1-node"));
      writer.writeNodeProgress({ ...progress("run-2-node"), runId: "run_2" });
      writer.flushMatching(input => input.runId === "run_1" && input.nodeKey === "node_1");

      expect(writes).toMatchObject([{ runId: "run_1", message: "run-1-node" }]);
      yield* TestClock.adjust(1_000);
      expect(writes).toMatchObject([
        { runId: "run_1", message: "run-1-node" },
        { runId: "run_2", message: "run-2-node" },
      ]);
  })));
});

function progress(message: string, status = "running"): WriteNodeProgressInput {
  return {
    runId: "run_1",
    nodeKey: "node_1",
    nodeId: "node_1",
    attemptId: "attempt_current",
    ownerEpoch: 2,
    kind: "agent",
    status,
    message,
  };
}

function progressStore(writes: WriteNodeProgressInput[]): NodeProgressWriter {
  return {
    writeNodeProgress(input: WriteNodeProgressInput): void {
      writes.push(input);
    },
  };
}
