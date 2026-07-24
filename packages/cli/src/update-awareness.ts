import { spawn } from "node:child_process";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { Writable } from "node:stream";
import type { Command } from "commander";
import { gt, prerelease, satisfies, valid } from "semver";
import { getCliPackageInfo } from "./package-info.js";
import { ensurePrivateAcpusDirectory, ensurePrivateDirectory } from "./private-directory.js";
import { ansi, supportsColor } from "./terminal-style.js";

const HOUR_MS = 60 * 60 * 1_000;
const REGISTRY_URL = "https://registry.npmjs.org";
const UPDATE_CACHE_DIRECTORY = [".acpus", "cache", "update-awareness"];

// Adjust this single policy when Acpus release cadence changes.
const UPDATE_AWARENESS_POLICY = {
  checkIntervalMs: 4 * HOUR_MS,
  updateNotice: {
    maxPerInstalledVersion: 4,
    cooldownMs: 2 * HOUR_MS,
  },
} as const;

export type AvailableUpdate = {
  checkedAt: string;
  version: string;
  engines?: { node?: string };
};

export type UpdateAwarenessEligibility = {
  argv: readonly string[];
  topLevelCommand?: string;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
};

type UpdateAwarenessInput = Omit<UpdateAwarenessEligibility, "topLevelCommand">;

type CachePaths = {
  directory: string;
  attempt: string;
  available: string;
  notices: string;
};

type UpdateNoticeState = {
  installedVersion: string;
  count: number;
  notifiedAt: string;
};

type NoticeState = {
  update?: UpdateNoticeState;
};

export type UpdateAwareness = {
  start(command: Command): void;
  finish(exitCode: number): Promise<void>;
};

export function createUpdateAwareness(input: UpdateAwarenessInput): UpdateAwareness {
  let session: { currentVersion: string; paths: CachePaths } | undefined;

  return {
    start(command) {
      const topLevelCommand = topLevelCommandName(command);
      if (session !== undefined || !isUpdateAwarenessEligible({
        ...input,
        ...(topLevelCommand === undefined ? {} : { topLevelCommand }),
      })) return;
      const home = homedir();
      if (!home) return;
      const packageInfo = getCliPackageInfo();
      const paths = updateAwarenessCachePaths(home);
      startUpdateWorker(packageInfo.packageName, packageInfo.version, packageInfo.entry, paths);
      session = { currentVersion: packageInfo.version, paths };
    },
    async finish(exitCode) {
      if (session === undefined || exitCode !== 0) return;
      await showUpdateAwareness(session.currentVersion, session.paths, input.stderr);
    },
  };
}

export function isUpdateAwarenessEligible({
  argv,
  topLevelCommand,
  stdout,
  stderr,
  env = process.env,
}: UpdateAwarenessEligibility): boolean {
  return topLevelCommand !== undefined
    && (stdout as Writable & { isTTY?: boolean }).isTTY === true
    && (stderr as Writable & { isTTY?: boolean }).isTTY === true
    && !argv.some(argument => argument === "--json" || argument === "--help" || argument === "-h")
    && env.CI === undefined
    && env.NODE_ENV !== "test"
    && env.npm_lifecycle_event === undefined
    && env.NO_UPDATE_NOTIFIER === undefined;
}

export function isUpdateCheckDue(checkedAt: string | undefined, now = new Date()): boolean {
  const elapsed = elapsedSince(checkedAt, now);
  return elapsed === undefined || elapsed >= UPDATE_AWARENESS_POLICY.checkIntervalMs;
}

function elapsedSince(checkedAt: string | undefined, now: Date): number | undefined {
  if (checkedAt === undefined) return undefined;
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() ? now.getTime() - timestamp : undefined;
}

function parseAvailableUpdate(value: unknown): AvailableUpdate | undefined {
  const record = recordOf(value);
  if (record === undefined || typeof record.checkedAt !== "string" || typeof record.version !== "string") return undefined;
  if (!Number.isFinite(Date.parse(record.checkedAt))) return undefined;
  if (record.engines === undefined) return { checkedAt: record.checkedAt, version: record.version };
  const engines = recordOf(record.engines);
  if (engines === undefined || (engines.node !== undefined && typeof engines.node !== "string")) return undefined;
  return {
    checkedAt: record.checkedAt,
    version: record.version,
    ...(engines.node === undefined ? {} : { engines: { node: engines.node } }),
  };
}

export function isAvailableUpdate(
  update: AvailableUpdate,
  currentVersion: string,
  nodeVersion = process.versions.node,
): boolean {
  try {
    return valid(update.version) !== null
      && valid(currentVersion) !== null
      && prerelease(update.version) === null
      && gt(update.version, currentVersion)
      && (update.engines?.node === undefined || satisfies(nodeVersion, update.engines.node));
  } catch {
    return false;
  }
}

export function formatUpdateNotice(input: {
  currentVersion: string;
  update: AvailableUpdate;
  color: boolean;
}): string {
  const label = (text: string): string => ansi(text, "1;33", input.color);
  const command = (text: string): string => ansi(text, "1;36", input.color);
  return [
    `${label("Update available:")} acpus ${input.currentVersion} → ${input.update.version}`,
    `${label("Run:")} ${command("npm install -g acpus@latest")}`,
    `${label("Refresh skill:")} ${command("acpus skill install")}`,
    "",
  ].join("\n");
}

export async function runUpdateAwarenessWorker(args: readonly string[]): Promise<void> {
  const [packageName, currentVersion, directory] = args;
  if (args.length !== 3 || packageName === undefined || currentVersion === undefined || directory === undefined) return;
  if (valid(currentVersion) === null) return;

  const paths = updateAwarenessCachePaths(directory, true);
  try {
    await ensurePrivateUpdateCacheDirectory(paths.directory);
    if (!await claimUpdateCheck(paths.attempt, new Date())) return;
    const update = await fetchLatestUpdate(packageName, currentVersion);
    if (update === undefined) await rm(paths.available, { force: true });
    else await writeJson(paths.available, update);
  } catch {
    // Update awareness is always best effort.
  }
}

function topLevelCommandName(command: Command): string | undefined {
  let topLevel = command;
  while (topLevel.parent?.parent !== undefined && topLevel.parent.parent !== null) topLevel = topLevel.parent;
  return topLevel.parent === undefined || topLevel.parent === null ? undefined : topLevel.name();
}

function updateAwarenessCachePaths(homeOrDirectory: string, exactDirectory = false): CachePaths {
  const directory = exactDirectory ? homeOrDirectory : join(homeOrDirectory, ...UPDATE_CACHE_DIRECTORY);
  return {
    directory,
    attempt: join(directory, "last-attempt.json"),
    available: join(directory, "available.json"),
    notices: join(directory, "notices.json"),
  };
}

function startUpdateWorker(packageName: string, version: string, cliEntry: string, paths: CachePaths): void {
  if (!isUpdateCheckDue(readAttemptTimestamp(paths.attempt))) return;
  const extension = extname(cliEntry);
  const worker = join(dirname(cliEntry), `update-awareness-worker${extension}`);
  try {
    const child = spawn(process.execPath, [
      ...(extension === ".ts" ? process.execArgv : []),
      worker,
      packageName,
      version,
      paths.directory,
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Update awareness is always best effort.
  }
}

async function showUpdateAwareness(
  currentVersion: string,
  paths: CachePaths,
  stderr: Writable,
): Promise<void> {
  try {
    const [cachedUpdate, notices] = await Promise.all([
      readAvailableUpdate(paths.available),
      readNoticeState(paths.notices),
    ]);
    const update = cachedUpdate !== undefined && isAvailableUpdate(cachedUpdate, currentVersion) ? cachedUpdate : undefined;
    const now = new Date();
    const updateNotice = update !== undefined && updateNoticeDue(notices.update, currentVersion, now) ? update : undefined;
    if (updateNotice === undefined) return;

    stderr.write(formatUpdateNotice({
      currentVersion,
      update: updateNotice,
      color: supportsColor(stderr),
    }));
    await ensurePrivateUpdateCacheDirectory(paths.directory);
    await writeJson(paths.notices, updatedNoticeState(notices, currentVersion, now));
  } catch {
    // Update awareness must never affect the command result.
  }
}

async function fetchLatestUpdate(packageName: string, currentVersion: string): Promise<AvailableUpdate | undefined> {
  const response = await fetch(`${REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`, {
    headers: {
      accept: "application/json",
      "user-agent": `${packageName}/${currentVersion} update-awareness`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const record = recordOf(await response.json());
  if (record === undefined || record.deprecated !== undefined) return undefined;
  const engines = record.engines === undefined ? undefined : recordOf(record.engines);
  if (record.engines !== undefined && engines === undefined) return undefined;
  if (engines?.node !== undefined && typeof engines.node !== "string") return undefined;
  const update = parseAvailableUpdate({
    checkedAt: new Date().toISOString(),
    version: record.version,
    ...(engines?.node === undefined ? {} : { engines: { node: engines.node } }),
  });
  return update !== undefined && isAvailableUpdate(update, currentVersion) ? update : undefined;
}

async function claimUpdateCheck(path: string, now: Date): Promise<boolean> {
  for (;;) {
    const existing = await readJson(path);
    const checkedAt = parseAttempt(existing);
    if (!isUpdateCheckDue(checkedAt, now)) return false;

    const stalePath = `${path}.${process.pid}.${Date.now()}.stale`;
    let moved = false;
    try {
      await rename(path, stalePath);
      moved = true;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }

    try {
      const marker = await open(path, "wx", 0o600);
      try {
        await marker.writeFile(JSON.stringify({ checkedAt: now.toISOString() }));
      } finally {
        await marker.close();
      }
      return true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    } finally {
      if (moved) await rm(stalePath, { force: true });
    }
  }
}

function readAttemptTimestamp(path: string): string | undefined {
  try {
    return parseAttempt(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function readAvailableUpdate(path: string): Promise<AvailableUpdate | undefined> {
  return parseAvailableUpdate(await readJson(path));
}

async function readNoticeState(path: string): Promise<NoticeState> {
  const record = recordOf(await readJson(path));
  const update = recordOf(record?.update);
  return {
    ...(update !== undefined
      && typeof update.installedVersion === "string"
      && typeof update.count === "number"
      && Number.isSafeInteger(update.count)
      && update.count > 0
      && typeof update.notifiedAt === "string"
      && Number.isFinite(Date.parse(update.notifiedAt))
      ? { update: { installedVersion: update.installedVersion, count: update.count, notifiedAt: update.notifiedAt } }
      : {}),
  };
}

function updateNoticeDue(previous: UpdateNoticeState | undefined, currentVersion: string, now: Date): boolean {
  const elapsed = elapsedSince(previous?.notifiedAt, now);
  return previous === undefined
    || previous.installedVersion !== currentVersion
    || (previous.count < UPDATE_AWARENESS_POLICY.updateNotice.maxPerInstalledVersion
      && (elapsed === undefined || elapsed >= UPDATE_AWARENESS_POLICY.updateNotice.cooldownMs));
}

function updatedNoticeState(
  notices: NoticeState,
  currentVersion: string,
  now: Date,
): NoticeState {
  return {
    update: {
      installedVersion: currentVersion,
      count: notices.update?.installedVersion === currentVersion ? notices.update.count + 1 : 1,
      notifiedAt: now.toISOString(),
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensurePrivateUpdateCacheDirectory(directory: string): Promise<void> {
  const expected = join(homedir(), ...UPDATE_CACHE_DIRECTORY);
  if (directory === expected) await ensurePrivateAcpusDirectory(directory);
  else await ensurePrivateDirectory(directory);
}

function parseAttempt(value: unknown): string | undefined {
  const checkedAt = recordOf(value)?.checkedAt;
  return typeof checkedAt === "string" && Number.isFinite(Date.parse(checkedAt)) ? checkedAt : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingPath(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
