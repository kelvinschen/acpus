import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../src/hooks/runner.js";
import { dispatchCommittedHooksForRun } from "../src/hooks/dispatch.js";
import { createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { FrozenRun, RuntimeStoreAdapter } from "../src/store/store.js";

const runId = "run_hooks";
const busy = { code: "SQLITE_BUSY", message: "database is locked" };

describe("durable hook dispatch", () => {
  it.each([
    "read-cursor",
    "read-events",
    "load-projection",
    "load-metadata",
    "advance-cursor",
  ] as const)("returns a retry for SQLite busy during %s", stage => {
    const store = fakeStore(stage);
    const result = dispatchCommittedHooksForRun({
      cwd: "/workspace",
      runId,
      store,
      ...(stage === "load-metadata" ? { hookRunner: hookRunner() } : {}),
    });

    expect(Result.isFailure(result) && result.failure).toEqual({
      type: "hook-dispatch-retry",
      runId,
      stage,
      message: "Runtime store is busy. Retry hook dispatch on a later daemon tick.",
    });
  });

  it("rejects a committed event gap before advancing the cursor", () => {
    const advance = vi.fn(() => true);
    const store = {
      ...fakeStore(),
      getHookDispatchCursor: () => 1,
      readHookDispatchEvents: () => ({ lastSequence: 3, events: [committedRow(3)] }),
      compareAndSetHookDispatchCursor: advance,
    } as RuntimeStoreAdapter;

    expect(() => dispatchCommittedHooksForRun({ cwd: "/workspace", runId, store }))
      .toThrow("hook dispatch event sequence jumps from 1 to 3");
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects a cursor ahead of the committed event sequence", () => {
    const advance = vi.fn(() => true);
    const store = {
      ...fakeStore(),
      getHookDispatchCursor: () => 2,
      readHookDispatchEvents: () => ({ lastSequence: 1, events: [] }),
      compareAndSetHookDispatchCursor: advance,
    } as RuntimeStoreAdapter;

    expect(() => dispatchCommittedHooksForRun({ cwd: "/workspace", runId, store }))
      .toThrow("hook dispatch cursor 2 exceeds committed event sequence 1");
    expect(advance).not.toHaveBeenCalled();
  });

  it("advances a mapped event without loading hook context when no runner exists", () => {
    let cursor = 0;
    const advance = vi.fn((_runId: string, expected: number, next: number) => {
      if (cursor !== expected) return false;
      cursor = next;
      return true;
    });
    const store = {
      ...fakeStore(),
      getHookDispatchCursor: () => cursor,
      readHookDispatchEvents: () => ({
        lastSequence: 1,
        events: cursor === 0 ? [committedRow(1, true)] : [],
      }),
      scheduler: { tryLoadRunSnapshot: () => { throw new Error("projection must not load"); } },
      getExecutionMetadata: () => { throw new Error("metadata must not load"); },
      compareAndSetHookDispatchCursor: advance,
    } as unknown as RuntimeStoreAdapter;

    expect(Result.getOrThrow(dispatchCommittedHooksForRun({ cwd: "/workspace", runId, store }))).toEqual({
      runId,
      eventSequence: 1,
      dispatched: 0,
    });
    expect(advance).toHaveBeenCalledWith(runId, 0, 1);
  });
});

function fakeStore(stage?: "read-cursor" | "read-events" | "load-projection" | "load-metadata" | "advance-cursor"): RuntimeStoreAdapter {
  const projection = createSchedulerProjection(runId);
  const mapped = stage === "load-metadata";
  return {
    getFrozenRun() {
      if (stage === "load-projection") throw busy;
      return frozenRun();
    },
    getHookDispatchCursor() {
      if (stage === "read-cursor") throw busy;
      return 0;
    },
    readHookDispatchEvents() {
      if (stage === "read-events") throw busy;
      return { lastSequence: 1, events: [committedRow(1, mapped)] };
    },
    scheduler: {
      tryLoadRunSnapshot() {
        return Result.succeed({ runId, version: 1, projection });
      },
    },
    getExecutionMetadata() {
      if (stage === "load-metadata") throw busy;
      return [];
    },
    compareAndSetHookDispatchCursor() {
      if (stage === "advance-cursor") throw busy;
      return true;
    },
  } as unknown as RuntimeStoreAdapter;
}

function committedRow(sequence: number, mapped = false) {
  return {
    runId,
    sequence,
    type: mapped ? "instance.started" : "run.admitted",
    ...(mapped ? { nodeKey: "task" } : {}),
    payload: mapped ? { nodeKey: "task", attemptId: "attempt_1" } : {},
    createdAt: "2026-07-18T00:00:00.000Z",
    idempotencyKey: `event:${sequence}`,
  };
}

function frozenRun(): FrozenRun {
  return {
    ir: {
      irVersion: 8,
      name: "hooks",
      agents: {},
      root: { nodes: [], output: { kind: "literal", value: null } },
      diagnostics: [],
    },
    input: {},
    agentBindings: {},
    meta: { runId, workflowName: "hooks", workflowPath: "workflow.ts", workspaceDir: "/workspace" },
  };
}

function hookRunner(): HookRunner {
  return {
    trigger() {},
    drain: () => Effect.void,
    activeCount: () => 0,
  };
}
