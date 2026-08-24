import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { runRuntimeTick } from "../src/daemon/tick.js";
import type { RunRecord } from "../src/store/store.js";

describe("daemon tick", () => {
  it("propagates non-busy hook journal prune failures after starting runnable work", async () => {
    const started: string[] = [];

    await expect(runTick(fakeStore(undefined, true), { startSession: runId => {
      started.push(runId);
      return "started";
    } })).rejects.toThrow("hook journal unavailable");
    expect(started).toEqual(["run_1"]);
  });

  it("keeps hook backlog as an idle blocker without counting hook dispatch as a started run", async () => {
    const dispatched: string[] = [];
    const store = fakeStore({ hookDispatchRunIds: ["run_2"], idleBlockers: 1 });

    await expect(runTick(store, {
      startSession: () => "terminal",
      dispatchHooks: runId => {
        dispatched.push(runId);
        return "quarantined";
      },
    })).resolves.toEqual({ runs: 0, idleBlockers: 1 });
    expect(dispatched).toEqual(["run_2"]);
  });

  it("does not dispatch hook backlog concurrently with a newly started run session", async () => {
    const dispatched: string[] = [];
    const store = fakeStore({ hookDispatchRunIds: ["run_1"], idleBlockers: 1 });

    await expect(runTick(store, {
      startSession: () => "started",
      dispatchHooks: runId => {
        dispatched.push(runId);
        return "dispatched";
      },
    })).resolves.toEqual({ runs: 1, idleBlockers: 1 });
    expect(dispatched).toEqual([]);
  });
});

function fakeStore(work = { hookDispatchRunIds: [] as string[], idleBlockers: 0 }, failPrune = false): Parameters<typeof runRuntimeTick>[0] {
  return {
    listRuntimeWork() {
      return Effect.succeed({ startableRuns: [runRecord()], ...work });
    },
    pruneHookJournal() {
      return Effect.sync(() => {
        if (failPrune) throw new Error("hook journal unavailable");
        return 0;
      });
    },
  };
}

function runTick(
  store: Parameters<typeof runRuntimeTick>[0],
  options: {
    startSession: (runId: string) => "started" | "already-active" | "terminal" | "quarantined";
    dispatchHooks?: (runId: string) => "dispatched" | "retry" | "quarantined";
  },
) {
  return Effect.runPromise(runRuntimeTick(store, {
    startSession: runId => Effect.sync(() => options.startSession(runId)),
    ...(options.dispatchHooks === undefined
      ? {}
      : { dispatchHooks: (runId: string) => Effect.sync(() => options.dispatchHooks!(runId)) }),
  }));
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
