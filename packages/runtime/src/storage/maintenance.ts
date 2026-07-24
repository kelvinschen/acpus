import { access, chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureRuntimeLayout,
  resolveRuntimeLayout,
  validateRuntimeLayoutBoundary,
  type RuntimeLayout,
} from "../runtime-layout.js";
import {
  assertRuntimeArchiveSafe,
  IncompatibleRuntimeDatabaseError,
  openExistingRuntimeStore,
  openExistingRuntimeStoreAtLayout,
  openRuntimeStoreAtLayout,
  readRuntimeStorageVersion,
  RUNTIME_STORAGE_VERSION,
} from "../store/store.js";
import {
  acquireRuntimeExclusiveLock,
  RuntimeLockTimeoutError,
  type RuntimeExclusiveLock,
} from "../runtime-lock.js";
import {
  inspectRuntimeGeneration,
  PartialRuntimeGenerationError,
} from "./generation.js";

export async function prepareRuntimeForNewRun(cwd: string): Promise<void> {
  let layout = resolveRuntimeLayout(cwd);
  await validateRuntimeLayoutBoundary(layout);
  if (!await generationNeedsRecovery(layout)) {
    const ensured = await ensureRuntimeLayout(cwd);
    if (ensured.isOk()) {
      layout = ensured.value;
      try {
        const current = await openExistingRuntimeStoreAtLayout(layout, true, { lock: false });
        if (current) {
          current.close();
          return;
        }
      } catch (error) {
        if (!(error instanceof IncompatibleRuntimeDatabaseError)) throw error;
      }
    } else if (ensured.error.type !== "manifest-mismatch" || ensured.error.field !== "filesystemIdentity") {
      throw new Error(ensured.error.message);
    }
  }

  let lock: RuntimeExclusiveLock;
  try {
    lock = await acquireRuntimeExclusiveLock(layout);
  } catch (error) {
    if (error instanceof RuntimeLockTimeoutError
      && error.blocker === "runtime users"
      && await compatibleRuntimeExists(cwd)) return;
    throw error;
  }
  try {
    layout = resolveRuntimeLayout(cwd);
    await archivePartialGenerationIfNeeded(layout, lock);
    let ensured = await ensureRuntimeLayout(cwd);
    if (ensured.isErr()) {
      if (ensured.error.type !== "manifest-mismatch" || ensured.error.field !== "filesystemIdentity") {
        throw new Error(ensured.error.message);
      }
      const storageVersion = await readRuntimeStorageVersion(layout) ?? RUNTIME_STORAGE_VERSION;
      await archiveRuntimeGeneration(layout, storageVersion, lock);
      await rm(layout.manifestPath);
      ensured = await ensureRuntimeLayout(cwd);
      if (ensured.isErr()) throw new Error(ensured.error.message);
    }
    layout = ensured.value;

    try {
      const store = await openRuntimeStoreAtLayout(layout, { lock: false, prevalidated: true });
      store.close();
    } catch (error) {
      if (!(error instanceof IncompatibleRuntimeDatabaseError)) throw error;
      await archiveRuntimeGeneration(layout, error.userVersion, lock);
      await recreateRuntimeGeneration(layout);
    }
  } finally {
    await lock.release();
  }
}

async function compatibleRuntimeExists(cwd: string): Promise<boolean> {
  try {
    const store = await openExistingRuntimeStore(cwd);
    if (!store) return false;
    store.close();
    return true;
  } catch (error) {
    if (error instanceof IncompatibleRuntimeDatabaseError) return false;
    throw error;
  }
}

async function generationNeedsRecovery(layout: RuntimeLayout): Promise<boolean> {
  try {
    const state = await inspectRuntimeGeneration(layout);
    return state === "complete" && await pathIsMissing(layout.manifestPath);
  } catch (error) {
    if (error instanceof PartialRuntimeGenerationError) return true;
    throw error;
  }
}

async function archivePartialGenerationIfNeeded(
  layout: RuntimeLayout,
  lock: RuntimeExclusiveLock,
): Promise<void> {
  let state;
  try {
    state = await inspectRuntimeGeneration(layout);
  } catch (error) {
    if (!(error instanceof PartialRuntimeGenerationError)) throw error;
    await archiveRuntimeGeneration(layout, await runtimeArchiveVersion(layout), lock);
    return;
  }
  if (state !== "complete" || !await pathIsMissing(layout.manifestPath)) return;
  await archiveRuntimeGeneration(layout, await readRuntimeStorageVersion(layout), lock);
}

export async function archiveRuntimeGeneration(
  layout: RuntimeLayout,
  storageVersion = RUNTIME_STORAGE_VERSION,
  heldLock?: RuntimeExclusiveLock,
): Promise<string | undefined> {
  await validateRuntimeLayoutBoundary(layout);
  const lock = heldLock ?? await acquireRuntimeExclusiveLock(layout);
  try {
    let info;
    try {
      info = await lstat(layout.runtimeRoot);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return undefined;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Runtime generation '${layout.runtimeRoot}' is not a regular directory.`);
    }
    await assertRuntimeArchiveSafe(layout);
    if ((await readdir(layout.runtimeRoot)).length === 0) {
      await rm(layout.runtimeRoot);
      return undefined;
    }
    await ensurePrivateDirectory(layout.archivesRoot, layout.platform);
    const archive = await unusedArchivePath(layout, storageVersion);
    await rename(layout.runtimeRoot, archive);
    return archive;
  } finally {
    if (!heldLock) await lock.release();
  }
}

export async function recreateRuntimeGeneration(layout: RuntimeLayout): Promise<void> {
  await validateRuntimeLayoutBoundary(layout);
  for (const path of [layout.runtimeRoot, layout.runsRoot, layout.sourcesRoot, layout.trashRoot]) {
    await ensurePrivateDirectory(path, layout.platform);
  }
  const store = await openRuntimeStoreAtLayout(layout, { lock: false, prevalidated: true });
  store.close();
}

export async function runtimeArchiveVersion(layout: RuntimeLayout): Promise<number> {
  await validateRuntimeLayoutBoundary(layout);
  let root;
  let database;
  try {
    root = await lstat(layout.runtimeRoot);
    database = await lstat(layout.databasePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return RUNTIME_STORAGE_VERSION;
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory() || database.isSymbolicLink() || !database.isFile()) {
    return RUNTIME_STORAGE_VERSION;
  }
  return await readRuntimeStorageVersion(layout) ?? RUNTIME_STORAGE_VERSION;
}

async function ensurePrivateDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Runtime-owned path '${path}' is not a regular directory.`);
  }
  if (platform !== "win32") await chmod(path, 0o700);
}

async function unusedArchivePath(layout: RuntimeLayout, storageVersion: number): Promise<string> {
  const now = Date.now();
  for (let offset = 0; ; offset += 1) {
    const timestamp = new Date(now + offset).toISOString().replaceAll("-", "").replaceAll(":", "");
    const path = join(layout.archivesRoot, `${timestamp}-v${storageVersion}`);
    try {
      await access(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return path;
      throw error;
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return true;
    throw error;
  }
}
