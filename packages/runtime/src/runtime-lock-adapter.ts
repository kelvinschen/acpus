import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureProcessIdentity, probeProcessIdentity } from "./process-liveness.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const maintenanceWaitMs = 5_000;
const runtimeUsersWaitMs = 500;
const retryMs = 25;

type LockOwner = {
  pid: number;
  startToken?: string;
  token: string;
  createdAt: string;
};

export type RuntimeLockDependencies = {
  now(): number;
  wait(delayMs: number): Promise<void>;
};

const defaultDependencies: RuntimeLockDependencies = {
  now: Date.now,
  wait: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
};

export type RuntimeSharedLock = {
  release(): void;
};

export type RuntimeExclusiveLock = {
  release(): Promise<void>;
};

export class RuntimeLockTimeoutError extends Error {
  readonly blocker: "maintenance" | "runtime users";

  constructor(layout: RuntimeLayout, blocker: "maintenance" | "runtime users") {
    super(`Workspace '${layout.workspaceKey}' has active ${blocker}; runtime maintenance cannot proceed.`);
    this.name = "RuntimeLockTimeoutError";
    this.blocker = blocker;
  }
}

export async function openRuntimeSharedLock(
  layout: RuntimeLayout,
  dependencies: RuntimeLockDependencies = defaultDependencies,
): Promise<RuntimeSharedLock> {
  const paths = await ensureLockPaths(layout);
  const owner = lockOwner();
  const holderPath = join(paths.holders, `${owner.pid}-${owner.token}.json`);
  const deadline = dependencies.now() + maintenanceWaitMs;
  while (true) {
    if (await liveLockExists(paths.exclusive)) {
      await waitOrThrow(deadline, layout, "maintenance", dependencies);
      continue;
    }
    await writeFile(holderPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    try {
      if (!await liveLockExists(paths.exclusive)) {
        return {
          release: () => rmSync(holderPath, { force: true }),
        };
      }
    } catch (error) {
      await rm(holderPath, { force: true });
      throw error;
    }
    await rm(holderPath, { force: true });
    await waitOrThrow(deadline, layout, "maintenance", dependencies);
  }
}

export async function openRuntimeExclusiveLock(
  layout: RuntimeLayout,
  dependencies: RuntimeLockDependencies = defaultDependencies,
): Promise<RuntimeExclusiveLock> {
  const paths = await ensureLockPaths(layout);
  const owner = lockOwner();
  const maintenanceDeadline = dependencies.now() + maintenanceWaitMs;
  let runtimeUsersDeadline: number | undefined;
  while (true) {
    try {
      await writeFile(paths.exclusive, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (!await liveLockExists(paths.exclusive)) continue;
      await waitOrThrow(maintenanceDeadline, layout, "maintenance", dependencies);
      continue;
    }

    let liveHolders: string[];
    try {
      liveHolders = await collectLiveHolders(paths.holders);
    } catch (error) {
      await rm(paths.exclusive, { force: true });
      throw error;
    }
    if (liveHolders.length === 0) {
      return { release: () => rm(paths.exclusive, { force: true }) };
    }
    await rm(paths.exclusive, { force: true });
    runtimeUsersDeadline ??= dependencies.now() + runtimeUsersWaitMs;
    await waitOrThrow(runtimeUsersDeadline, layout, "runtime users", dependencies);
  }
}

async function ensureLockPaths(layout: RuntimeLayout): Promise<{ holders: string; exclusive: string }> {
  const tmp = join(layout.home, "tmp");
  const locks = join(tmp, "runtime-locks");
  const root = join(locks, layout.workspaceKey);
  const holders = join(root, "holders");
  for (const path of [layout.home, tmp, locks, root, holders]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Runtime lock directory '${path}' is not a regular directory.`);
    }
    if (layout.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
      await chmod(path, 0o700);
    }
  }
  return { holders, exclusive: join(root, "exclusive.json") };
}

async function collectLiveHolders(root: string): Promise<string[]> {
  const live: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      live.push(path);
      continue;
    }
    try {
      if (await lockIsLive(path)) live.push(path);
      else await rm(path, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return live;
}

async function liveLockExists(path: string): Promise<boolean> {
  try {
    if (await lockIsLive(path)) return true;
    await rm(path, { force: true });
    return false;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function lockIsLive(path: string): Promise<boolean> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) return true;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return false;
    return true;
  }
  if (!isLockOwner(value)) return true;
  return probeProcessIdentity({
    pid: value.pid,
    ...(value.startToken === undefined ? {} : { startToken: value.startToken }),
  }) !== "dead";
}

function lockOwner(): LockOwner {
  const identity = captureProcessIdentity();
  return {
    ...identity,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function isLockOwner(value: unknown): value is LockOwner {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).pid === "number"
    && Number.isSafeInteger((value as Record<string, unknown>).pid)
    && Number((value as Record<string, unknown>).pid) > 0
    && ((value as Record<string, unknown>).startToken === undefined
      || typeof (value as Record<string, unknown>).startToken === "string")
    && typeof (value as Record<string, unknown>).token === "string"
    && typeof (value as Record<string, unknown>).createdAt === "string";
}

async function waitOrThrow(
  deadline: number,
  layout: RuntimeLayout,
  blocker: "maintenance" | "runtime users",
  dependencies: RuntimeLockDependencies,
): Promise<void> {
  if (dependencies.now() >= deadline) {
    throw new RuntimeLockTimeoutError(layout, blocker);
  }
  await dependencies.wait(retryMs);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}
