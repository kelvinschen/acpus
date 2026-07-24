import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, ok, ResultAsync, type Result } from "neverthrow";

const manifestVersion = 1;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export type WorkspaceManifest = {
  manifestVersion: typeof manifestVersion;
  workspaceKey: string;
  canonicalPath: string;
  platform: NodeJS.Platform;
  filesystemIdentity?: string;
  createdAt: string;
};

export type RuntimeLayout = {
  canonicalPath: string;
  key: string;
  workspaceKey: string;
  platform: NodeJS.Platform;
  home: string;
  workspaceRoot: string;
  manifestPath: string;
  runtimeRoot: string;
  databasePath: string;
  runsRoot: string;
  sourcesRoot: string;
  trashRoot: string;
  archivesRoot: string;
  daemonSocketPath: string;
  daemonEndpoint: string;
  filesystemIdentity?: string;
};

export type WorkspaceManifestFailure =
  | {
    type: "manifest-invalid";
    path: string;
    message: string;
  }
  | {
    type: "manifest-mismatch";
    path: string;
    field: "workspaceKey" | "canonicalPath" | "platform" | "filesystemIdentity";
    expected: string;
    actual: string;
    message: string;
  };

export type RuntimeLayoutFailure =
  | WorkspaceManifestFailure
  | {
    type: "filesystem";
    operation: "resolve-workspace" | "create-directory" | "read-manifest" | "write-manifest" | "set-permissions";
    path: string;
    message: string;
  };

type WorkspaceStats = {
  dev: bigint | number;
  ino: bigint | number;
  birthtimeMs?: bigint | number;
  isDirectory(): boolean;
};

export type RuntimeLayoutDependencies = {
  homedir(): string;
  tmpdir(): string;
  platform: NodeJS.Platform;
  realpath(path: string): string;
  stat(path: string): WorkspaceStats;
  now(): Date;
};

const defaultDependencies: RuntimeLayoutDependencies = {
  homedir,
  tmpdir,
  platform: process.platform,
  realpath: realpathSync,
  stat: path => statSync(path, { bigint: true }),
  now: () => new Date(),
};

const runtimeHomeOverrides = new Map<string, Array<{ token: symbol; home: string }>>();

export function resolveRuntimeLayout(
  cwd: string,
  overrides: Partial<RuntimeLayoutDependencies> = {},
): RuntimeLayout {
  const dependencies = { ...defaultDependencies, ...overrides };
  const canonicalPath = dependencies.realpath(resolve(cwd));
  const stats = dependencies.stat(canonicalPath);
  if (!stats.isDirectory()) throw new Error(`Runtime workspace '${canonicalPath}' is not a directory.`);

  const key = workspaceKey(canonicalPath, dependencies.platform);
  const home = runtimeHomeOverrides.get(canonicalPath)?.at(-1)?.home
    ?? join(dependencies.homedir(), ".acpus");
  const workspaceRoot = join(home, "workspaces", key);
  const runtimeRoot = join(workspaceRoot, "runtime");
  const daemonSocketPath = join(workspaceRoot, "daemon.sock");
  const identity = filesystemIdentity(stats);
  return {
    canonicalPath,
    key,
    workspaceKey: key,
    platform: dependencies.platform,
    home,
    workspaceRoot,
    manifestPath: join(workspaceRoot, "workspace.json"),
    runtimeRoot,
    databasePath: join(runtimeRoot, "runtime.db"),
    runsRoot: join(runtimeRoot, "runs"),
    sourcesRoot: join(runtimeRoot, "sources"),
    trashRoot: join(runtimeRoot, "trash"),
    archivesRoot: join(workspaceRoot, "archives"),
    daemonSocketPath,
    daemonEndpoint: resolveDaemonEndpoint(daemonSocketPath, key, home, dependencies),
    ...(identity === undefined ? {} : { filesystemIdentity: identity }),
  };
}

export function runtimeLayoutFromManifest(
  home: string,
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  overrides: Pick<Partial<RuntimeLayoutDependencies>, "tmpdir"> = {},
): RuntimeLayout {
  const dependencies = { ...defaultDependencies, ...overrides, platform: manifest.platform };
  const key = workspaceKey(manifest.canonicalPath, manifest.platform);
  const runtimeRoot = join(workspaceRoot, "runtime");
  const daemonSocketPath = join(workspaceRoot, "daemon.sock");
  return {
    canonicalPath: manifest.canonicalPath,
    key,
    workspaceKey: key,
    platform: manifest.platform,
    home,
    workspaceRoot,
    manifestPath: join(workspaceRoot, "workspace.json"),
    runtimeRoot,
    databasePath: join(runtimeRoot, "runtime.db"),
    runsRoot: join(runtimeRoot, "runs"),
    sourcesRoot: join(runtimeRoot, "sources"),
    trashRoot: join(runtimeRoot, "trash"),
    archivesRoot: join(workspaceRoot, "archives"),
    daemonSocketPath,
    daemonEndpoint: resolveDaemonEndpoint(daemonSocketPath, key, home, dependencies),
    ...(manifest.filesystemIdentity === undefined ? {} : { filesystemIdentity: manifest.filesystemIdentity }),
  };
}

export function ensureRuntimeLayout(
  cwd: string,
  overrides: Partial<RuntimeLayoutDependencies> = {},
): ResultAsync<RuntimeLayout, RuntimeLayoutFailure> {
  return ResultAsync.fromPromise(
    ensureRuntimeLayoutValue(cwd, overrides),
    error => runtimeLayoutFailure(error, cwd),
  );
}

export async function validateRuntimeLayoutBoundary(layout: RuntimeLayout): Promise<void> {
  for (const [path, label] of [
    [layout.home, "Acpus home"],
    [join(layout.home, "workspaces"), "Runtime workspaces root"],
    [layout.workspaceRoot, "Runtime workspace shard"],
  ] as const) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} '${path}' is not a regular directory.`);
    }
  }
}

export function validateWorkspaceManifest(
  value: unknown,
  layout: RuntimeLayout,
): Result<WorkspaceManifest, WorkspaceManifestFailure> {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      "manifestVersion",
      "workspaceKey",
      "canonicalPath",
      "platform",
      "createdAt",
    ], ["filesystemIdentity"])
    || value.manifestVersion !== manifestVersion
    || typeof value.workspaceKey !== "string"
    || !/^[a-f0-9]{32}$/.test(value.workspaceKey)
    || typeof value.canonicalPath !== "string"
    || !isNodePlatform(value.platform)
    || (value.filesystemIdentity !== undefined && !isFilesystemIdentity(value.filesystemIdentity))
    || typeof value.createdAt !== "string"
    || !isCanonicalTimestamp(value.createdAt)) {
    return err({
      type: "manifest-invalid",
      path: layout.manifestPath,
      message: `Workspace manifest '${layout.manifestPath}' does not match the current format.`,
    });
  }

  const manifest = value as WorkspaceManifest;
  const mismatches: Array<{
    field: Extract<WorkspaceManifestFailure, { type: "manifest-mismatch" }>["field"];
    expected: string;
    actual: string;
  }> = [
    { field: "workspaceKey", expected: layout.key, actual: manifest.workspaceKey },
    { field: "canonicalPath", expected: layout.canonicalPath, actual: manifest.canonicalPath },
    { field: "platform", expected: layout.platform, actual: manifest.platform },
  ];
  const mismatch = mismatches.find(candidate => candidate.expected !== candidate.actual)
    ?? filesystemIdentityMismatch(manifest.filesystemIdentity, layout.filesystemIdentity);
  if (mismatch) {
    return err({
      type: "manifest-mismatch",
      path: layout.manifestPath,
      ...mismatch,
      message: `Workspace manifest '${layout.manifestPath}' has ${mismatch.field} '${mismatch.actual}', expected '${mismatch.expected}'.`,
    });
  }
  return ok(manifest);
}

/** Test-only workspace-scoped home override. It is deliberately absent from the package root. */
export function setRuntimeHomeForTest(workspace: string, home: string): () => void {
  const canonicalPath = realpathSync(resolve(workspace));
  const entry = { token: Symbol("runtime-home"), home: resolve(home) };
  const stack = runtimeHomeOverrides.get(canonicalPath) ?? [];
  stack.push(entry);
  runtimeHomeOverrides.set(canonicalPath, stack);
  return () => {
    const current = runtimeHomeOverrides.get(canonicalPath);
    if (!current) return;
    const index = current.findIndex(candidate => candidate.token === entry.token);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) runtimeHomeOverrides.delete(canonicalPath);
  };
}

async function ensureRuntimeLayoutValue(
  cwd: string,
  overrides: Partial<RuntimeLayoutDependencies>,
): Promise<RuntimeLayout> {
  let layout: RuntimeLayout;
  try {
    layout = resolveRuntimeLayout(cwd, overrides);
  } catch (error) {
    throw operationFailure("resolve-workspace", resolve(cwd), error);
  }

  for (const path of [layout.home, join(layout.home, "workspaces"), layout.workspaceRoot]) {
    await ensurePrivateDirectory(path, layout.platform);
  }
  await ensureWorkspaceManifest(layout, overrides);
  for (const path of [
    layout.runtimeRoot,
    layout.runsRoot,
    layout.sourcesRoot,
    layout.trashRoot,
    layout.archivesRoot,
  ]) {
    await ensurePrivateDirectory(path, layout.platform);
  }
  return layout;
}

async function ensureWorkspaceManifest(
  layout: RuntimeLayout,
  overrides: Partial<RuntimeLayoutDependencies>,
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const expected: WorkspaceManifest = {
    manifestVersion,
    workspaceKey: layout.key,
    canonicalPath: layout.canonicalPath,
    platform: layout.platform,
    ...(layout.filesystemIdentity === undefined ? {} : { filesystemIdentity: layout.filesystemIdentity }),
    createdAt: dependencies.now().toISOString(),
  };

  let value: unknown;
  try {
    await writeFile(layout.manifestPath, `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: privateFileMode,
    });
    value = expected;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw operationFailure("write-manifest", layout.manifestPath, error);
    try {
      const info = await lstat(layout.manifestPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("manifest path is not a regular file");
      }
    } catch (manifestError) {
      throw operationFailure("read-manifest", layout.manifestPath, manifestError);
    }
    let raw: string;
    try {
      raw = await readFile(layout.manifestPath, "utf8");
    } catch (readError) {
      throw operationFailure("read-manifest", layout.manifestPath, readError);
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw manifestFailure({
        type: "manifest-invalid",
        path: layout.manifestPath,
        message: `Workspace manifest '${layout.manifestPath}' is not valid JSON.`,
      });
    }
  }

  const validation = validateWorkspaceManifest(value, layout);
  if (validation.isErr()) throw manifestFailure(validation.error);
  if (layout.platform !== "win32") {
    try {
      await chmod(layout.manifestPath, privateFileMode);
    } catch (error) {
      throw operationFailure("set-permissions", layout.manifestPath, error);
    }
  }
}

async function ensurePrivateDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: privateDirectoryMode });
  } catch (error) {
    throw operationFailure("create-directory", path, error);
  }
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("path is not a regular directory");
    }
  } catch (error) {
    throw operationFailure("create-directory", path, error);
  }
  if (platform === "win32") return;
  try {
    await chmod(path, privateDirectoryMode);
  } catch (error) {
    throw operationFailure("set-permissions", path, error);
  }
}

function workspaceKey(canonicalPath: string, platform: NodeJS.Platform): string {
  return createHash("sha256")
    .update(`acpus-workspace-v1\0${platform}\0${canonicalPath}`)
    .digest("hex")
    .slice(0, 32);
}

function resolveDaemonEndpoint(
  daemonSocketPath: string,
  key: string,
  home: string,
  dependencies: RuntimeLayoutDependencies,
): string {
  const scope = createHash("sha256")
    .update(`acpus-daemon-home-v1\0${resolve(home)}`)
    .digest("hex")
    .slice(0, 32);
  const name = `acpus-daemon-${scope}-${key}`;
  if (dependencies.platform === "win32") return `\\\\.\\pipe\\${name}`;
  if (Buffer.byteLength(daemonSocketPath) < 100) return daemonSocketPath;
  if (dependencies.platform === "linux") return `\0${name}`;
  const temporaryEndpoint = join(dependencies.tmpdir(), `acpus-daemon-${scope}`, `${key}.sock`);
  return Buffer.byteLength(temporaryEndpoint) < 100
    ? temporaryEndpoint
    : join("/tmp", `acpus-daemon-${scope}`, `${key}.sock`);
}

function filesystemIdentity(stats: WorkspaceStats): string | undefined {
  const inode = String(stats.ino);
  if (inode === "0") return undefined;
  const birthtimeMs = stats.birthtimeMs === undefined ? undefined : String(stats.birthtimeMs);
  return `${String(stats.dev)}:${inode}${birthtimeMs === undefined || birthtimeMs === "0" ? "" : `:${birthtimeMs}`}`;
}

function filesystemIdentityMismatch(
  actual: string | undefined,
  expected: string | undefined,
): {
  field: "filesystemIdentity";
  expected: string;
  actual: string;
} | undefined {
  if (actual === undefined || expected === undefined) return undefined;
  const [actualDevice, actualInode, actualBirthtime] = actual.split(":");
  const [expectedDevice, expectedInode, expectedBirthtime] = expected.split(":");
  return actualDevice === expectedDevice
    && actualInode === expectedInode
    && (actualBirthtime === undefined || expectedBirthtime === undefined || actualBirthtime === expectedBirthtime)
    ? undefined
    : {
      field: "filesystemIdentity",
      expected,
      actual,
    };
}

function isFilesystemIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d+:[1-9]\d*(?::[1-9]\d*)?$/.test(value);
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === "string" && [
    "aix",
    "android",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
    "win32",
    "cygwin",
  ].includes(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

class RuntimeLayoutOperationError extends Error {
  constructor(readonly failure: RuntimeLayoutFailure) {
    super(failure.message);
  }
}

function operationFailure(
  operation: Extract<RuntimeLayoutFailure, { type: "filesystem" }>["operation"],
  path: string,
  error: unknown,
): RuntimeLayoutOperationError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeLayoutOperationError({
    type: "filesystem",
    operation,
    path,
    message: `Cannot ${operation.replaceAll("-", " ")} '${path}': ${detail}`,
  });
}

function manifestFailure(failure: WorkspaceManifestFailure): RuntimeLayoutOperationError {
  return new RuntimeLayoutOperationError(failure);
}

function runtimeLayoutFailure(error: unknown, cwd: string): RuntimeLayoutFailure {
  if (error instanceof RuntimeLayoutOperationError) return error.failure;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    type: "filesystem",
    operation: "resolve-workspace",
    path: resolve(cwd),
    message: `Cannot resolve workspace '${resolve(cwd)}': ${detail}`,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}
