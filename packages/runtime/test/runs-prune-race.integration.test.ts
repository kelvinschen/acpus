import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import {
  prepareSyntheticWorkflow,
  runtimeRunDir,
  validWorkflow,
} from "./support/runtime-fixtures.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";

const lockInterleave = vi.hoisted(() => ({
  beforeAcquire: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../src/runtime-lock.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/runtime-lock.js")>();
  return {
    ...actual,
    acquireRuntimeExclusiveLock: (...args: Parameters<typeof actual.acquireRuntimeExclusiveLock>) => Effect.promise(
      () => lockInterleave.beforeAcquire?.() ?? Promise.resolve(),
    ).pipe(Effect.andThen(actual.acquireRuntimeExclusiveLock(...args))),
  };
});

const { pruneRuns: pruneRunsEffect } = await import("../src/runs/prune.js");

function pruneRuns(...args: Parameters<typeof pruneRunsEffect>) {
  return Effect.runPromise(pruneRunsEffect(...args));
}

afterEach(() => {
  lockInterleave.beforeAcquire = undefined;
});

describe("runtime prune selection race", () => {
  it("preserves a selected terminal run updated beyond the cutoff before the exclusive lock", async () => {
    await withStorageWorkspace("runs-prune-race", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      let runId: string;
      try {
        const run = await admitRunForTest(store, {
          cwd: workspace,
          input: { ready: true },
          prepared: await prepareSyntheticWorkflow(workspace, validWorkflow()),
        });
        runId = run.id;
      } finally {
        store.close();
      }
      const cutoff = "2026-08-10T12:00:00.000Z";
      setRunState(workspace, runId!, "completed", "2026-08-10T11:59:59.000Z");

      let reachedLock!: () => void;
      const selectionComplete = new Promise<void>(resolve => { reachedLock = resolve; });
      let allowLock!: () => void;
      const release = new Promise<void>(resolve => { allowLock = resolve; });
      lockInterleave.beforeAcquire = async () => {
        reachedLock();
        await release;
      };

      const pruning = pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
        selectionCutoff: cutoff,
      });
      await selectionComplete;
      setRunState(workspace, runId!, "completed", "2026-08-10T12:00:01.000Z");
      allowLock();

      const report = await pruning;
      expect(report).toMatchObject({
        selected: { workspaces: 1, runs: 1, archives: 0 },
        deleted: { workspaces: 0, runs: 0, archives: 0 },
        removedWorkspaces: 0,
        failures: [],
      });
      await expect(access(runtimeRunDir(workspace, runId!))).resolves.toBeUndefined();
      expect(readRunState(workspace, runId!)).toEqual({
        status: "completed",
        updated_at: "2026-08-10T12:00:01.000Z",
      });
    });
  });
});

function setRunState(workspace: string, runId: string, status: string, updatedAt: string): void {
  const database = new DatabaseSync(resolveRuntimeLayout(workspace).databasePath);
  try {
    database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, runId);
  } finally {
    database.close();
  }
}

function readRunState(workspace: string, runId: string): { status: string; updated_at: string } | undefined {
  const database = new DatabaseSync(resolveRuntimeLayout(workspace).databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT status, updated_at FROM runs WHERE id = ?").get(runId) as
      | { status: string; updated_at: string }
      | undefined;
  } finally {
    database.close();
  }
}
