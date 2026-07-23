import { spawn } from "node:child_process";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { Writable } from "node:stream";
import type { Command } from "commander";
import { gt, prerelease, satisfies, valid } from "semver";
import { inspectInstalledAcpusSkills, type InstalledAcpusSkill } from "./authoring-environment.js";
import { getCliPackageInfo } from "./package-info.js";
import { ansi, supportsColor } from "./terminal-style.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const REGISTRY_URL = "https://registry.npmjs.org";
const UPDATE_CACHE_DIRECTORY = [".acpus", ".local", "update-awareness"];

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

type UpdateAwarenessInput = Omit<UpdateAwarenessEligibility, "topLevelCommand"> & { cwd: string };

type CachePaths = {
  directory: string;
  attempt: string;
  available: string;
  notices: string;
};

type NoticeState = {
  remoteCheckedAt?: string;
  skills: Record<string, { fingerprint: string; notifiedAt: string }>;
};

export type UpdateAwareness = {
  start(command: Command): void;
  finish(exitCode: number): Promise<void>;
};

export function createUpdateAwareness(input: UpdateAwarenessInput): UpdateAwareness {
  let session: { currentVersion: string; paths: CachePaths; includeSkillRefresh: boolean } | undefined;

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
      session = { currentVersion: packageInfo.version, paths, includeSkillRefresh: topLevelCommand !== "doctor" };
    },
    async finish(exitCode) {
      if (session === undefined || exitCode !== 0) return;
      await showUpdateAwareness(input.cwd, session.currentVersion, session.paths, input.stderr, session.includeSkillRefresh);
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
  if (checkedAt === undefined) return true;
  const timestamp = Date.parse(checkedAt);
  return !Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp >= DAY_MS;
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
  update?: AvailableUpdate;
  needsSkillRefresh: boolean;
  color: boolean;
}): string {
  const lines: string[] = [];
  const label = (text: string): string => ansi(text, "1;33", input.color);
  const command = (text: string): string => ansi(text, "1;36", input.color);
  if (input.update !== undefined) {
    lines.push(`${label("Update available:")} acpus ${input.currentVersion} → ${input.update.version}`);
    lines.push(`${label("Run:")} ${command("npm install -g acpus@latest")}`);
  }

  if (input.needsSkillRefresh) {
    lines.push(`${label("Refresh skill:")} ${command("acpus skill install")}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runUpdateAwarenessWorker(args: readonly string[]): Promise<void> {
  const [packageName, currentVersion, directory] = args;
  if (args.length !== 3 || packageName === undefined || currentVersion === undefined || directory === undefined) return;
  if (valid(currentVersion) === null) return;

  const paths = updateAwarenessCachePaths(directory, true);
  try {
    await mkdir(paths.directory, { recursive: true });
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
  cwd: string,
  currentVersion: string,
  paths: CachePaths,
  stderr: Writable,
  includeSkillRefresh: boolean,
): Promise<void> {
  try {
    const [cachedUpdate, notices, installed] = await Promise.all([
      readAvailableUpdate(paths.available),
      readNoticeState(paths.notices),
      includeSkillRefresh ? inspectInstalledAcpusSkills(cwd, homedir(), currentVersion).catch(() => []) : [],
    ]);
    const update = cachedUpdate !== undefined && isAvailableUpdate(cachedUpdate, currentVersion) ? cachedUpdate : undefined;
    const repairs = installed.filter(skill => skill.status !== "aligned" && skill.status !== "missing");
    const now = new Date();
    const remoteNotice = update !== undefined && notices.remoteCheckedAt !== update.checkedAt ? update : undefined;
    const newRepairs = repairs.filter(skill => skillNoticeDue(notices, skill, now));
    const repairsToShow = remoteNotice === undefined ? newRepairs : repairs;
    if (remoteNotice === undefined && repairsToShow.length === 0) return;

    stderr.write(formatUpdateNotice({
      currentVersion,
      ...(remoteNotice === undefined ? {} : { update: remoteNotice }),
      needsSkillRefresh: repairsToShow.length > 0,
      color: supportsColor(stderr),
    }));
    await writeJson(paths.notices, updatedNoticeState(notices, remoteNotice, repairsToShow, now));
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
      const marker = await open(path, "wx");
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
  const skills = Object.fromEntries(Object.entries(recordOf(record?.skills) ?? {}).flatMap(([path, value]) => {
    const notice = recordOf(value);
    return notice !== undefined && typeof notice.fingerprint === "string" && typeof notice.notifiedAt === "string"
      ? [[path, { fingerprint: notice.fingerprint, notifiedAt: notice.notifiedAt }]]
      : [];
  }));
  return {
    ...(typeof record?.remoteCheckedAt === "string" ? { remoteCheckedAt: record.remoteCheckedAt } : {}),
    skills,
  };
}

function skillNoticeDue(notices: NoticeState, skill: InstalledAcpusSkill, now: Date): boolean {
  const previous = notices.skills[skill.path];
  return previous === undefined
    || previous.fingerprint !== skillFingerprint(skill)
    || isUpdateCheckDue(previous.notifiedAt, now);
}

function updatedNoticeState(
  notices: NoticeState,
  update: AvailableUpdate | undefined,
  repairs: readonly InstalledAcpusSkill[],
  now: Date,
): NoticeState {
  const skills = { ...notices.skills };
  for (const skill of repairs) {
    skills[skill.path] = { fingerprint: skillFingerprint(skill), notifiedAt: now.toISOString() };
  }
  const retainedSkills = Object.fromEntries(Object.entries(skills)
    .sort(([, left], [, right]) => Date.parse(right.notifiedAt) - Date.parse(left.notifiedAt))
    .slice(0, 64));
  const remoteCheckedAt = update?.checkedAt ?? notices.remoteCheckedAt;
  return {
    ...(remoteCheckedAt === undefined ? {} : { remoteCheckedAt }),
    skills: retainedSkills,
  };
}

function skillFingerprint(skill: InstalledAcpusSkill): string {
  return `${skill.status}:${skill.version ?? ""}`;
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
    await writeFile(temporary, `${JSON.stringify(value)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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
