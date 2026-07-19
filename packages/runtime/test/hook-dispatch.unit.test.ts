import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../src/hooks/runner.js";
import { dispatchCommittedHooksForRun } from "../src/scheduler/runtime-runner.js";
import { createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { FrozenRun, RuntimeStore } from "../src/store/store.js";

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

    expect(result.isErr() && result.error).toEqual({
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
    } as RuntimeStore;

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
    } as RuntimeStore;

    expect(() => dispatchCommittedHooksForRun({ cwd: "/workspace", runId, store }))
      .toThrow("hook dispatch cursor 2 exceeds committed event sequence 1");
    expect(advance).not.toHaveBeenCalled();
  });
});

function fakeStore(stage?: "read-cursor" | "read-events" | "load-projection" | "load-metadata" | "advance-cursor"): RuntimeStore {
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
        return ok({ runId, version: 1, projection });
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
  } as unknown as RuntimeStore;
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
      irVersion: 5,
      name: "hooks",
      agents: {},
      root: { nodes: [], output: { kind: "literal", value: null } },
      diagnostics: [],
    },
    input: {},
    agentOverrides: {},
    meta: { runId, workflowName: "hooks", workflowPath: "workflow.ts", workspaceDir: "/workspace" },
  };
}

function hookRunner(): HookRunner {
  return {
    trigger() {},
    async drain() {},
    activeCount: () => 0,
  };
}
