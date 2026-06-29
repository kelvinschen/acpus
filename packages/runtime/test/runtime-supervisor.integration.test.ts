import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getRun } from "@acpus/runtime";
import { runSupervisorTick } from "../src/supervisor/tick.js";
import { openExistingWritableRuntimeStore } from "../src/store/store.js";
import { admitSyntheticWorkflow, runtimeRow, runtimeRows, signalWorkflow, taskArtifactWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe.concurrent("runtime supervisor ticks", () => {
  it("applies pending signal commands", async () => {
    await withRuntimeWorkspace("runtime-supervisor-signal-command", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        store!.submitCommand({
          runId: awaiting.run.id,
          type: "signal",
          payload: { node: "approve", payload: { ok: true } },
          idempotencyKey: `test-signal:${awaiting.run.id}`,
        });
        await expect(runSupervisorTick(workspace, store!)).resolves.toMatchObject({ commands: 1 });
      } finally {
        store?.close();
      }
      await expect(getRun(workspace, awaiting.run.id)).resolves.toMatchObject({ status: "completed", output: { ok: true } });
    });
  }, 15_000);

  it("applies pending fork commands", async () => {
    await withRuntimeWorkspace("runtime-supervisor-fork-command", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        store!.submitCommand({
          runId: completed.run.id,
          type: "fork",
          idempotencyKey: `test-fork:${completed.run.id}`,
        });
        await expect(runSupervisorTick(workspace, store!)).resolves.toMatchObject({ commands: 1 });
      } finally {
        store?.close();
      }
      const forkCommand = runtimeRow(workspace, "SELECT status, payload_json FROM commands WHERE run_id = ? AND type = 'fork'", completed.run.id);
      expect(forkCommand).toMatchObject({ status: "applied" });
      expect(JSON.parse(String(forkCommand?.payload_json)).forkRunId).toMatch(/^run_/);
    });
  }, 15_000);

  it("recovers only stale commands owned by the current supervisor", async () => {
    await withRuntimeWorkspace("runtime-supervisor-stale", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        const fresh = store!.submitCommand({ runId: completed.run.id, type: "fork", idempotencyKey: "fresh" });
        expect(store!.claimCommand(fresh.id, { ownerGeneration: 1 })).toBe(true);

        const stale = store!.submitCommand({ runId: completed.run.id, type: "fork", idempotencyKey: "stale" });
        expect(store!.claimCommand(stale.id, { ownerGeneration: 1 })).toBe(true);
        const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
        try {
          db.prepare("UPDATE commands SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 120_000).toISOString(), stale.id);
        } finally {
          db.close();
        }

        await expect(runSupervisorTick(workspace, store!, { ownerGeneration: 1, commandStaleAfterMs: 60_000 })).resolves.toMatchObject({ commands: 1 });
        expect(store!.getCommand(stale.id)?.status).toBe("applied");
        expect(store!.getCommand(fresh.id)?.status).toBe("running");
      } finally {
        store?.close();
      }
    });
  }, 15_000);

  it("cleans stale staged directories but preserves admitted runs", async () => {
    await withRuntimeWorkspace("runtime-supervisor-cleanup", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const staged = join(workspace, ".acpus", "runs", ".staging-old");
      const orphan = join(workspace, ".acpus", "runs", "run_20990101T000000Z_oldorphan");
      await mkdir(staged, { recursive: true });
      await mkdir(orphan, { recursive: true });
      await writeFile(join(staged, "leftover.txt"), "staged");
      const old = new Date(Date.now() - 120_000);
      await utimes(staged, old, old);
      await utimes(orphan, old, old);

      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await expect(runSupervisorTick(workspace, store!)).resolves.toMatchObject({ commands: 0 });
      } finally {
        store?.close();
      }

      expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([{ id: completed.run.id }]);
      await expect(access(staged)).rejects.toThrow();
      await expect(access(orphan)).resolves.toBeUndefined();
    });
  });
});
