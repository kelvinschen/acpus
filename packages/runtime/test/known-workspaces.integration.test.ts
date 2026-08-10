import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listKnownWorkspaces, resolveKnownWorkspace } from "../src/index.js";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  setRuntimeHomeForTest,
} from "../src/runtime-layout.js";
import {
  openRuntimeStore,
  RUNTIME_STORAGE_VERSION,
} from "../src/store/store.js";
import { withSharedStorageHome, withStorageWorkspace } from "./support/storage-workspace.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

describe("known runtime workspaces", () => {
  it("includes an uninitialized current workspace without creating runtime state", async () => {
    await withStorageWorkspace("known-workspaces-current", async workspace => {
      const layout = resolveRuntimeLayout(workspace);
      await expect(access(layout.home)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(listKnownWorkspaces(workspace)).resolves.toEqual({
        currentWorkspaceKey: layout.workspaceKey,
        workspaces: [{
          workspaceKey: layout.workspaceKey,
          canonicalPath: layout.canonicalPath,
          runCount: 0,
        }],
        failures: [],
      });
      const resolved = await resolveKnownWorkspace(workspace, layout.workspaceKey);

      expect(resolved.isOk() && resolved.value).toEqual({
        workspaceKey: layout.workspaceKey,
        canonicalPath: layout.canonicalPath,
      });
      await expect(access(layout.home)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reads exact run counts and latest update times without changing either shard", async () => {
    await withSharedStorageHome("known-workspaces-metadata", async ({ home, first, second }) => {
      await initializeWorkspace(first, [
        { id: "run-first-old", updatedAt: "2026-08-08T09:00:00.000Z" },
        { id: "run-first-new", updatedAt: "2026-08-09T11:00:00.000Z" },
      ]);
      await initializeWorkspace(second, [
        { id: "run-second", updatedAt: "2026-08-09T10:00:00.000Z" },
      ]);
      const firstLayout = resolveRuntimeLayout(first);
      const secondLayout = resolveRuntimeLayout(second);
      const before = await treeFingerprint(home);

      const listing = await listKnownWorkspaces(first);

      expect(listing).toEqual({
        currentWorkspaceKey: firstLayout.workspaceKey,
        workspaces: [
          {
            workspaceKey: firstLayout.workspaceKey,
            canonicalPath: firstLayout.canonicalPath,
            runCount: 2,
            lastRunUpdatedAt: "2026-08-09T11:00:00.000Z",
          },
          {
            workspaceKey: secondLayout.workspaceKey,
            canonicalPath: secondLayout.canonicalPath,
            runCount: 1,
            lastRunUpdatedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
        failures: [],
      });
      expect(await treeFingerprint(home)).toBe(before);
      const resolved = await resolveKnownWorkspace(first, secondLayout.workspaceKey);
      expect(resolved.isOk() && resolved.value).toEqual({
        workspaceKey: secondLayout.workspaceKey,
        canonicalPath: secondLayout.canonicalPath,
      });
    });
  });

  it("catalogs incompatible storage while keeping path resolution independent from run metadata", async () => {
    await withSharedStorageHome("known-workspaces-failures", async ({ home, first, second }) => {
      await initializeWorkspace(first, [{ id: "run-first", updatedAt: "2026-08-09T11:00:00.000Z" }]);
      await initializeWorkspace(second, [{ id: "run-second", updatedAt: "2026-08-09T12:00:00.000Z" }]);
      const firstLayout = resolveRuntimeLayout(first);
      const secondLayout = resolveRuntimeLayout(second);
      setStorageVersion(secondLayout.databasePath, RUNTIME_STORAGE_VERSION + 1);
      const malformedKey = unusedWorkspaceKey([firstLayout.workspaceKey, secondLayout.workspaceKey]);
      const malformedRoot = join(home, "workspaces", malformedKey);
      await mkdir(malformedRoot);
      await writeFile(join(malformedRoot, "workspace.json"), "{");

      const listing = await listKnownWorkspaces(first);

      expect(listing.workspaces).toEqual([
        {
          workspaceKey: firstLayout.workspaceKey,
          canonicalPath: firstLayout.canonicalPath,
          runCount: 1,
          lastRunUpdatedAt: "2026-08-09T11:00:00.000Z",
        },
        {
          workspaceKey: secondLayout.workspaceKey,
          canonicalPath: secondLayout.canonicalPath,
        },
      ]);
      expect(listing.failures).toEqual([
        expect.objectContaining({ workspaceKey: malformedKey }),
      ]);
      const incompatible = await resolveKnownWorkspace(first, secondLayout.workspaceKey);
      expect(incompatible.isOk() && incompatible.value).toEqual({
        workspaceKey: secondLayout.workspaceKey,
        canonicalPath: secondLayout.canonicalPath,
      });
      const malformed = await resolveKnownWorkspace(first, malformedKey);
      expect(malformed.isErr() && malformed.error).toMatchObject({
        type: "workspace-unavailable",
        workspaceKey: malformedKey,
      });
    });
  });

  it("distinguishes invalid and unknown keys from a workspace whose path disappeared", async () => {
    await withSharedStorageHome("known-workspaces-resolution", async ({ first, second }) => {
      await initializeWorkspace(first, []);
      await initializeWorkspace(second, []);
      const firstLayout = resolveRuntimeLayout(first);
      const secondLayout = resolveRuntimeLayout(second);
      await rm(second, { recursive: true });

      const listing = await listKnownWorkspaces(first);
      expect(listing.workspaces.map(workspace => workspace.workspaceKey)).toEqual([firstLayout.workspaceKey]);
      expect(listing.failures).toEqual([
        expect.objectContaining({ workspaceKey: secondLayout.workspaceKey }),
      ]);

      const unavailable = await resolveKnownWorkspace(first, secondLayout.workspaceKey);
      expect(unavailable.isErr() && unavailable.error).toMatchObject({
        type: "workspace-unavailable",
        workspaceKey: secondLayout.workspaceKey,
      });
      const invalid = await resolveKnownWorkspace(first, "../outside");
      expect(invalid.isErr() && invalid.error).toEqual({
        type: "workspace-key-invalid",
        workspaceKey: "../outside",
        message: "Workspace key '../outside' is invalid.",
      });
      const unknownKey = unusedWorkspaceKey([firstLayout.workspaceKey, secondLayout.workspaceKey]);
      const unknown = await resolveKnownWorkspace(first, unknownKey);
      expect(unknown.isErr() && unknown.error).toEqual({
        type: "workspace-not-found",
        workspaceKey: unknownKey,
        message: `Workspace '${unknownKey}' was not found.`,
      });
    });
  });

  it("keeps a zero-run workspace while isolating platform drift", async () => {
    await withSharedStorageHome("known-workspaces-validation", async ({ home, first, second }) => {
      await initializeWorkspace(first, [{ id: "run-first", updatedAt: "2026-08-09T11:00:00.000Z" }]);
      await initializeWorkspace(second, []);
      const firstLayout = resolveRuntimeLayout(first);
      const secondLayout = resolveRuntimeLayout(second);
      const platformWorkspace = await mkdtemp(join(dirname(first), "known-workspaces-platform-"));
      const restorePlatformHome = setRuntimeHomeForTest(platformWorkspace, home);
      try {
        const platform = process.platform === "linux" ? "darwin" : "linux";
        const platformLayout = await ensureRuntimeLayout(platformWorkspace, { platform });
        if (platformLayout.isErr()) throw new Error(platformLayout.error.message);
        const listing = await listKnownWorkspaces(first);

        expect(listing.workspaces).toEqual([
          {
            workspaceKey: firstLayout.workspaceKey,
            canonicalPath: firstLayout.canonicalPath,
            runCount: 1,
            lastRunUpdatedAt: "2026-08-09T11:00:00.000Z",
          },
          {
            workspaceKey: secondLayout.workspaceKey,
            canonicalPath: secondLayout.canonicalPath,
            runCount: 0,
          },
        ]);
        expect(listing.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({ workspaceKey: platformLayout.value.workspaceKey }),
        ]));
      } finally {
        restorePlatformHome();
        await Promise.all([
          rm(platformWorkspace, { recursive: true, force: true }),
        ]);
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link shard without following it", async () => {
    await withSharedStorageHome("known-workspaces-symlink", async ({ home, first, second }) => {
      await initializeWorkspace(first, []);
      const firstLayout = resolveRuntimeLayout(first);
      const symlinkKey = unusedWorkspaceKey([firstLayout.workspaceKey]);
      await symlink(second, join(home, "workspaces", symlinkKey), "dir");

      const listing = await listKnownWorkspaces(first);

      expect(listing.workspaces.map(workspace => workspace.workspaceKey)).toEqual([firstLayout.workspaceKey]);
      expect(listing.failures).toEqual([
        expect.objectContaining({ workspaceKey: symlinkKey, message: expect.stringContaining("symbolic link") }),
      ]);
    });
  });
});

async function initializeWorkspace(
  workspace: string,
  runs: Array<{ id: string; updatedAt: string }>,
): Promise<void> {
  const store = await openRuntimeStore(workspace);
  store.close();
  const layout = resolveRuntimeLayout(workspace);
  const db = new DatabaseSync(layout.databasePath);
  try {
    const insert = db.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
      ) VALUES (?, ?, 'completed', 'workflow.ts', ?, ?, ?)
    `);
    for (const run of runs) {
      insert.run(run.id, run.id, `sha256:${"a".repeat(64)}`, "2026-08-08T08:00:00.000Z", run.updatedAt);
    }
  } finally {
    db.close();
  }
}

function setStorageVersion(databasePath: string, version: number): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

function unusedWorkspaceKey(used: string[]): string {
  for (const character of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]) {
    const candidate = character.repeat(32);
    if (!used.includes(candidate)) return candidate;
  }
  throw new Error("Could not create an unused workspace key.");
}
