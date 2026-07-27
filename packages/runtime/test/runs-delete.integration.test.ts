import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deleteRun, getRun, listRuns } from "../src/index.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRunDir, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("runtime run deletion", () => {
  it("treats a missing store or run as an ordinary no-op", async () => {
    await withRuntimeWorkspace("runs-delete-missing", async workspace => {
      expect((await deleteRun(workspace, "missing"))._unsafeUnwrap()).toBeUndefined();
      const store = await openRuntimeStore(workspace);
      store.close();
      expect((await deleteRun(workspace, "missing"))._unsafeUnwrap()).toBeUndefined();
    });
  });

  it("hard-deletes a run record, cascaded rows, and run directory", async () => {
    await withRuntimeWorkspace("runs-delete-hard", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let deletedId: string;
      let keptId: string;
      try {
        const deleted = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const kept = await admitRunForTest(store, { prepared, input: { ready: false }, cwd: workspace });
        deletedId = deleted.id;
        keptId = kept.id;
      } finally {
        store.close();
      }

      const runDir = runtimeRunDir(workspace, deletedId);
      await expect(access(runDir)).resolves.toBeUndefined();

      expect((await deleteRun(workspace, deletedId))._unsafeUnwrap()).toMatchObject({ id: deletedId });

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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        store.scheduler.claimRun(run.id, "owner", 60_000);
      } finally {
        store.close();
      }
      expireRunLease(workspace, runId);
      insertDaemonLease(workspace, new Date(Date.now() - 10_000).toISOString());

      await expect(getRun(workspace, runId)).resolves.toMatchObject({
        execution: { state: "stale" },
      });
      expect((await deleteRun(workspace, runId))._unsafeUnwrap()).toMatchObject({ id: runId });
      await expect(getRun(workspace, runId)).resolves.toBeUndefined();
    });
  });

  it("rejects active leases independently of the projected run status", async () => {
    await withRuntimeWorkspace("runs-delete-active-leases", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const runIds: string[] = [];
      try {
        for (const status of ["running", "completed"]) {
          const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
          if (!store.scheduler.claimRun(run.id, `owner-${status}`, 60_000)) {
            throw new Error("expected active run claim");
          }
          setRunStatus(workspace, run.id, status);
          runIds.push(run.id);
        }
      } finally {
        store.close();
      }

      for (const runId of runIds) {
        expect((await deleteRun(workspace, runId))._unsafeUnwrapErr()).toMatchObject({
          type: "run-delete-active",
          runId,
        });
        await expect(access(runtimeRunDir(workspace, runId))).resolves.toBeUndefined();
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM runs WHERE id = ?", runId)).toBe(1);
      }
    });
  });

  it("restores the run capsule when the deletion transaction fails", async () => {
    await withRuntimeWorkspace("runs-delete-rollback", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId: string;
      try {
        runId = (await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        })).id;
      } finally {
        store.close();
      }
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.exec(`
          CREATE TRIGGER reject_run_delete
          BEFORE DELETE ON runs
          BEGIN
            SELECT RAISE(ABORT, 'forced delete failure');
          END
        `);
      } finally {
        db.close();
      }

      await expect(deleteRun(workspace, runId)).rejects.toBeInstanceOf(Error);

      await expect(access(runtimeRunDir(workspace, runId))).resolves.toBeUndefined();
      expect(dbScalar(workspace, "SELECT COUNT(*) FROM runs WHERE id = ?", runId)).toBe(1);
      await expect(readdir(resolveRuntimeTrash(workspace))).resolves.toEqual([]);
    });
  });

  it("rejects a same-path trash-root replacement without moving or deleting the run", async () => {
    await withRuntimeWorkspace("runs-delete-trash-root-identity", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const trashRoot = resolveRuntimeTrash(workspace);
      const originalTrashRoot = `${trashRoot}.opened`;
      try {
        const run = await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        });
        await rename(trashRoot, originalTrashRoot);
        await mkdir(trashRoot);
        await writeFile(join(trashRoot, "sentinel"), "replacement");
        try {
          await expect(store.deleteRun(run.id)).rejects.toThrow();
          expect(store.getRun(run.id)?.id).toBe(run.id);
          await expect(access(runtimeRunDir(workspace, run.id))).resolves.toBeUndefined();
          await expect(readFile(join(trashRoot, "sentinel"), "utf8")).resolves.toBe("replacement");
          await expect(readdir(originalTrashRoot)).resolves.toEqual([]);
        } finally {
          await rm(trashRoot, { recursive: true });
          await rename(originalTrashRoot, trashRoot);
        }
      } finally {
        store.close();
      }
    });
  });

  it("reconciles interrupted deletion according to the committed database state", async () => {
    await withRuntimeWorkspace("runs-delete-reconcile", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let restoredRun: string;
      let deletedRun: string;
      try {
        restoredRun = (await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        })).id;
        deletedRun = (await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        })).id;
      } finally {
        store.close();
      }
      const trashRoot = resolveRuntimeTrash(workspace);
      await rename(runtimeRunDir(workspace, restoredRun), join(trashRoot, `${restoredRun}-before-commit`));
      await rename(runtimeRunDir(workspace, deletedRun), join(trashRoot, `${deletedRun}-after-commit`));
      deleteRunRecord(workspace, deletedRun);

      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.getRun(restoredRun)).toMatchObject({ id: restoredRun });
        expect(reopened.getRun(deletedRun)).toBeUndefined();
      } finally {
        reopened.close();
      }

      await expect(access(runtimeRunDir(workspace, restoredRun))).resolves.toBeUndefined();
      await expect(access(runtimeRunDir(workspace, deletedRun))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(trashRoot)).resolves.toEqual([]);
    });
  });

  it("preserves both capsules when trash recovery collides with an existing run directory", async () => {
    await withRuntimeWorkspace("runs-delete-reconcile-collision", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId: string;
      try {
        runId = (await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        })).id;
      } finally {
        store.close();
      }
      const trash = join(resolveRuntimeTrash(workspace), `${runId}-before-commit`);
      await mkdir(trash);
      await writeFile(join(trash, "marker"), "trash");

      await expect(openRuntimeStore(workspace)).rejects.toBeInstanceOf(Error);

      await expect(access(runtimeRunDir(workspace, runId))).resolves.toBeUndefined();
      await expect(readFile(join(trash, "marker"), "utf8")).resolves.toBe("trash");
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link trash capsule without following it", async () => {
    await withRuntimeWorkspace("runs-delete-reconcile-symlink", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId: string;
      try {
        runId = (await admitRunForTest(store, {
          prepared,
          input: { ready: true },
          cwd: workspace,
        })).id;
      } finally {
        store.close();
      }
      const outside = await mkdtemp(join(workspace, "outside-"));
      await writeFile(join(outside, "marker"), "outside");
      await rm(runtimeRunDir(workspace, runId), { recursive: true });
      const trash = join(resolveRuntimeTrash(workspace), `${runId}-before-commit`);
      await symlink(outside, trash, "dir");

      await expect(openRuntimeStore(workspace)).rejects.toBeInstanceOf(Error);

      await expect(readFile(join(outside, "marker"), "utf8")).resolves.toBe("outside");
      await expect(access(trash)).resolves.toBeUndefined();
      await expect(access(runtimeRunDir(workspace, runId))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

function insertDaemonLease(workspace: string, heartbeatAt: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
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

function setRunStatus(workspace: string, runId: string, status: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), runId);
  } finally {
    db.close();
  }
}

function expireRunLease(workspace: string, runId: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", runId);
  } finally {
    db.close();
  }
}

function dbScalar(workspace: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return Number((db.prepare(sql).get(...params) as { "COUNT(*)": number })["COUNT(*)"]);
  } finally {
    db.close();
  }
}

function resolveRuntimeTrash(workspace: string): string {
  return resolveRuntimeLayout(workspace).trashRoot;
}

function deleteRunRecord(workspace: string, runId: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    db.close();
  }
}
