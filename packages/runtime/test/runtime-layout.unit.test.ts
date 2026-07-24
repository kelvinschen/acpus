import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  setRuntimeHomeForTest,
  validateWorkspaceManifest,
  type RuntimeLayoutDependencies,
  type WorkspaceManifest,
} from "../src/runtime-layout.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("runtime layout", () => {
  it("derives a stable workspace shard and all owned paths from the canonical workspace", () => {
    const layout = resolveRuntimeLayout("/ignored", fakeDependencies());

    expect(layout).toMatchObject({
      canonicalPath: "/work/project",
      key: "1cb2c322ad0b4052beea73178ad65c1e",
      workspaceKey: "1cb2c322ad0b4052beea73178ad65c1e",
      platform: "linux",
      home: "/home/alice/.acpus",
      workspaceRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e",
      manifestPath: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/workspace.json",
      runtimeRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/runtime",
      databasePath: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/runtime/runtime.db",
      runsRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/runtime/runs",
      sourcesRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/runtime/sources",
      trashRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/runtime/trash",
      archivesRoot: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/archives",
      daemonSocketPath: "/home/alice/.acpus/workspaces/1cb2c322ad0b4052beea73178ad65c1e/daemon.sock",
      filesystemIdentity: "7:11:13",
    });
    expect(layout.daemonEndpoint).toBe(layout.daemonSocketPath);
  });

  it("uses a home scope and workspace key for platform-specific fallback endpoints", () => {
    const windows = resolveRuntimeLayout("/ignored", fakeDependencies({
      platform: "win32",
      realpath: () => "C:\\work\\project",
    }));
    expect(windows.daemonEndpoint).toMatch(/^\\\\\.\\pipe\\acpus-daemon-[a-f0-9]{32}-[a-f0-9]{32}$/);
    expect(windows.daemonEndpoint.endsWith(`-${windows.key}`)).toBe(true);

    const longHome = `/${"a".repeat(120)}`;
    const linux = resolveRuntimeLayout("/ignored", fakeDependencies({
      homedir: () => longHome,
    }));
    expect(linux.daemonEndpoint).toMatch(/^\0acpus-daemon-[a-f0-9]{32}-[a-f0-9]{32}$/);
    expect(linux.daemonEndpoint.endsWith(`-${linux.key}`)).toBe(true);

    const darwin = resolveRuntimeLayout("/ignored", fakeDependencies({
      platform: "darwin",
      homedir: () => longHome,
      tmpdir: () => "/private/tmp",
    }));
    expect(dirname(darwin.daemonEndpoint)).toMatch(/^\/private\/tmp\/acpus-daemon-[a-f0-9]{32}$/);
    expect(basename(darwin.daemonEndpoint)).toBe(`${darwin.key}.sock`);

    const longTemporaryDirectory = resolveRuntimeLayout("/ignored", fakeDependencies({
      platform: "darwin",
      homedir: () => longHome,
      tmpdir: () => `/${"t".repeat(120)}`,
    }));
    expect(dirname(longTemporaryDirectory.daemonEndpoint)).toMatch(/^\/tmp\/acpus-daemon-[a-f0-9]{32}$/);
    expect(Buffer.byteLength(longTemporaryDirectory.daemonEndpoint)).toBeLessThan(100);
  });

  it("separates global daemon namespaces for different Acpus homes without changing the workspace key", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const common = {
        platform,
        realpath: () => "/same/canonical/workspace",
        tmpdir: () => "/private/tmp",
      };
      const alice = resolveRuntimeLayout("/ignored", fakeDependencies({
        ...common,
        homedir: () => `/${"a".repeat(120)}/alice`,
      }));
      const bob = resolveRuntimeLayout("/ignored", fakeDependencies({
        ...common,
        homedir: () => `/${"b".repeat(120)}/bob`,
      }));

      expect(alice.key).toBe(bob.key);
      expect(alice.daemonEndpoint).not.toBe(bob.daemonEndpoint);
      expect(resolveRuntimeLayout("/ignored", fakeDependencies({
        ...common,
        homedir: () => `/${"a".repeat(120)}/alice`,
      })).daemonEndpoint).toBe(alice.daemonEndpoint);
    }
  });

  it.skipIf(process.platform === "win32")("collapses symlink aliases through the canonical workspace path", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, "dir");
    const restoreHome = setRuntimeHomeForTest(workspace, join(root, "home"));
    try {
      expect(resolveRuntimeLayout(alias)).toEqual(resolveRuntimeLayout(workspace));
    } finally {
      restoreHome();
    }
  });

  it("keeps read-only resolution and manifest validation free of writes", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const home = join(root, "absent-home");
    await mkdir(workspace);
    const restoreHome = setRuntimeHomeForTest(workspace, home);
    try {
      const layout = resolveRuntimeLayout(workspace);
      const validation = validateWorkspaceManifest({}, layout);
      expect(validation.isErr() && validation.error).toMatchObject({
        type: "manifest-invalid",
        path: layout.manifestPath,
      });
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreHome();
    }
  });

  it("rejects workspace manifests outside the current key format", () => {
    const layout = resolveRuntimeLayout("/ignored", fakeDependencies());
    const validation = validateWorkspaceManifest({
      manifestVersion: 1,
      workspaceKey: layout.workspaceKey.toUpperCase(),
      canonicalPath: layout.canonicalPath,
      platform: layout.platform,
      filesystemIdentity: layout.filesystemIdentity,
      createdAt: "2026-07-24T00:00:00.000Z",
    }, layout);

    expect(validation.isErr() && validation.error).toMatchObject({
      type: "manifest-invalid",
      path: layout.manifestPath,
    });
  });

  it("creates the private layout and preserves a valid existing manifest", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace);
    const restoreHome = setRuntimeHomeForTest(workspace, home);
    try {
      const first = await ensureRuntimeLayout(workspace, { now: () => new Date("2026-07-24T00:00:00.000Z") });
      if (first.isErr()) throw new Error(first.error.message);
      const manifest = JSON.parse(await readFile(first.value.manifestPath, "utf8")) as WorkspaceManifest;
      expect(manifest).toEqual({
        manifestVersion: 1,
        workspaceKey: first.value.key,
        canonicalPath: first.value.canonicalPath,
        platform: process.platform,
        filesystemIdentity: first.value.filesystemIdentity,
        createdAt: "2026-07-24T00:00:00.000Z",
      });

      const second = await ensureRuntimeLayout(workspace, { now: () => new Date("2027-01-01T00:00:00.000Z") });
      expect(second.isOk()).toBe(true);
      expect(JSON.parse(await readFile(first.value.manifestPath, "utf8"))).toEqual(manifest);

      for (const path of [
        first.value.home,
        first.value.workspaceRoot,
        first.value.runtimeRoot,
        first.value.runsRoot,
        first.value.sourcesRoot,
        first.value.trashRoot,
        first.value.archivesRoot,
      ]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
      expect((await stat(first.value.manifestPath)).mode & 0o777).toBe(0o600);
      await expect(access(first.value.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreHome();
    }
  });

  it("distinguishes malformed manifests from workspace identity mismatches", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const restoreHome = setRuntimeHomeForTest(workspace, join(root, "home"));
    try {
      const created = await ensureRuntimeLayout(workspace);
      if (created.isErr()) throw new Error(created.error.message);

      await writeFile(created.value.manifestPath, "{");
      const malformed = await ensureRuntimeLayout(workspace);
      expect(malformed.isErr() && malformed.error).toMatchObject({
        type: "manifest-invalid",
        path: created.value.manifestPath,
      });

      const mismatched: WorkspaceManifest = {
        manifestVersion: 1,
        workspaceKey: created.value.key,
        canonicalPath: "/different/workspace",
        platform: created.value.platform,
        createdAt: "2026-07-24T00:00:00.000Z",
      };
      await writeFile(created.value.manifestPath, JSON.stringify(mismatched));
      const result = await ensureRuntimeLayout(workspace);
      expect(result.isErr() && result.error).toMatchObject({
        type: "manifest-mismatch",
        field: "canonicalPath",
        expected: created.value.canonicalPath,
        actual: "/different/workspace",
      });
    } finally {
      restoreHome();
    }
  });

  it.skipIf(process.platform === "win32").each([
    "home",
    "workspaces",
    "manifest",
    "runtime",
    "sources",
    "trash",
  ] as const)("rejects symbolic-link substitution of the %s path", async targetName => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace);
    const restoreHome = setRuntimeHomeForTest(workspace, home);
    try {
      const created = await ensureRuntimeLayout(workspace);
      if (created.isErr()) throw new Error(created.error.message);
      const target = targetName === "home"
        ? created.value.home
        : targetName === "workspaces"
          ? join(created.value.home, "workspaces")
          : targetName === "manifest"
            ? created.value.manifestPath
            : targetName === "runtime"
              ? created.value.runtimeRoot
              : targetName === "sources"
                ? created.value.sourcesRoot
                : created.value.trashRoot;
      const outside = join(root, `outside-${targetName}`);
      await rm(target, { recursive: true, force: true });
      if (targetName === "manifest") await writeFile(outside, "{}");
      else await mkdir(outside);
      await symlink(outside, target, targetName === "manifest" ? "file" : "dir");

      const result = await ensureRuntimeLayout(workspace);

      expect(result.isErr() && result.error).toMatchObject({
        type: "filesystem",
        operation: targetName === "manifest" ? "read-manifest" : "create-directory",
        path: target,
      });
      await expect(access(outside)).resolves.toBeUndefined();
    } finally {
      restoreHome();
    }
  });

  it("rejects a replaced directory when both filesystem identities are available", () => {
    const layout = resolveRuntimeLayout("/ignored", fakeDependencies());
    const manifest: WorkspaceManifest = {
      manifestVersion: 1,
      workspaceKey: layout.key,
      canonicalPath: layout.canonicalPath,
      platform: layout.platform,
      filesystemIdentity: "7:99:13",
      createdAt: "2026-07-24T00:00:00.000Z",
    };

    const validation = validateWorkspaceManifest(manifest, layout);
    expect(validation.isErr() && validation.error).toMatchObject({
      type: "manifest-mismatch",
      path: layout.manifestPath,
      field: "filesystemIdentity",
      expected: "7:11:13",
      actual: "7:99:13",
    });
  });

  it("scopes test home overrides by canonical workspace", async () => {
    const root = await temporaryRoot();
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const restoreFirst = setRuntimeHomeForTest(firstWorkspace, join(root, "first-home"));
    const restoreSecond = setRuntimeHomeForTest(secondWorkspace, join(root, "second-home"));
    try {
      expect(resolveRuntimeLayout(firstWorkspace).home).toBe(join(root, "first-home"));
      expect(resolveRuntimeLayout(secondWorkspace).home).toBe(join(root, "second-home"));
      restoreFirst();
      expect(resolveRuntimeLayout(firstWorkspace).home).not.toBe(join(root, "first-home"));
      expect(resolveRuntimeLayout(secondWorkspace).home).toBe(join(root, "second-home"));
    } finally {
      restoreFirst();
      restoreSecond();
    }
  });
});

function fakeDependencies(
  overrides: Partial<RuntimeLayoutDependencies> = {},
): Partial<RuntimeLayoutDependencies> {
  return {
    homedir: () => "/home/alice",
    tmpdir: () => "/tmp",
    platform: "linux",
    realpath: () => "/work/project",
    stat: () => ({
      dev: 7n,
      ino: 11n,
      birthtimeMs: 13n,
      isDirectory: () => true,
    }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-runtime-layout-"));
  roots.push(root);
  return root;
}
