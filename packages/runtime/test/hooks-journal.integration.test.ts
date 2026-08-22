import { admitRunForTest } from "./support/runtime-store.js";
import { describe, expect, it } from "vitest";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { advanceRuntimeRun } from "./support/scheduler.js";

describe("hook journal store", () => {
  it("writes terminal hook records once and reads them by event sequence and trigger order", async () => {
    await withRuntimeWorkspace("hooks-journal-write", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const event2 = entry(run.id, { eventSequence: 2, triggerOrder: 1, handlerId: "event-2", triggeredAt: "2026-07-04T00:00:00.000Z" });
        const event1Second = entry(run.id, { eventSequence: 1, triggerOrder: 2, handlerId: "event-1-second", triggeredAt: "2026-07-04T00:00:01.000Z" });
        const event1First = entry(run.id, { eventSequence: 1, triggerOrder: 1, handlerId: "event-1-first", triggeredAt: "2026-07-04T00:00:02.000Z", nodeKey: "require_ready" });

        store.writeHookJournal(event2);
        store.writeHookJournal(event1Second);
        store.writeHookJournal(event1First);
        store.writeHookJournal(event1First);

        expect(store.getHookJournal(run.id)).toMatchObject([
          { handlerId: "event-1-first", eventSequence: 1, triggerOrder: 1, nodeKey: "require_ready" },
          { handlerId: "event-1-second", eventSequence: 1, triggerOrder: 2 },
          { handlerId: "event-2", eventSequence: 2, triggerOrder: 1 },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("exposes hook history only for terminal run details", async () => {
    await withRuntimeWorkspace("hooks-journal-run-details", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        store.writeHookJournal(entry(run.id));

        expect(store.getRun(run.id)?.hooks).toEqual([]);

        await expect(advanceRuntimeRun(workspace, store, run.id, "owner-a")).resolves.toMatchObject({ status: "completed" });

        expect(store.getRun(run.id)?.hooks).toMatchObject([{ handlerId: "notify", event: "run.completed" }]);
      } finally {
        store.close();
      }
    });
  });

  it("prunes rows older than the retention cutoff", async () => {
    await withRuntimeWorkspace("hooks-journal-prune", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        store.writeHookJournal(entry(run.id, { eventSequence: 1, handlerId: "old", triggeredAt: "2026-06-26T23:59:59.000Z" }));
        store.writeHookJournal(entry(run.id, { eventSequence: 2, handlerId: "kept", triggeredAt: "2026-06-27T00:00:00.000Z" }));

        expect(store.pruneHookJournal(new Date("2026-06-27T00:00:00.000Z"))).toBe(1);

        expect(store.getHookJournal(run.id)).toMatchObject([{ handlerId: "kept" }]);
      } finally {
        store.close();
      }
    });
  });

});

function entry(runId: string, overrides: Partial<HookJournalEntry> = {}): HookJournalEntry {
  return {
    runId,
    eventSequence: 1,
    triggerOrder: 1,
    event: "run.completed",
    source: "project",
    sourcePath: "/workspace/.acpus/config.json",
    handlerId: "notify",
    status: "completed",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 12,
    triggeredAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}
