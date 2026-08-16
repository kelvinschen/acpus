import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  awaitRuntimeStoreOffline,
  inspectRuntimeStore,
  readInspection,
  repairRuntimeStore,
} from "../src/index.js";
import { captureProcessIdentity } from "../src/process-liveness.js";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
} from "../src/runtime-layout.js";
import {
  readRuntimeDatabaseFormat,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
} from "../src/storage/database.js";
import { openRuntimeStoreAtLayout } from "../src/store/store.js";
import {
  createLegacyStore,
  startPredecessorDaemon,
} from "./support/runtime-store-lifecycle.js";
import { initializeRuntimeStoreForTest } from "./support/runtime-fixtures.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

describe.concurrent("Runtime store repair", () => {
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

  it.skipIf(process.platform !== "linux")("treats a reused authority PID as offline", async () => {
    await withStorageWorkspace("runtime-offline-reused-pid", async workspace => {
      await initializeRuntimeStoreForTest(workspace);
      const identity = captureProcessIdentity();
      if (identity.startToken === undefined) throw new Error("Expected a Linux process start token.");
      const store = await openRuntimeStoreAtLayout(resolveRuntimeLayout(workspace));
      store.claimRuntimeAuthority({
        workspaceRealpath: workspace,
        ownerId: "stale-owner",
        pid: identity.pid,
        processStartToken: `${identity.startToken}:reused`,
      })._unsafeUnwrap();
      store.close();

      expect((await awaitRuntimeStoreOffline(workspace)).isOk()).toBe(true);
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

  it("preserves a v8 database byte-for-byte in its sealed generation before publishing v9", async () => {
    await withStorageWorkspace("runtime-repair-v8", async workspace => {
      await createLegacyStore(workspace, 8, {
        id: "run_old",
        name: "Old run",
        status: "completed",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      });
      const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace);
      const sourceDatabase = await readFile(workspaceLayout.databasePath);

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      const active = resolveRuntimeLayout(workspace);
      const generationIds = (await readdir(workspaceLayout.generationsRoot)).sort();
      expect(generationIds).toHaveLength(2);
      const sourceGenerationId = generationIds.find(id => id !== active.generationId);
      if (!sourceGenerationId) throw new Error("expected one sealed source generation");
      const sealed = runtimeLayoutForGeneration(workspaceLayout, sourceGenerationId);
      expect(await readFile(sealed.databasePath)).toEqual(sourceDatabase);
      expect(JSON.parse(await readFile(sealed.generationMetadataPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        id: sourceGenerationId,
        storageVersion: 8,
        archivedAt: expect.any(String),
      });
      expect(await readRuntimeDatabaseFormat(active.databasePath)).toEqual({
        applicationId: RUNTIME_APPLICATION_ID,
        userVersion: RUNTIME_STORAGE_VERSION,
      });
      expect(JSON.parse(await readFile(workspaceLayout.manifestPath, "utf8"))).toMatchObject({
        manifestVersion: 2,
        activeGenerationId: active.generationId,
      });
      await expect(access(workspaceLayout.transitionJournalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await inspectRuntimeStore(workspace)).toMatchObject({ value: { state: "ready" } });
      const lookup = await readInspection(workspace, { kind: "run", runId: "run_old" });
      expect(lookup.isErr() && lookup.error).toMatchObject({
        type: "archived-run-lookup-unavailable",
        runId: "run_old",
      });
    });
  });

  it.each([
    {
      name: "foreign SQLite application",
      corrupt: async (path: string) => {
        const database = new DatabaseSync(path);
        try {
          database.exec(`PRAGMA application_id = ${RUNTIME_APPLICATION_ID + 1}; PRAGMA wal_checkpoint(TRUNCATE)`);
        } finally {
          database.close();
        }
      },
    },
    {
      name: "unrecognized non-SQLite database",
      corrupt: async (path: string) => writeFile(path, "not a SQLite database\n"),
    },
  ])("leaves a $name unchanged as unsupported", async ({ name, corrupt }) => {
    await withStorageWorkspace(`runtime-repair-${name.replaceAll(" ", "-")}`, async workspace => {
      await createLegacyStore(workspace, 8);
      const layout = resolveRuntimeWorkspaceLayout(workspace);
      await corrupt(layout.databasePath);
      const before = await treeFingerprint(layout.workspaceRoot);

      const inspected = await inspectRuntimeStore(workspace);
      expect(inspected.isOk() && inspected.value).toMatchObject({ state: "unsupported" });
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);

      const repaired = await repairRuntimeStore(workspace);
      expect(repaired.isErr() && repaired.error).toMatchObject({ type: "unsupported" });
      expect(await treeFingerprint(layout.workspaceRoot)).toBe(before);
    });
  });

  it("retires an idle v3 daemon before repairing its store", async () => {
    await withStorageWorkspace("runtime-repair-v3-retirement", async workspace => {
      await createLegacyStore(workspace, 8);
      const predecessor = await startPredecessorDaemon(workspace);
      try {
        const repaired = await repairRuntimeStore(workspace);
        expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
        expect(predecessor.shutdownRequests()).toBe(1);
      } finally {
        await predecessor.close();
      }
    });
  });

  it("leaves a v3 daemon and store unchanged when graceful shutdown is blocked", async () => {
    await withStorageWorkspace("runtime-repair-v3-blocked", async workspace => {
      await createLegacyStore(workspace, 8);
      const predecessor = await startPredecessorDaemon(workspace, { blockShutdown: true });
      const home = resolveRuntimeWorkspaceLayout(workspace).home;
      const before = await treeFingerprint(home);
      try {
        const repaired = await repairRuntimeStore(workspace);
        expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "busy" });
        expect(predecessor.shutdownRequests()).toBe(1);
        expect(await treeFingerprint(home)).toBe(before);
      } finally {
        await predecessor.close();
      }
    });
  });

  it("does not send shutdown to an unknown future daemon", async () => {
    await withStorageWorkspace("runtime-repair-future-daemon", async workspace => {
      await createLegacyStore(workspace, 8);
      const daemon = await startPredecessorDaemon(workspace, { protocolVersion: 5 });
      const home = resolveRuntimeWorkspaceLayout(workspace).home;
      const before = await treeFingerprint(home);
      try {
        const repaired = await repairRuntimeStore(workspace);
        expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "busy" });
        expect(daemon.shutdownRequests()).toBe(0);
        expect(await treeFingerprint(home)).toBe(before);
      } finally {
        await daemon.close();
      }
    });
  });

  it("leaves a newer store untouched", async () => {
    await withStorageWorkspace("runtime-repair-newer", async workspace => {
      await createLegacyStore(workspace, 11);
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
          storageVersion: 10,
          createdAt: "2026-08-10T00:00:00.000Z",
        }],
      }, null, 2)}\n`);

      const first = await repairRuntimeStore(workspace);
      const second = await repairRuntimeStore(workspace);

      expect(first.isOk() && first.value).toEqual({ changed: true });
      expect(second.isOk() && second.value).toEqual({ changed: false });
    });
  });

  it.each([
    "source-sealed",
    "next-generation-verified",
    "manifest-published",
  ] as const)("converges from the %s transition checkpoint", async checkpoint => {
    await withStorageWorkspace(`runtime-repair-${checkpoint}`, async workspace => {
      const interrupted = await createInterruptedTransition(workspace, checkpoint);

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isOk() && repaired.value).toEqual({ changed: true });
      expect(await inspectRuntimeStore(workspace)).toMatchObject({ value: { state: "ready" } });
      expect(resolveRuntimeLayout(workspace).generationId).toBe(interrupted.nextGenerationId);
      await expect(access(interrupted.workspace.transitionJournalPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("classifies a corrupt transition intent as unreadable without modifying it", async () => {
    await withStorageWorkspace("runtime-repair-corrupt-intent", async workspace => {
      await createLegacyStore(workspace, 8);
      const layout = resolveRuntimeWorkspaceLayout(workspace);
      const corruptIntent = "{ definitely-not-json\n";
      await writeFile(layout.transitionJournalPath, corruptIntent);

      const inspected = await inspectRuntimeStore(workspace);
      const repaired = await repairRuntimeStore(workspace);

      expect(inspected.isErr() ? inspected.error : undefined).toMatchObject({ type: "unreadable" });
      expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "unreadable" });
      expect(await readFile(layout.transitionJournalPath, "utf8")).toBe(corruptIntent);
    });
  });

  it.each([
    ["generation id", (metadata: Record<string, unknown>) => ({ ...metadata, id: `gen_${randomUUID()}` })],
    ["storage version", (metadata: Record<string, unknown>) => ({ ...metadata, storageVersion: 7 })],
    ["creation time", (metadata: Record<string, unknown>) => ({
      ...metadata,
      createdAt: "2026-08-09T00:00:00.000Z",
    })],
    ["sealed time", (metadata: Record<string, unknown>) => ({
      ...metadata,
      archivedAt: "2026-08-11T00:00:00.000Z",
    })],
  ] as const)("classifies transition source %s drift as unreadable and preserves the intent", async (_field, drift) => {
    await withStorageWorkspace(`runtime-repair-source-${_field.replaceAll(" ", "-")}-drift`, async workspace => {
      const interrupted = await createInterruptedTransition(workspace, "source-sealed");
      const intent = await readFile(interrupted.workspace.transitionJournalPath, "utf8");
      const metadata = JSON.parse(
        await readFile(interrupted.source.generationMetadataPath, "utf8"),
      ) as Record<string, unknown>;
      const changed = `${JSON.stringify(drift(metadata), null, 2)}\n`;
      await writeFile(interrupted.source.generationMetadataPath, changed);

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "unreadable" });
      expect(await readFile(interrupted.source.generationMetadataPath, "utf8")).toBe(changed);
      expect(await readFile(interrupted.workspace.transitionJournalPath, "utf8")).toBe(intent);
    });
  });

  it("classifies a disappeared transition source as unreadable without recreating it", async () => {
    await withStorageWorkspace("runtime-repair-source-disappeared", async workspace => {
      const interrupted = await createInterruptedTransition(workspace, "source-sealed");
      const intent = await readFile(interrupted.workspace.transitionJournalPath, "utf8");
      const manifest = await readFile(interrupted.workspace.manifestPath, "utf8");
      await rm(interrupted.source.generationRoot!, { recursive: true });

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "unreadable" });
      await expect(access(interrupted.source.generationRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(interrupted.workspace.transitionJournalPath, "utf8")).toBe(intent);
      expect(await readFile(interrupted.workspace.manifestPath, "utf8")).toBe(manifest);
    });
  });

  it("does not overwrite an existing next-generation identity while resuming", async () => {
    await withStorageWorkspace("runtime-repair-next-generation-drift", async workspace => {
      const interrupted = await createInterruptedTransition(workspace, "source-sealed");
      const next = runtimeLayoutForGeneration(interrupted.workspace, interrupted.nextGenerationId);
      const conflictingMetadata = `${JSON.stringify({
        schemaVersion: 1,
        id: `gen_${randomUUID()}`,
        storageVersion: 10,
        createdAt: interrupted.startedAt,
      }, null, 2)}\n`;
      await mkdir(next.generationRoot!, { recursive: true });
      await writeFile(next.generationMetadataPath, conflictingMetadata);
      const intent = await readFile(interrupted.workspace.transitionJournalPath, "utf8");

      const repaired = await repairRuntimeStore(workspace);

      expect(repaired.isErr() ? repaired.error : undefined).toMatchObject({ type: "unreadable" });
      expect(await readFile(next.generationMetadataPath, "utf8")).toBe(conflictingMetadata);
      expect(await readFile(interrupted.workspace.transitionJournalPath, "utf8")).toBe(intent);
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

type TransitionCheckpoint = "source-sealed" | "next-generation-verified" | "manifest-published";

async function createInterruptedTransition(workspace: string, checkpoint: TransitionCheckpoint): Promise<{
  workspace: ReturnType<typeof resolveRuntimeWorkspaceLayout>;
  source: ReturnType<typeof runtimeLayoutForGeneration>;
  nextGenerationId: string;
  startedAt: string;
}> {
  await createLegacyStore(workspace, 8);
  const layout = resolveRuntimeWorkspaceLayout(workspace);
  const legacyManifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as Record<string, unknown>;
  const sourceGenerationId = `gen_${randomUUID()}`;
  const nextGenerationId = `gen_${randomUUID()}`;
  const startedAt = "2026-08-10T00:00:00.000Z";
  const source = runtimeLayoutForGeneration(layout, sourceGenerationId);
  const next = runtimeLayoutForGeneration(layout, nextGenerationId);
  const journal = {
    schemaVersion: 1,
    startedAt,
    observedLayoutVersion: 1,
    nextGenerationId,
    sources: [{
      kind: "legacy-runtime",
      generationId: sourceGenerationId,
      storageVersion: 8,
      createdAt: startedAt,
    }],
  };
  await writeFile(layout.transitionJournalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await mkdir(source.generationRoot!, { recursive: true });
  await rename(layout.legacyRuntimeRoot, source.runtimeRoot);
  await writeFile(source.generationMetadataPath, `${JSON.stringify({
    schemaVersion: 1,
    id: sourceGenerationId,
    storageVersion: 8,
    createdAt: startedAt,
    archivedAt: startedAt,
  }, null, 2)}\n`);

  if (checkpoint !== "source-sealed") {
    for (const path of [
      next.generationRoot,
      next.runtimeRoot,
      next.runsRoot,
      next.sourcesRoot,
      next.trashRoot,
      next.acpRoot,
      next.acpWorkersRoot,
    ]) await mkdir(path!, { recursive: true });
    await writeFile(next.generationMetadataPath, `${JSON.stringify({
      schemaVersion: 1,
      id: nextGenerationId,
      storageVersion: 10,
      createdAt: startedAt,
    }, null, 2)}\n`);
    const store = await openRuntimeStoreAtLayout(next, {
      lock: false,
      prevalidated: true,
      unpublished: true,
    });
    store.close();
  }

  if (checkpoint === "manifest-published") {
    await writeFile(layout.manifestPath, `${JSON.stringify({
      manifestVersion: 2,
      workspaceKey: layout.workspaceKey,
      canonicalPath: layout.canonicalPath,
      platform: layout.platform,
      createdAt: legacyManifest.createdAt,
      activeGenerationId: nextGenerationId,
    }, null, 2)}\n`);
  }

  return { workspace: layout, source, nextGenerationId, startedAt };
}
