import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  inspectRuntimeStore,
  readInspection,
  repairRuntimeStore,
} from "../src/index.js";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
} from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

describe("Runtime store repair", () => {
  it("treats an absent store as ready and never initializes it", async () => {
    await withStorageWorkspace("runtime-repair-absent", async workspace => {
      const root = resolveRuntimeWorkspaceLayout(workspace).home;
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });

      const inspected = await inspectRuntimeStore(workspace);
      const repaired = await repairRuntimeStore(workspace);

      expect(inspected.isOk() && inspected.value).toEqual({ state: "ready" });
      expect(repaired.isOk() && repaired.value).toEqual({ changed: false });
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("repairs a v1 storage-v9 store and keeps a portable archived run summary", async () => {
    await withStorageWorkspace("runtime-repair-v9", async workspace => {
      await createLegacyStore(workspace, 9, {
        id: "run_archived",
        name: "Archived run",
        status: "completed",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      });
      expect(await inspectRuntimeStore(workspace)).toMatchObject({
        value: { state: "repairable" },
      });

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      const layout = resolveRuntimeLayout(workspace);
      expect(layout.runtimeRoot).toBe(`${layout.generationRoot}/store`);
      const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as Record<string, unknown>;
      expect(manifest).toMatchObject({ manifestVersion: 2, activeGenerationId: layout.generationId });
      const archived = await readInspection(workspace, { kind: "run", runId: "run_archived" });
      expect(archived.isOk() && archived.value).toEqual({
        kind: "archived-run",
        run: {
          id: "run_archived",
          name: "Archived run",
          status: "completed",
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:01.000Z",
        },
      });
    });
  });

  it("keeps older supported stores as catalog-only archives", async () => {
    await withStorageWorkspace("runtime-repair-v8", async workspace => {
      await createLegacyStore(workspace, 8, {
        id: "run_old",
        name: "Old run",
        status: "completed",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      });

      const repaired = await repairRuntimeStore(workspace);
      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      const lookup = await readInspection(workspace, { kind: "run", runId: "run_old" });
      expect(lookup.isErr() && lookup.error).toMatchObject({
        type: "archived-run-lookup-unavailable",
        runId: "run_old",
      });
    });
  });

  it("leaves a newer store untouched", async () => {
    await withStorageWorkspace("runtime-repair-newer", async workspace => {
      await createLegacyStore(workspace, 10);
      const home = resolveRuntimeWorkspaceLayout(workspace).home;
      const before = await treeFingerprint(home);

      const inspected = await inspectRuntimeStore(workspace);
      const repaired = await repairRuntimeStore(workspace);

      expect(inspected.isOk() && inspected.value).toMatchObject({ state: "unsupported" });
      expect(repaired.isErr() && repaired.error).toMatchObject({ type: "unsupported" });
      expect(await treeFingerprint(home)).toBe(before);
    });
  });

  it("serializes concurrent repairs and rebuilds only once", async () => {
    await withStorageWorkspace("runtime-repair-concurrent", async workspace => {
      await createLegacyStore(workspace, 9);

      const repaired = await Promise.all([
        repairRuntimeStore(workspace),
        repairRuntimeStore(workspace),
      ]);

      expect(repaired.every(result => result.isOk())).toBe(true);
      expect(repaired.map(result => result.isOk() && result.value.changed).sort()).toEqual([false, true]);
      expect(await inspectRuntimeStore(workspace)).toMatchObject({ value: { state: "ready" } });
    });
  });

  it("resumes a durable repair intent", async () => {
    await withStorageWorkspace("runtime-repair-resume", async workspace => {
      await createLegacyStore(workspace, 9);
      const layout = resolveRuntimeWorkspaceLayout(workspace);
      await writeFile(layout.transitionJournalPath, `${JSON.stringify({
        schemaVersion: 1,
        startedAt: "2026-08-10T00:00:00.000Z",
        observedLayoutVersion: 1,
        nextGenerationId: `gen_${randomUUID()}`,
        sources: [{
          kind: "legacy-runtime",
          generationId: `gen_${randomUUID()}`,
          storageVersion: 9,
          createdAt: "2026-08-10T00:00:00.000Z",
        }],
      }, null, 2)}\n`);

      const first = await repairRuntimeStore(workspace);
      const second = await repairRuntimeStore(workspace);

      expect(first.isOk() && first.value).toEqual({ changed: true });
      expect(second.isOk() && second.value).toEqual({ changed: false });
    });
  });

  it("preserves an empty crash-left store directory as catalog-only", async () => {
    await withStorageWorkspace("runtime-repair-partial-directory", async workspace => {
      const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace);
      const partial = runtimeLayoutForGeneration(workspaceLayout, `gen_${randomUUID()}`);
      await mkdir(partial.generationRoot!, { recursive: true });

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      expect(JSON.parse(await readFile(partial.generationMetadataPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        id: partial.generationId,
        storageVersion: null,
      });
      await expect(access(partial.runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await inspectRuntimeStore(workspace)).toMatchObject({ value: { state: "ready" } });
    });
  });
});

type RunSummary = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

async function createLegacyStore(workspace: string, storageVersion: number, run?: RunSummary): Promise<void> {
  const store = await openRuntimeStore(workspace);
  store.close();
  const current = resolveRuntimeLayout(workspace);
  if (run) {
    const database = new DatabaseSync(current.databasePath);
    try {
      database.prepare(`
        INSERT INTO runs (
          id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
        ) VALUES (?, ?, ?, 'workflow.ts', 'sha256:test', ?, ?)
      `).run(run.id, run.name, run.status, run.createdAt, run.updatedAt);
    } finally {
      database.close();
    }
  }
  const database = new DatabaseSync(current.databasePath);
  try {
    database.exec(`PRAGMA user_version = ${storageVersion}; PRAGMA wal_checkpoint(TRUNCATE)`);
  } finally {
    database.close();
  }

  const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace);
  const manifest = JSON.parse(await readFile(current.manifestPath, "utf8")) as Record<string, unknown>;
  await mkdir(workspaceLayout.workspaceRoot, { recursive: true });
  await rename(current.runtimeRoot, workspaceLayout.legacyRuntimeRoot);
  await rm(workspaceLayout.generationsRoot, { recursive: true, force: true });
  await writeFile(workspaceLayout.manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    workspaceKey: manifest.workspaceKey,
    canonicalPath: manifest.canonicalPath,
    platform: manifest.platform,
    createdAt: manifest.createdAt,
  }, null, 2)}\n`);
}
