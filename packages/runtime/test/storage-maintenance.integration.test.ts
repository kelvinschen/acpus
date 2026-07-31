import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { prepareRuntimeForNewRun, pruneRuns } from "../src/index.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import {
  archiveRuntimeGeneration,
} from "../src/storage/maintenance.js";
import {
  IncompatibleRuntimeDatabaseError,
  openExistingRuntimeStore,
  openRuntimeStore,
  RUNTIME_APPLICATION_ID,
  RuntimeArchiveActiveError,
  RUNTIME_STORAGE_VERSION,
} from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, validWorkflow } from "./support/runtime-fixtures.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";
import { runtimeStateFingerprint, treeFingerprint } from "./support/tree-fingerprint.js";

describe("runtime storage maintenance", () => {
  it("archives an incomplete generation as one unit before new-run preparation rebuilds it", async () => {
    await withStorageWorkspace("storage-maintenance-incomplete", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await rm(layout.databasePath);
      await Promise.all([
        writeFile(join(layout.runsRoot, "run-marker"), "run"),
        writeFile(join(layout.sourcesRoot, "source-marker"), "source"),
        writeFile(join(layout.trashRoot, "trash-marker"), "trash"),
      ]);

      await prepareRuntimeForNewRun(workspace);

      expect(databaseFormat(layout.databasePath)).toEqual({
        applicationId: RUNTIME_APPLICATION_ID,
        userVersion: RUNTIME_STORAGE_VERSION,
      });
      const [archive] = await readdir(layout.archivesRoot);
      expect(archive).toBeDefined();
      const archivedRuntime = join(layout.archivesRoot, archive!);
      await expect(readFile(join(archivedRuntime, "runs", "run-marker"), "utf8")).resolves.toBe("run");
      await expect(readFile(join(archivedRuntime, "sources", "source-marker"), "utf8")).resolves.toBe("source");
      await expect(readFile(join(archivedRuntime, "trash", "trash-marker"), "utf8")).resolves.toBe("trash");
    });
  });

  it("keeps incompatible storage read-only, then bounded prune selects only archives present before recovery", async () => {
    await withStorageWorkspace("storage-maintenance-incompatible", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const selectedArchive = join(layout.archivesRoot, "20200101T000000.000Z-v1");
      await mkdir(selectedArchive);
      await writeFile(join(selectedArchive, "marker"), "selected");
      setDatabaseVersion(layout.databasePath, 3);
      const before = await treeFingerprint(layout.workspaceRoot);

      let readFailure: unknown;
      try {
        await openExistingRuntimeStore(workspace);
      } catch (error) {
        readFailure = error;
      }
      expect(readFailure).toMatchObject({
        name: "IncompatibleRuntimeDatabaseError",
        applicationId: RUNTIME_APPLICATION_ID,
        userVersion: 3,
      } satisfies Partial<IncompatibleRuntimeDatabaseError>);
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);

      const selectionCutoff = "2021-01-01T00:00:00.000Z";
      const preview = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: true,
        olderThanMs: 1,
        selectionCutoff,
      });
      expect(preview.selected).toMatchObject({ workspaces: 1, runs: 0, archives: 1 });
      expect(preview.failures).toEqual([
        expect.objectContaining({ workspaceKey: layout.workspaceKey }),
      ]);
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);

      const pruned = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
        olderThanMs: 1,
        selectionCutoff,
      });

      expect(pruned).toMatchObject({
        selected: { workspaces: 1, runs: 0, archives: 1 },
        deleted: { workspaces: 1, runs: 0, archives: 1 },
        failures: [],
      });
      expect(databaseFormat(layout.databasePath)).toEqual({
        applicationId: RUNTIME_APPLICATION_ID,
        userVersion: RUNTIME_STORAGE_VERSION,
      });
      const remaining = await readdir(layout.archivesRoot);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatch(/-v3$/);
    });
  });

  it("previews and removes an incompatible generation in one unbounded prune", async () => {
    await withStorageWorkspace("storage-maintenance-prune-incompatible", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      setDatabaseVersion(layout.databasePath, 3);
      const before = await treeFingerprint(layout.workspaceRoot);

      const preview = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: true,
        selectionCutoff: "2026-07-29T00:00:00.000Z",
      });

      expect(preview).toMatchObject({
        selected: { workspaces: 1, runs: 0, archives: 1 },
        failures: [],
      });
      expect(preview.selected.bytes).toBeGreaterThan(0);
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);

      const pruned = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
        selectionCutoff: "2026-07-29T00:00:00.000Z",
      });

      expect(pruned).toMatchObject({
        selected: { workspaces: 1, runs: 0, archives: 1 },
        deleted: { workspaces: 1, runs: 0, archives: 1 },
        removedWorkspaces: 1,
        failures: [],
      });
      expect(pruned.selected.bytes).toBe(preview.selected.bytes);
      await expect(readdir(layout.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("archives the current generation when filesystem identity proves the workspace was recreated", async () => {
    await withStorageWorkspace("storage-maintenance-recreated", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const initial = resolveRuntimeLayout(workspace);
      await writeFile(join(initial.sourcesRoot, "source-marker"), "source");
      const manifest = JSON.parse(await readFile(initial.manifestPath, "utf8")) as Record<string, unknown>;
      const mismatchedIdentity = initial.filesystemIdentity === "0:1:1" ? "0:2:1" : "0:1:1";
      await writeFile(initial.manifestPath, `${JSON.stringify({
        ...manifest,
        filesystemIdentity: mismatchedIdentity,
      })}\n`);

      await prepareRuntimeForNewRun(workspace);

      const [archive] = await readdir(initial.archivesRoot);
      await expect(readFile(join(initial.archivesRoot, archive!, "sources", "source-marker"), "utf8"))
        .resolves.toBe("source");
      expect(JSON.parse(await readFile(initial.manifestPath, "utf8"))).toMatchObject({
        filesystemIdentity: initial.filesystemIdentity,
      });
    });
  });

  it.skipIf(process.platform === "win32")("rejects a shard symlink before prune can mutate its target", async () => {
    await withStorageWorkspace("storage-maintenance-symlink", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const outside = join(layout.home, "outside-shard");
      await rename(layout.workspaceRoot, outside);
      await rm(join(outside, "workspace.json"));
      await symlink(outside, layout.workspaceRoot, "dir");
      const before = await treeFingerprint(outside);

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report.failures).toEqual([
        expect.objectContaining({ workspaceKey: layout.workspaceKey }),
      ]);
      expect(await treeFingerprint(outside)).toBe(before);
    });
  });

  it.each(["run lease", "daemon", "ACP ownership"] as const)(
    "refuses to archive a generation with an active %s",
    async blocker => {
      await withStorageWorkspace(`storage-maintenance-${blocker.replace(" ", "-")}`, async workspace => {
        const store = await openRuntimeStore(workspace);
        if (blocker === "run lease") {
          const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
          const run = await admitRunForTest(store, {
            prepared,
            input: { ready: true },
            cwd: workspace,
          });
          expect(store.scheduler.claimRun(run.id, "owner", 60_000)).toBeDefined();
        } else if (blocker === "daemon") {
          store.claimDaemon({
            workspaceRealpath: workspace,
            pid: process.pid,
            protocolVersion: 1,
            packageVersion: "test",
            nodeVersion: process.version,
            execPath: process.execPath,
            idleStopMs: 30_000,
          });
        }
        store.close();
        const layout = resolveRuntimeLayout(workspace);
        if (blocker === "ACP ownership") {
          await writeFile(join(layout.acpWorkersRoot, "acp_worker_dea0.json"), "{}\n");
        }
        const before = await runtimeStateFingerprint(layout.runtimeRoot);

        let failure: unknown;
        try {
          await archiveRuntimeGeneration(layout);
        } catch (error) {
          failure = error;
        }

        expect(failure).toMatchObject({
          name: "RuntimeArchiveActiveError",
          path: layout.runtimeRoot,
          blocker,
        } satisfies Partial<RuntimeArchiveActiveError>);
        expect(await runtimeStateFingerprint(layout.runtimeRoot)).toBe(before);
        await expect(readdir(layout.archivesRoot)).resolves.toEqual([]);
      });
    },
  );
});

function databaseFormat(path: string): { applicationId: number; userVersion: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    return {
      applicationId: Number(application.application_id),
      userVersion: Number(version.user_version),
    };
  } finally {
    db.close();
  }
}

function setDatabaseVersion(path: string, version: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}
