import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  runAcpStateRoot,
  runtimeLayoutForGeneration,
  setRuntimeHomeForTest,
  validateWorkspaceManifest,
  type RuntimeLayoutDependencies,
  type WorkspaceManifest,
} from "../src/runtime-layout.js";

const roots: string[] = [];
const generationId = "gen_12345678-1234-4123-8123-123456789abc";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("runtime layout", () => {
  it("places mutable store data below immutable generation metadata", () => {
    const layout = runtimeLayoutForGeneration(resolveRuntimeLayout("/ignored", fakeDependencies()), generationId);
    const workspaceRoot = "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e";
    const generationRoot = `${workspaceRoot}/generations/${generationId}`;

    expect(layout).toMatchObject({
      layoutVersion: 2,
      workspaceRoot,
      manifestPath: `${workspaceRoot}/workspace.json`,
      generationsRoot: `${workspaceRoot}/generations`,
      generationId,
      generationRoot,
      generationMetadataPath: `${generationRoot}/generation.json`,
      runIndexPath: `${generationRoot}/run-index.json`,
      runtimeRoot: `${generationRoot}/store`,
      databasePath: `${generationRoot}/store/runtime.db`,
      runsRoot: `${generationRoot}/store/runs`,
    });
    expect(runAcpStateRoot(layout, "run-1")).toBe(`${generationRoot}/store/runs/run-1/acp`);
  });

  it("keeps inspection and manifest validation free of writes", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const home = join(root, "absent-home");
    await mkdir(workspace);
    const restore = setRuntimeHomeForTest(workspace, home);
    try {
      const layout = resolveRuntimeLayout(workspace);
      expect(validateWorkspaceManifest({}, layout).isErr()).toBe(true);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("creates one v2 manifest that names the active generation", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const restore = setRuntimeHomeForTest(workspace, join(root, "home"));
    try {
      const created = await ensureRuntimeLayout(workspace, { now: () => new Date("2026-07-24T00:00:00.000Z") });
      if (created.isErr()) throw new Error(created.error.message);
      const layout = created.value;
      const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as WorkspaceManifest;
      expect(manifest).toEqual({
        manifestVersion: 2,
        workspaceKey: layout.workspaceKey,
        canonicalPath: layout.canonicalPath,
        platform: process.platform,
        createdAt: "2026-07-24T00:00:00.000Z",
        activeGenerationId: layout.generationId,
      });
      expect(JSON.parse(await readFile(layout.generationMetadataPath, "utf8"))).toEqual({
        schemaVersion: 1,
        id: layout.generationId,
        storageVersion: 19,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      expect(resolveRuntimeLayout(workspace)).toEqual(layout);
      for (const path of [layout.workspaceRoot, layout.generationsRoot, layout.generationRoot!, layout.runtimeRoot]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
      for (const path of [layout.manifestPath, layout.generationMetadataPath]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      await expect(access(layout.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });

  it("reuses the active generation", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const restore = setRuntimeHomeForTest(workspace, join(root, "home"));
    try {
      const first = await ensureRuntimeLayout(workspace);
      const second = await ensureRuntimeLayout(workspace);
      if (first.isErr() || second.isErr()) throw new Error("Expected Runtime layout.");
      expect(second.value).toEqual(first.value);
    } finally {
      restore();
    }
  });

  it("requires repair for a v1 manifest", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const restore = setRuntimeHomeForTest(workspace, join(root, "home"));
    try {
      const layout = resolveRuntimeLayout(workspace);
      await mkdir(layout.workspaceRoot, { recursive: true });
      await writeFile(layout.manifestPath, `${JSON.stringify({
        manifestVersion: 1,
        workspaceKey: layout.workspaceKey,
        canonicalPath: layout.canonicalPath,
        platform: layout.platform,
        createdAt: "2026-07-24T00:00:00.000Z",
      })}\n`);
      const result = await ensureRuntimeLayout(workspace);
      expect(result.isErr() && result.error).toMatchObject({ type: "layout-update-required" });
    } finally {
      restore();
    }
  });

  it("rejects a manifest for another workspace", () => {
    const layout = resolveRuntimeLayout("/ignored", fakeDependencies());
    const result = validateWorkspaceManifest({
      manifestVersion: 2,
      workspaceKey: layout.workspaceKey,
      canonicalPath: "/different/workspace",
      platform: layout.platform,
      createdAt: "2026-07-24T00:00:00.000Z",
      activeGenerationId: generationId,
    }, layout);
    expect(result.isErr() && result.error).toMatchObject({ type: "manifest-mismatch", field: "canonicalPath" });
  });
});

function fakeDependencies(overrides: Partial<RuntimeLayoutDependencies> = {}): Partial<RuntimeLayoutDependencies> {
  return {
    homedir: () => "/home/alice",
    tmpdir: () => "/tmp",
    platform: "linux",
    realpath: () => "/work/project",
    stat: () => ({ isDirectory: () => true }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-runtime-layout-"));
  roots.push(root);
  return root;
}
