import { describe, expect, it, vi } from "vitest";
import { CoalescingNodeProgressWriter } from "../src/progress/writer.js";
import type { RuntimeStore, WriteNodeProgressInput } from "../src/store/store.js";

describe("coalescing node progress writer", () => {
  it("coalesces active progress by owned attempt", () => {
    vi.useFakeTimers();
    try {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);

      writer.writeNodeProgress(progress("first"));
      writer.writeNodeProgress(progress("second"));
      expect(writes).toEqual([]);

      vi.advanceTimersByTime(1_000);
      expect(writes).toMatchObject([{ message: "second" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale ownership replace a pending current-attempt update", () => {
    vi.useFakeTimers();
    try {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);

      writer.writeNodeProgress(progress("current"));
      writer.writeNodeProgress({ ...progress("stale"), attemptId: "attempt_old", ownerEpoch: 1 });
      vi.advanceTimersByTime(1_000);

      expect(writes.map(write => write.message)).toEqual(["current", "stale"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes terminal progress immediately", () => {
    vi.useFakeTimers();
    try {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);

      writer.writeNodeProgress(progress("running"));
      writer.writeNodeProgress(progress("done", "completed"));

      expect(writes).toMatchObject([{ message: "done", status: "completed" }]);
      vi.advanceTimersByTime(1_000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when best-effort progress writes fail", () => {
    vi.useFakeTimers();
    try {
      const writer = new CoalescingNodeProgressWriter({
        writeNodeProgress: () => {
          throw new Error("store busy");
        },
      } as unknown as RuntimeStore, 1_000);

      writer.writeNodeProgress(progress("running"));
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      writer.writeNodeProgress(progress("terminal", "completed"));
      expect(() => writer.flushAll()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes matching pending progress before the interval", () => {
    vi.useFakeTimers();
    try {
      const writes: WriteNodeProgressInput[] = [];
      const writer = new CoalescingNodeProgressWriter(progressStore(writes), 1_000);

      writer.writeNodeProgress(progress("run-1-node"));
      writer.writeNodeProgress({ ...progress("run-2-node"), runId: "run_2" });
      writer.flushMatching(input => input.runId === "run_1" && input.nodeKey === "node_1");

      expect(writes).toMatchObject([{ runId: "run_1", message: "run-1-node" }]);
      vi.advanceTimersByTime(1_000);
      expect(writes).toMatchObject([
        { runId: "run_1", message: "run-1-node" },
        { runId: "run_2", message: "run-2-node" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
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

function progressStore(writes: WriteNodeProgressInput[]): RuntimeStore {
  return {
    writeNodeProgress(input: WriteNodeProgressInput): void {
      writes.push(input);
    },
  } as unknown as RuntimeStore;
}
