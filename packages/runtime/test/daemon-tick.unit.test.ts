import { describe, expect, it } from "vitest";
import { runDaemonTick } from "../src/daemon/tick.js";
import type { RunRecord, RuntimeStore } from "../src/store/store.js";

describe("daemon tick", () => {
  it("does not let hook journal prune failures block runnable work", async () => {
    const started: string[] = [];

    await expect(runDaemonTick(fakeStore(), { startSession: runId => started.push(runId) })).resolves.toEqual({
      runs: 1,
      idleBlockers: 0,
    });
    expect(started).toEqual(["run_1"]);
  });
});

function fakeStore(): RuntimeStore {
  return {
    async cleanupRunDirectories() {
      return { staged: 0, orphaned: 0 };
    },
    listDaemonWork() {
      return { startableRuns: [runRecord()], idleBlockers: 0 };
    },
    pruneHookJournal() {
      throw new Error("database busy");
    },
  } as unknown as RuntimeStore;
}

function runRecord(): RunRecord {
  return {
    id: "run_1",
    name: "workflow",
    status: "pending",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "source",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    progressVersion: 0,
  };
}
