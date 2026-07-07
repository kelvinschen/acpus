import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deleteRun, getRun, listRuns } from "../src/index.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("runtime run deletion", () => {
  it("hard-deletes a run record, cascaded rows, and run directory", async () => {
    await withRuntimeWorkspace("runs-delete-hard", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let deletedId: string;
      let keptId: string;
      try {
        const deleted = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const kept = await store.admitRun({ prepared, input: { ready: false }, cwd: workspace });
        deletedId = deleted.id;
        keptId = kept.id;
      } finally {
        store.close();
      }

      const runDir = join(workspace, ".acpus", ".local", "runs", deletedId);
      await expect(access(runDir)).resolves.toBeUndefined();

      await expect(deleteRun(workspace, deletedId)).resolves.toMatchObject({ id: deletedId });

      await expect(access(runDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(getRun(workspace, deletedId)).resolves.toBeUndefined();
      await expect(listRuns(workspace)).resolves.toEqual([expect.objectContaining({ id: keptId })]);
      expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", deletedId)).toBe(0);
      expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_inputs WHERE run_id = ?", deletedId)).toBe(0);
    });
  });

  it("allows stale non-terminal run deletion", async () => {
    await withRuntimeWorkspace("runs-delete-stale", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId: string;
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        store.scheduler.claimRun(run.id, "owner", 60_000);
      } finally {
        store.close();
      }
      insertDaemonLease(workspace, new Date(Date.now() - 10_000).toISOString());

      await expect(getRun(workspace, runId)).resolves.toMatchObject({
        execution: { state: "stale" },
      });
      await expect(deleteRun(workspace, runId)).resolves.toMatchObject({ id: runId });
      await expect(getRun(workspace, runId)).resolves.toBeUndefined();
    });
  });

  it("rejects active run deletion", async () => {
    await withRuntimeWorkspace("runs-delete-active", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId: string;
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        store.scheduler.claimRun(run.id, "owner", 60_000);
      } finally {
        store.close();
      }

      await expect(deleteRun(workspace, runId)).rejects.toMatchObject({
        failure: { type: "run-delete-active", runId },
      });
      await expect(getRun(workspace, runId)).resolves.toMatchObject({ id: runId });
    });
  });
});

function insertDaemonLease(workspace: string, heartbeatAt: string): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
  try {
    db.prepare(`
      INSERT INTO daemon_lease (
        workspace_realpath, generation, pid, heartbeat_at, idle_since_at,
        idle_stop_ms, protocol_version, package_version, node_version,
        exec_path, updated_at
      )
      VALUES (?, 1, ?, ?, NULL, 30000, 1, 'test', ?, ?, ?)
    `).run(workspace, process.pid, heartbeatAt, process.version, process.execPath, new Date().toISOString());
  } finally {
    db.close();
  }
}

function dbScalar(workspace: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return Number((db.prepare(sql).get(...params) as { "COUNT(*)": number })["COUNT(*)"]);
  } finally {
    db.close();
  }
}
