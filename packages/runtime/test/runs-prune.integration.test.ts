import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { pruneRuns } from "../src/index.js";
import { resolveRuntimeLayout, runtimeLayoutForGeneration, type RuntimeLayout } from "../src/runtime-layout.js";
import { writeGenerationMetadata } from "../src/storage/generation-metadata.js";
import {
  openRuntimeStore,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  type PreparedRunWorkflow,
} from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import {
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRunDir,
  snapshotPreparedWorkflow,
  validWorkflow,
} from "./support/runtime-fixtures.js";
import { withSharedStorageHome, withStorageWorkspace } from "./support/storage-workspace.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

describe("runtime run pruning", () => {
  it("previews and deletes one fenced selection while retaining active data and referenced sources", async () => {
    await withStorageWorkspace("runs-prune-selection", async workspace => {
      const base = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const removedSource = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "remove" },
      ]);
      const retainedSource = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "retain" },
      ]);
      const [completed, failed] = await admitRuns(workspace, 2, removedSource);
      const [equal] = await admitRuns(workspace, 1, retainedSource);
      const [running] = await admitRuns(workspace, 1, base);
      const cutoff = "2026-07-24T12:00:00.000Z";
      setRunState(workspace, completed!, "completed", "2026-07-24T11:59:58.000Z");
      setRunState(workspace, failed!, "failed", "2026-07-24T11:59:59.000Z");
      setRunState(workspace, equal!, "canceled", cutoff);
      setRunState(workspace, running!, "running", "2026-07-01T00:00:00.000Z");

      const layout = resolveRuntimeLayout(workspace);
      const removedGeneration = await createSealedGeneration(
        workspace,
        "2026-07-24T11:59:59.000Z",
      );
      const retainedGeneration = await createSealedGeneration(
        workspace,
        "2026-07-24T12:00:00.000Z",
      );
      const before = await treeFingerprint(layout.workspaceRoot);

      const preview = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: true,
        selectionCutoff: cutoff,
      });

      expect(preview).toMatchObject({
        dryRun: true,
        selected: { workspaces: 1, runs: 2, archives: 1 },
        deleted: { workspaces: 0, runs: 0, archives: 0, sources: 0, bytes: 0 },
        removedWorkspaces: 0,
        failures: [],
      });
      expect(preview.selected.bytes).toBeGreaterThan(0);
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);

      const pruned = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
        selectionCutoff: cutoff,
      });

      expect(pruned).toMatchObject({
        dryRun: false,
        selected: { workspaces: 1, runs: 2, archives: 1 },
        deleted: { workspaces: 1, runs: 2, archives: 1, sources: 1 },
        removedWorkspaces: 0,
        failures: [],
      });
      expect(pruned.selected.bytes).toBe(preview.selected.bytes);
      expect(pruned.deleted.bytes).toBeGreaterThan(pruned.selected.bytes);
      expect(readRunStates(workspace)).toEqual([
        { id: equal, status: "canceled" },
        { id: running, status: "running" },
      ]);
      for (const runId of [completed, failed]) {
        await expect(access(runtimeRunDir(workspace, runId!))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(access(removedGeneration.runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(retainedGeneration.generationMetadataPath, "utf8")).resolves.toContain(
        retainedGeneration.generationId,
      );
      await expect(access(snapshotSourcePath(layout.sourcesRoot, removedSource.source))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(snapshotSourcePath(layout.sourcesRoot, retainedSource.source), "files", "workflow.ts"), "utf8"))
        .resolves.toBe("retain");
    });
  });

  it("continues across workspace shards after one manifest fails validation", async () => {
    await withSharedStorageHome("runs-prune-all", async ({ first, second }) => {
      const [firstRun] = await admitRuns(first, 1);
      const [secondRun] = await admitRuns(second, 1);
      setRunState(first, firstRun!, "completed");
      setRunState(second, secondRun!, "completed");
      const firstLayout = resolveRuntimeLayout(first);
      const secondLayout = resolveRuntimeLayout(second);
      const secondRunDir = join(secondLayout.runsRoot, secondRun!);

      const firstStore = await openRuntimeStore(first);
      try {
        expect(firstStore.getRun(firstRun!)).toBeDefined();
        expect(firstStore.getRun(secondRun!)).toBeUndefined();
      } finally {
        firstStore.close();
      }
      await writeFile(secondLayout.manifestPath, "{broken");

      const report = await pruneRuns(first, {
        allWorkspaces: true,
        dryRun: false,
      });

      expect(report).toMatchObject({
        selected: { workspaces: 1, runs: 1, archives: 0 },
        deleted: { workspaces: 1, runs: 1, archives: 0 },
        removedWorkspaces: 1,
      });
      expect(report.failures).toEqual([
        expect.objectContaining({ workspaceKey: secondLayout.workspaceKey }),
      ]);
      await expect(access(firstLayout.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(secondRunDir)).resolves.toBeUndefined();
    });
  });

  it("collects orphan sources and removes an empty shard without run candidates", async () => {
    await withStorageWorkspace("runs-prune-empty", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const orphan = join(layout.sourcesRoot, "snapshots", "a".repeat(64));
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, "workflow.ts"), "orphan");

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report).toMatchObject({
        selected: { workspaces: 0, runs: 0, archives: 0, bytes: 0 },
        deleted: { workspaces: 1, runs: 0, archives: 0, sources: 1 },
        removedWorkspaces: 1,
        failures: [],
      });
      await expect(access(layout.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not recursively remove a daemon socket impostor from an otherwise empty shard", async () => {
    await withStorageWorkspace("runs-prune-daemon-impostor", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await writeFile(layout.daemonSocketPath, "preserve");

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report.removedWorkspaces).toBe(0);
      expect(report.failures).toEqual([
        expect.objectContaining({ workspaceKey: layout.workspaceKey }),
      ]);
      await expect(readFile(layout.daemonSocketPath, "utf8")).resolves.toBe("preserve");
    });
  });

  it("does not remove an empty shard with unknown ACP-owned state", async () => {
    await withStorageWorkspace("runs-prune-acp-state", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await writeFile(join(layout.acpRoot, "preserve.json"), "{}");

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report.removedWorkspaces).toBe(0);
      expect(report.failures).toEqual([
        expect.objectContaining({ workspaceKey: layout.workspaceKey }),
      ]);
      await expect(readFile(join(layout.acpRoot, "preserve.json"), "utf8")).resolves.toBe("{}");
    });
  });

  it("preserves completed deletion counts when later empty-shard validation fails", async () => {
    await withStorageWorkspace("runs-prune-partial-report", async workspace => {
      const [runId] = await admitRuns(workspace, 1);
      setRunState(workspace, runId!, "completed");
      const layout = resolveRuntimeLayout(workspace);
      await writeFile(join(layout.workspaceRoot, "preserve"), "unresolved");

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report).toMatchObject({
        selected: { workspaces: 1, runs: 1, archives: 0 },
        deleted: { workspaces: 1, runs: 1, archives: 0 },
        removedWorkspaces: 0,
        failures: [expect.objectContaining({ workspaceKey: layout.workspaceKey })],
      });
      expect(report.deleted.bytes).toBeGreaterThan(0);
      await expect(access(runtimeRunDir(workspace, runId!))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(layout.workspaceRoot, "preserve"), "utf8")).resolves.toBe("unresolved");
    });
  });

  it("removes an empty converted shard that retains an empty legacy archives root", async () => {
    await withStorageWorkspace("runs-prune-empty-legacy-archives", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await mkdir(layout.legacyArchivesRoot);

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report).toMatchObject({
        deleted: { workspaces: 1 },
        removedWorkspaces: 1,
        failures: [],
      });
      await expect(access(layout.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reports an outdated active store as update-required without mutation", async () => {
    await withStorageWorkspace("runs-prune-outdated", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      setDatabaseVersion(layout.databasePath, 8);
      const before = await treeFingerprint(layout.workspaceRoot);

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report).toMatchObject({
        selected: { workspaces: 0, runs: 0, archives: 0, bytes: 0 },
        deleted: { workspaces: 0, runs: 0, archives: 0, sources: 0, bytes: 0 },
        removedWorkspaces: 0,
        failures: [{
          workspaceKey: layout.workspaceKey,
          message: expect.stringContaining("RUNTIME_STORE_REPAIR_REQUIRED"),
        }],
      });
      expect(report.failures[0]?.message).toContain("acpus doctor --fix");
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);
    });
  });

  it("reports a newer active store as unsupported without suggesting an impossible update", async () => {
    await withStorageWorkspace("runs-prune-unsupported", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      setDatabaseVersion(layout.databasePath, RUNTIME_STORAGE_VERSION + 1);
      const before = await treeFingerprint(layout.workspaceRoot);

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: false,
      });

      expect(report.failures).toEqual([{
        workspaceKey: layout.workspaceKey,
        message: expect.stringContaining("RUNTIME_STORE_UNSUPPORTED"),
      }]);
      expect(report.failures[0]?.message).not.toContain("acpus doctor --fix");
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);
    });
  });

  it("rejects a WAL symlink instead of following an empty target", async () => {
    await withStorageWorkspace("runs-prune-wal-symlink", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const wal = `${layout.databasePath}-wal`;
      const target = join(workspace, "outside-wal-target");
      await rm(wal, { force: true });
      await writeFile(target, "");
      await symlink(target, wal);

      const report = await pruneRuns(workspace, {
        allWorkspaces: false,
        dryRun: true,
      });

      expect(report).toMatchObject({
        selected: { workspaces: 0, runs: 0, archives: 0, bytes: 0 },
        deleted: { workspaces: 0, runs: 0, archives: 0, sources: 0, bytes: 0 },
        failures: [expect.objectContaining({ workspaceKey: layout.workspaceKey })],
      });
      expect((await lstat(wal)).isSymbolicLink()).toBe(true);
    });
  });
});

async function createSealedGeneration(
  workspace: string,
  sealedAt: string,
): Promise<RuntimeLayout & { generationId: string }> {
  const current = resolveRuntimeLayout(workspace);
  const generationId = `gen_${randomUUID()}`;
  const generation = runtimeLayoutForGeneration(current, generationId) as RuntimeLayout & { generationId: string };
  for (const path of [
    generation.runtimeRoot,
    generation.runsRoot,
    generation.sourcesRoot,
    generation.trashRoot,
    generation.acpWorkersRoot,
  ]) {
    await mkdir(path, { recursive: true });
  }
  const database = new DatabaseSync(generation.databasePath);
  try {
    database.exec(`
      PRAGMA application_id = ${RUNTIME_APPLICATION_ID};
      PRAGMA user_version = ${RUNTIME_STORAGE_VERSION};
    `);
  } finally {
    database.close();
  }
  await writeGenerationMetadata(generation.generationMetadataPath, {
    schemaVersion: 1,
    id: generationId,
    storageVersion: RUNTIME_STORAGE_VERSION,
    createdAt: sealedAt,
    archivedAt: sealedAt,
  });
  return generation;
}

async function admitRuns(
  workspace: string,
  count: number,
  prepared?: PreparedRunWorkflow,
): Promise<string[]> {
  const workflow = prepared ?? await prepareSyntheticWorkflow(workspace, validWorkflow());
  const store = await openRuntimeStore(workspace);
  try {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await admitRunForTest(store, {
        prepared: workflow,
        input: { ready: true },
        cwd: workspace,
      })).id);
    }
    return ids;
  } finally {
    store.close();
  }
}

function setRunState(
  workspace: string,
  runId: string,
  status: string,
  updatedAt = "2026-07-24T00:00:00.000Z",
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, runId);
  } finally {
    db.close();
  }
}

function readRunStates(workspace: string): Array<{ id: string; status: string }> {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return db.prepare("SELECT id, status FROM runs ORDER BY created_at, id").all() as Array<{
      id: string;
      status: string;
    }>;
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

function snapshotSourcePath(
  root: string,
  source: Extract<PreparedRunWorkflow["source"], { kind: "snapshot" }>,
): string {
  return join(root, "snapshots", source.digest.slice("sha256:".length));
}
