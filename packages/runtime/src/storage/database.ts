import { copyFile, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RUNTIME_APPLICATION_ID = 0x41435055;
export const RUNTIME_STORAGE_VERSION = 9;

export type RuntimeDatabaseFormat = {
  applicationId: number;
  userVersion: number;
};

const RUNTIME_STORE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";
let databaseSyncConstructor: typeof import("node:sqlite").DatabaseSync | undefined;

export class UnrecognizedRuntimeDatabaseError extends Error {
  constructor(readonly path: string) {
    super(`Runtime database '${path}' does not have a valid SQLite header.`);
    this.name = "UnrecognizedRuntimeDatabaseError";
  }
}

export class RuntimeDatabaseProbeChangedError extends Error {
  constructor(readonly path: string, readonly sourcePath: string) {
    super(`Runtime database probe source '${sourcePath}' changed while '${path}' was inspected.`);
    this.name = "RuntimeDatabaseProbeChangedError";
  }
}

export class IncompatibleRuntimeDatabaseError extends Error {
  constructor(
    readonly path: string,
    readonly applicationId: number,
    readonly userVersion: number,
  ) {
    super(
      `Runtime database '${path}' uses application_id ${applicationId} and user_version ${userVersion}; `
      + `expected ${RUNTIME_APPLICATION_ID} and ${RUNTIME_STORAGE_VERSION}.`,
    );
    this.name = "IncompatibleRuntimeDatabaseError";
  }
}

export function isRuntimeStoreBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_LOCKED") return true;
  return candidate.code === "ERR_SQLITE_ERROR" && (candidate.errcode === 5 || candidate.errcode === 6);
}

export async function openRuntimeDatabase(
  path: string,
  options: { readOnly?: boolean; immutable?: boolean } = {},
): Promise<DatabaseSync> {
  await validateRuntimeDatabasePaths(path);
  return openRuntimeDatabaseUnchecked(path, options);
}

function openRuntimeDatabaseUnchecked(
  path: string,
  options: { readOnly?: boolean; immutable?: boolean },
): DatabaseSync {
  const location = options.immutable ? pathToFileURL(path) : path;
  if (location instanceof URL) location.searchParams.set("immutable", "1");
  const db = openSqliteDatabase(location, {
    enableForeignKeyConstraints: true,
    readOnly: options.readOnly ?? false,
    timeout: RUNTIME_STORE_BUSY_TIMEOUT_MS,
  });
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function openSqliteDatabase(
  location: string | URL,
  options: {
    enableForeignKeyConstraints?: boolean;
    readOnly?: boolean;
    timeout?: number;
  } = {},
): DatabaseSync {
  const DatabaseSync = loadDatabaseSync();
  return new DatabaseSync(location, options);
}

export async function validateRuntimeDatabasePaths(path: string): Promise<boolean> {
  let databasePresent = true;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Runtime database '${path}' is not a regular file.`);
    }
  } catch (error) {
    if (isMissing(error)) databasePresent = false;
    else throw error;
  }
  for (const [suffix, label] of [["-wal", "WAL"], ["-shm", "shared memory"]] as const) {
    const sidecar = `${path}${suffix}`;
    try {
      const info = await lstat(sidecar);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Runtime database ${label} '${sidecar}' is not a regular file.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return databasePresent;
}

export async function hasNoPendingRuntimeDatabaseWal(path: string): Promise<boolean> {
  try {
    const info = await lstat(`${path}-wal`);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Runtime database WAL '${path}-wal' is not a regular file.`);
    }
    return info.size === 0;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

export async function readRuntimeDatabaseFormat(
  path: string,
): Promise<RuntimeDatabaseFormat | undefined> {
  if (!await validateRuntimeDatabasePaths(path)) return undefined;
  let mainIdentity: RegularFileIdentity;
  try {
    mainIdentity = (await regularFileIdentity(path, "Runtime database", false))!;
  } catch (error) {
    if (isMissing(error)) throw new RuntimeDatabaseProbeChangedError(path, path);
    throw error;
  }
  let mainFormat: RuntimeDatabaseFormat;
  try {
    mainFormat = await readMainDatabaseFormat(path);
  } catch (error) {
    if (isMissing(error)) throw new RuntimeDatabaseProbeChangedError(path, path);
    if (error instanceof UnrecognizedRuntimeDatabaseError) {
      await verifyProbeSources(path, [{
        path,
        destination: path,
        label: "Runtime database",
        optional: false,
        identity: mainIdentity,
      }]);
    }
    throw error;
  }
  const walPath = `${path}-wal`;
  const walIdentity = await regularFileIdentity(walPath, "Runtime database WAL", true);
  if (!walIdentity || walIdentity.size === 0n) {
    await verifyProbeSources(path, [
      {
        path,
        destination: path,
        label: "Runtime database",
        optional: false,
        identity: mainIdentity,
      },
      {
        path: walPath,
        destination: walPath,
        label: "Runtime database WAL",
        optional: true,
        identity: walIdentity,
      },
    ]);
    return mainFormat;
  }

  const probeRoot = await mkdtemp(join(tmpdir(), "acpus-runtime-store-probe-"));
  const probeDatabasePath = join(probeRoot, "runtime.db");
  try {
    let sources: ProbeSource[];
    try {
      sources = await captureProbeSources(path, probeDatabasePath);
    } catch (error) {
      if (isMissing(error)) throw new RuntimeDatabaseProbeChangedError(path, path);
      throw error;
    }
    try {
      await Promise.all(sources.flatMap(source => source.identity
        ? [copyFile(source.path, source.destination)]
        : []));
    } catch (error) {
      if (isMissing(error)) throw new RuntimeDatabaseProbeChangedError(path, path);
      throw error;
    }
    await verifyProbeSources(path, sources);
    const database = openRuntimeDatabaseUnchecked(probeDatabasePath, { readOnly: true });
    try {
      return runtimeDatabaseFormat(database);
    } finally {
      database.close();
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function readMainDatabaseFormat(path: string): Promise<RuntimeDatabaseFormat> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
      throw new UnrecognizedRuntimeDatabaseError(path);
    }
    return {
      userVersion: header.readUInt32BE(60),
      applicationId: header.readUInt32BE(68),
    };
  } finally {
    await file.close();
  }
}

type ProbeSource = {
  path: string;
  destination: string;
  label: string;
  optional: boolean;
  identity: RegularFileIdentity | undefined;
};

type RegularFileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

async function captureProbeSources(databasePath: string, probeDatabasePath: string): Promise<ProbeSource[]> {
  const candidates = [
    { path: databasePath, destination: probeDatabasePath, label: "Runtime database", optional: false },
    { path: `${databasePath}-wal`, destination: `${probeDatabasePath}-wal`, label: "Runtime database WAL", optional: false },
    { path: `${databasePath}-shm`, destination: `${probeDatabasePath}-shm`, label: "Runtime database shared memory", optional: true },
  ];
  const sources: ProbeSource[] = [];
  for (const candidate of candidates) {
    const identity = await regularFileIdentity(candidate.path, candidate.label, candidate.optional);
    sources.push({ ...candidate, identity });
  }
  return sources;
}

async function verifyProbeSources(databasePath: string, sources: ProbeSource[]): Promise<void> {
  for (const source of sources) {
    let current: RegularFileIdentity | undefined;
    try {
      current = await regularFileIdentity(source.path, source.label, source.optional);
    } catch (error) {
      if (isMissing(error)) throw new RuntimeDatabaseProbeChangedError(databasePath, source.path);
      throw error;
    }
    if (!sameRegularFileIdentity(current, source.identity)) {
      throw new RuntimeDatabaseProbeChangedError(databasePath, source.path);
    }
  }
}

function sameRegularFileIdentity(
  left: RegularFileIdentity | undefined,
  right: RegularFileIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function regularFileIdentity(
  path: string,
  label: string,
  optional: boolean,
): Promise<RegularFileIdentity | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} '${path}' is not a regular file.`);
    }
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  } catch (error) {
    if (optional && isMissing(error)) return undefined;
    throw error;
  }
}

export function runtimeDatabaseFormat(db: DatabaseSync): RuntimeDatabaseFormat {
  const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return {
    applicationId: Number(application.application_id),
    userVersion: Number(version.user_version),
  };
}

export function assertRuntimeDatabaseFormat(format: RuntimeDatabaseFormat, path: string): void {
  if (format.applicationId === RUNTIME_APPLICATION_ID && format.userVersion === RUNTIME_STORAGE_VERSION) return;
  throw new IncompatibleRuntimeDatabaseError(path, format.applicationId, format.userVersion);
}

export function rollbackDatabaseTransaction(
  db: DatabaseSync,
  transactionStarted: boolean,
  failure: unknown,
): unknown {
  if (!transactionStarted) return failure;
  try {
    db.exec("ROLLBACK");
    return failure;
  } catch (rollbackError) {
    return new AggregateError([failure, rollbackError], "Operation failed and its database transaction could not be rolled back.");
  }
}

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
  if (databaseSyncConstructor) return databaseSyncConstructor;

  const emitWarning = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqliteExperimental(this: NodeJS.Process, ...args: unknown[]): void {
    if (args[0] === SQLITE_EXPERIMENTAL_WARNING && args[1] === "ExperimentalWarning") return;
    Reflect.apply(emitWarning, this, args);
  } as typeof process.emitWarning;
  try {
    databaseSyncConstructor = (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
    return databaseSyncConstructor;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
