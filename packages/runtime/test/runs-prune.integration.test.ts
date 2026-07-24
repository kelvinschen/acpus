import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { pruneRuns } from "../src/index.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import {
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRunDir,
  validWorkflow,
} from "./support/runtime-fixtures.js";
import { withSharedStorageHome, withStorageWorkspace } from "./support/storage-workspace.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

describe("runtime run pruning", () => {
  it("previews and deletes one fenced selection while retaining active data and referenced sources", async () => {
    await withStorageWorkspace("runs-prune-selection", async workspace => {
      const [completed, failed, equal, running] = await admitRuns(workspace, 4);
      const cutoff = "2026-07-24T12:00:00.000Z";
      const removedSource = catalogSource("removed", "a");
      const retainedSource = catalogSource("retained", "b");
      setRunState(workspace, completed!, "completed", "2026-07-24T11:59:58.000Z", removedSource);
      setRunState(workspace, failed!, "failed", "2026-07-24T11:59:59.000Z", removedSource);
      setRunState(workspace, equal!, "canceled", cutoff, retainedSource);
      setRunState(workspace, running!, "running", "2026-07-01T00:00:00.000Z");

      const layout = resolveRuntimeLayout(workspace);
      await Promise.all([
        writeCatalogSource(layout.sourcesRoot, removedSource, "remove"),
        writeCatalogSource(layout.sourcesRoot, retainedSource, "retain"),
      ]);
      const removedArchive = join(layout.archivesRoot, "20260724T115959.000Z-v1");
      const retainedArchive = join(layout.archivesRoot, "20260724T120000.000Z-v1");
      await Promise.all([mkdir(removedArchive), mkdir(retainedArchive)]);
      await Promise.all([
        writeFile(join(removedArchive, "marker"), "remove"),
        writeFile(join(retainedArchive, "marker"), "retain"),
      ]);
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
      await expect(access(removedArchive)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(retainedArchive, "marker"), "utf8")).resolves.toBe("retain");
      await expect(access(catalogSourcePath(layout.sourcesRoot, removedSource))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(catalogSourcePath(layout.sourcesRoot, retainedSource), "workflow.ts"), "utf8"))
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
      await expect(access(runtimeRunDir(second, secondRun!))).resolves.toBeUndefined();
    });
  });

  it("collects orphan sources and removes an empty shard without run candidates", async () => {
    await withStorageWorkspace("runs-prune-empty", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const orphan = join(layout.sourcesRoot, "catalog", "orphan", "a".repeat(64));
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
});

async function admitRuns(workspace: string, count: number): Promise<string[]> {
  const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
  const store = await openRuntimeStore(workspace);
  try {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await admitRunForTest(store, {
        prepared,
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
  source?: ReturnType<typeof catalogSource>,
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, runId);
    if (source) {
      db.prepare("UPDATE run_inputs SET source_json = ? WHERE run_id = ?")
        .run(JSON.stringify(source), runId);
    }
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

function catalogSource(name: string, digestCharacter: string) {
  return {
    kind: "global_catalog" as const,
    name,
    digest: digestCharacter.repeat(64),
    entry: "workflow.ts",
  };
}

async function writeCatalogSource(
  root: string,
  source: ReturnType<typeof catalogSource>,
  contents: string,
): Promise<void> {
  const path = catalogSourcePath(root, source);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "workflow.ts"), contents);
}

function catalogSourcePath(root: string, source: ReturnType<typeof catalogSource>): string {
  return join(root, "catalog", source.name, source.digest);
}
