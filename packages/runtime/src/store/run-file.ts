import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  captureDirectoryIdentity,
  verifyDirectoryIdentity,
  verifyRunDirectoryToken,
  type DirectoryIdentity,
  type RunDirectoryToken,
} from "./path-fence.js";

export type RunFileToken = {
  readonly path: string;
  readonly filesystemIdentity: string;
};

export type RunFileUnavailable =
  | {
      readonly type: "run-file-unavailable";
      readonly reason: "missing";
      readonly cause: NodeJS.ErrnoException;
    }
  | {
      readonly type: "run-file-unavailable";
      readonly reason: "symbolic-link" | "not-regular";
    };

type PreparedRunFilePath = {
  readonly path: string;
  readonly parent: DirectoryIdentity;
  readonly run: RunDirectoryToken;
  readonly label: string;
};

export async function writeRunFile(input: {
  run: RunDirectoryToken;
  relativePath: string;
  bytes: Uint8Array;
  label: string;
}): Promise<RunFileToken> {
  let prepared: PreparedRunFilePath | undefined;
  let file: RunFileToken | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  try {
    prepared = await prepareRunFilePath(input.run, input.relativePath, input.label);

    verifyPreparedRunFilePath(prepared);
    handle = await open(prepared.path, "wx", 0o600);
    let info = await handle.stat({ bigint: true });
    assertRegularFile(info, input.label);
    file = tokenForFile(prepared.path, info, input.label);

    verifyPreparedRunFilePath(prepared);
    await handle.writeFile(input.bytes);
    await handle.sync();
    info = await handle.stat({ bigint: true });
    assertRegularFile(info, input.label);
    if (info.size !== BigInt(input.bytes.byteLength)) {
      throw new Error(`${input.label} '${prepared.path}' has an unexpected size after writing.`);
    }
    assertRunFileIdentity(file, info, input.label);
    verifyPreparedRunFilePath(prepared);
    verifyRunFile(input.run, file, input.label);
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure = failure === undefined
      ? error
      : new AggregateError([failure, error], `${input.label} write and file close both failed.`);
  }
  if (failure !== undefined) {
    if (file && canRemoveRunFile(input.run, file, input.label)) {
      try {
        await removeRunFile(input.run, file, input.label);
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `${input.label} write failed and its partial file could not be removed: ${errorMessage(failure)}`,
        );
      }
    }
    throw failure;
  }
  if (!file) throw new Error(`${input.label} write completed without an opened file identity.`);
  return file;
}

async function prepareRunFilePath(
  run: RunDirectoryToken,
  relativePath: string,
  label: string,
): Promise<PreparedRunFilePath> {
  const path = runFilePath(run, relativePath);
  const parent = await materializeRunFileParent(run, path, label);
  const prepared = { path, parent, run, label };
  verifyPreparedRunFilePath(prepared);
  return prepared;
}

function verifyPreparedRunFilePath(prepared: PreparedRunFilePath): string {
  const path = ownedRunPath(prepared.run, prepared.path, prepared.label);
  verifyDirectoryIdentity(prepared.parent, `${prepared.label} parent directory`);
  verifyRunDirectoryToken(prepared.run);
  if (dirname(path) !== prepared.parent.path
    || !isRealContained(prepared.run.runDirectory.realpath, prepared.parent.realpath)) {
    throw new Error(`${prepared.label} parent directory '${prepared.parent.path}' is outside its run directory.`);
  }
  return path;
}

export function tryCaptureRunFile(
  run: RunDirectoryToken,
  path: string,
  label: string,
): Result<RunFileToken, RunFileUnavailable> {
  const absolute = resolve(path);
  assertLexicallyContained(run.runDirectory.path, absolute, label);
  verifyRunDirectoryToken(run);
  let info: BigIntStats;
  try {
    info = lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (!isUnavailablePath(error)) throw error;
    return err({ type: "run-file-unavailable", reason: "missing", cause: error });
  }
  if (info.isSymbolicLink()) {
    return err({ type: "run-file-unavailable", reason: "symbolic-link" });
  }
  if (!info.isFile()) {
    return err({ type: "run-file-unavailable", reason: "not-regular" });
  }
  const token = tokenForFile(absolute, info, label);
  verifyRunFile(run, token, label);
  return ok(token);
}

export function verifyRunFile(
  run: RunDirectoryToken,
  file: RunFileToken,
  label: string,
): string {
  verifyRunDirectoryToken(run);
  const absolute = ownedRunPath(run, file.path, label);
  const info = lstatSync(absolute, { bigint: true });
  assertRegularFile(info, label);
  assertRunFileIdentity(file, info, label);
  assertRealContained(run.runDirectory.realpath, realpathSync(absolute), label);
  return absolute;
}

export async function removeRunFile(
  run: RunDirectoryToken,
  file: RunFileToken,
  label: string,
): Promise<void> {
  let path: string;
  try {
    path = verifyRunFile(run, file, label);
  } catch (error) {
    if (isMissing(error)) {
      verifyRunDirectoryToken(run);
      return;
    }
    throw error;
  }
  const parent = captureRunFileParent(run, file.path, label);
  path = verifyRunFile(run, file, label);
  verifyDirectoryIdentity(parent, `${label} parent directory`);
  await rm(path);
  verifyDirectoryIdentity(parent, `${label} parent directory`);
  verifyRunDirectoryToken(run);
}

function runFilePath(run: RunDirectoryToken, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Run file path '${relativePath}' must be relative to its run directory.`);
  }
  const path = resolve(run.runDirectory.path, relativePath);
  assertLexicallyContained(run.runDirectory.path, path, "Run file");
  return path;
}

function ownedRunPath(run: RunDirectoryToken, path: string, label: string): string {
  const absolute = resolve(path);
  assertLexicallyContained(run.runDirectory.path, absolute, label);
  return absolute;
}

function captureRunFileParent(
  run: RunDirectoryToken,
  path: string,
  label: string,
): DirectoryIdentity {
  const parent = captureDirectoryIdentity(dirname(ownedRunPath(run, path, label)), `${label} parent directory`);
  if (!isRealContained(run.runDirectory.realpath, parent.realpath)) {
    throw new Error(`${label} parent directory '${parent.path}' resolves outside its run directory.`);
  }
  verifyRunDirectoryToken(run);
  return parent;
}

async function materializeRunFileParent(
  run: RunDirectoryToken,
  path: string,
  label: string,
): Promise<DirectoryIdentity> {
  const parentPath = dirname(path);
  const parentRelativePath = relative(run.runDirectory.path, parentPath);
  assertLexicallyContained(run.runDirectory.path, parentPath, `${label} parent directory`);
  let current = verifyDirectoryIdentity(run.runDirectory, `Run directory '${run.runId}'`);
  if (parentRelativePath === "") return current;

  for (const segment of parentRelativePath.split(sep)) {
    const candidate = resolve(current.path, segment);
    let next: DirectoryIdentity;
    try {
      next = captureRunDirectory(candidate, `${label} parent directory`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      verifyDirectoryIdentity(current, `${label} parent directory`);
      verifyRunDirectoryToken(run);
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      verifyDirectoryIdentity(current, `${label} parent directory`);
      verifyRunDirectoryToken(run);
      next = captureRunDirectory(candidate, `${label} parent directory`);
    }
    if (dirname(next.path) !== current.path || dirname(next.realpath) !== current.realpath) {
      throw new Error(`${label} parent directory '${candidate}' resolves outside its opened parent.`);
    }
    verifyDirectoryIdentity(current, `${label} parent directory`);
    verifyDirectoryIdentity(next, `${label} parent directory`);
    verifyRunDirectoryToken(run);
    current = next;
  }

  return current;
}

function captureRunDirectory(path: string, label: string): DirectoryIdentity {
  try {
    return captureDirectoryIdentity(path, label);
  } catch (error) {
    const info = isMissing(error) ? undefined : lstatSync(path, { bigint: true });
    if (info && !info.isSymbolicLink() && !info.isDirectory() && error && typeof error === "object") {
      Object.assign(error, { code: "ENOTDIR" });
    }
    throw error;
  }
}

function assertLexicallyContained(root: string, path: string, label: string): void {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} path '${path}' is outside run directory '${root}'.`);
  }
}

function assertRealContained(root: string, path: string, label: string): void {
  if (!isRealChild(root, path)) {
    throw new Error(`${label} path '${path}' resolves outside run directory '${root}'.`);
  }
}

function isRealChild(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isRealContained(root: string, path: string): boolean {
  return resolve(root) === resolve(path) || isRealChild(root, path);
}

function tokenForFile(path: string, info: BigIntStats, label: string): RunFileToken {
  return { path, filesystemIdentity: fileIdentity(info, label) };
}

function assertRegularFile(info: BigIntStats, label: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
}

export function assertRunFileIdentity(expected: RunFileToken, info: BigIntStats, label: string): void {
  if (fileIdentity(info, label) !== expected.filesystemIdentity) {
    throw new Error(`${label} '${expected.path}' no longer matches its opened identity.`);
  }
}

function fileIdentity(info: BigIntStats, label: string): string {
  if (info.ino === 0n) {
    throw new Error(`${label} does not expose a stable filesystem identity.`);
  }
  return `${String(info.dev)}:${String(info.ino)}${info.birthtimeMs === 0n ? "" : `:${String(info.birthtimeMs)}`}`;
}

function canRemoveRunFile(
  run: RunDirectoryToken,
  file: RunFileToken,
  label: string,
): boolean {
  try {
    verifyRunFile(run, file, label);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function isUnavailablePath(error: unknown): error is NodeJS.ErrnoException {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST");
}
