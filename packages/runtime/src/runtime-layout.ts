import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { RUNTIME_STORAGE_VERSION } from "./storage/database.js";
import { writeGenerationMetadata } from "./storage/generation-metadata.js";
import { writePrivateJsonAtomically } from "./storage/private-json.js";

export const RUNTIME_LAYOUT_VERSION = 2;

type LegacyWorkspaceManifest = {
  manifestVersion: 1;
  workspaceKey: string;
  canonicalPath: string;
  platform: NodeJS.Platform;
  createdAt: string;
  filesystemIdentity?: string;
};

export type WorkspaceManifest = {
  manifestVersion: typeof RUNTIME_LAYOUT_VERSION;
  workspaceKey: string;
  canonicalPath: string;
  platform: NodeJS.Platform;
  createdAt: string;
  activeGenerationId: string;
};

export type AnyWorkspaceManifest = LegacyWorkspaceManifest | WorkspaceManifest;

export type RuntimeLayout = {
  layoutVersion: 1 | typeof RUNTIME_LAYOUT_VERSION;
  canonicalPath: string;
  key: string;
  workspaceKey: string;
  platform: NodeJS.Platform;
  home: string;
  workspaceRoot: string;
  manifestPath: string;
  generationsRoot: string;
  transitionJournalPath: string;
  legacyRuntimeRoot: string;
  legacyArchivesRoot: string;
  generationId?: string;
  generationRoot?: string;
  generationMetadataPath: string;
  runIndexPath: string;
  runtimeRoot: string;
  databasePath: string;
  runsRoot: string;
  sourcesRoot: string;
  trashRoot: string;
  acpRoot: string;
  acpWorkersRoot: string;
  daemonSocketPath: string;
  daemonEndpoint: string;
};

export type WorkspaceManifestFailure =
  | { type: "manifest-invalid"; path: string; message: string }
  | {
      type: "manifest-mismatch";
      path: string;
      field: "workspaceKey" | "canonicalPath" | "platform";
      expected: string;
      actual: string;
      message: string;
    };

export type RuntimeLayoutFailure =
  | WorkspaceManifestFailure
  | {
      type: "layout-update-required";
      path: string;
      observedLayoutVersion: 1;
      targetLayoutVersion: typeof RUNTIME_LAYOUT_VERSION;
      message: string;
    }
  | { type: "generation-invalid"; path: string; message: string }
  | {
      type: "filesystem";
      operation: "resolve-workspace" | "create-directory" | "read-manifest" | "write-manifest" | "set-permissions";
      path: string;
      message: string;
    };

type WorkspaceStats = { isDirectory(): boolean };

export type RuntimeLayoutDependencies = {
  homedir(): string;
  tmpdir(): string;
  platform: NodeJS.Platform;
  realpath(path: string): string;
  stat(path: string): WorkspaceStats;
  now(): Date;
};

export type RuntimeLayoutOptions = Partial<RuntimeLayoutDependencies> & {
  runtimeHome?: string;
};

const defaultDependencies: RuntimeLayoutDependencies = {
  homedir,
  tmpdir,
  platform: process.platform,
  realpath: realpathSync,
  stat: path => statSync(path),
  now: () => new Date(),
};

const runtimeHomeOverrides = new Map<string, Array<{ token: symbol; home: string }>>();
const privateDirectoryMode = 0o700;

export function resolveRuntimeLayout(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): RuntimeLayout {
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  return resolveRuntimeLayoutAtWorkspace(workspace);
}

export function resolveRuntimeLayoutAtWorkspace(workspace: RuntimeLayout): RuntimeLayout {
  const manifest = readWorkspaceManifestSync(workspace.manifestPath);
  return manifest?.manifestVersion === RUNTIME_LAYOUT_VERSION
    ? runtimeLayoutForGeneration(workspace, manifest.activeGenerationId)
    : workspace;
}

export function resolveRuntimeWorkspaceLayout(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): RuntimeLayout {
  const { runtimeHome, ...overrides } = options;
  const dependencies = { ...defaultDependencies, ...overrides };
  const canonicalPath = dependencies.realpath(resolve(cwd));
  const stats = dependencies.stat(canonicalPath);
  if (!stats.isDirectory()) throw new Error(`Runtime workspace '${canonicalPath}' is not a directory.`);
  const key = workspaceKey(canonicalPath, dependencies.platform);
  const home = runtimeHome === undefined
    ? runtimeHomeOverrides.get(canonicalPath)?.at(-1)?.home ?? join(dependencies.homedir(), ".acpus")
    : resolve(runtimeHome);
  return workspaceLayout({
    canonicalPath,
    key,
    workspaceKey: key,
    platform: dependencies.platform,
    home,
    workspaceRoot: join(home, "workspaces", key),
  }, dependencies);
}

export function runtimeLayoutFromManifest(
  home: string,
  workspaceRoot: string,
  manifest: AnyWorkspaceManifest,
  overrides: Pick<Partial<RuntimeLayoutDependencies>, "tmpdir"> = {},
): RuntimeLayout {
  const dependencies = { ...defaultDependencies, ...overrides, platform: manifest.platform };
  const key = workspaceKey(manifest.canonicalPath, manifest.platform);
  const workspace = workspaceLayout({
    canonicalPath: manifest.canonicalPath,
    key,
    workspaceKey: key,
    platform: manifest.platform,
    home,
    workspaceRoot,
  }, dependencies);
  return manifest.manifestVersion === RUNTIME_LAYOUT_VERSION
    ? runtimeLayoutForGeneration(workspace, manifest.activeGenerationId)
    : workspace;
}

export function runtimeLayoutForGeneration(layout: RuntimeLayout, generationId: string): RuntimeLayout {
  if (!isGenerationId(generationId)) throw new Error(`Runtime generation id '${generationId}' is invalid.`);
  const generationRoot = join(layout.generationsRoot, generationId);
  const runtimeRoot = join(generationRoot, "store");
  return {
    ...layout,
    layoutVersion: RUNTIME_LAYOUT_VERSION,
    generationId,
    generationRoot,
    generationMetadataPath: join(generationRoot, "generation.json"),
    runIndexPath: join(generationRoot, "run-index.json"),
    ...storePaths(runtimeRoot),
  };
}

export function isGenerationId(value: string): boolean {
  return /^gen_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function ensureRuntimeLayout(
  cwd: string,
  options: RuntimeLayoutOptions = {},
): Effect.Effect<RuntimeLayout, RuntimeLayoutFailure> {
  return Effect.tryPromise({
    try: () => ensureRuntimeLayoutValue(cwd, options),
    catch: error => runtimeLayoutFailure(error, cwd),
  });
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
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} '${path}' is not a regular directory.`);
  }
}

export function validateWorkspaceManifest(
  value: unknown,
  layout: RuntimeLayout,
): Result.Result<AnyWorkspaceManifest, WorkspaceManifestFailure> {
  if (!isWorkspaceManifest(value)) {
    return Result.fail({
      type: "manifest-invalid",
      path: layout.manifestPath,
      message: `Workspace manifest '${layout.manifestPath}' does not match the current format.`,
    });
  }
  const manifest = value as unknown as AnyWorkspaceManifest;
  const mismatch = [
    { field: "workspaceKey" as const, expected: layout.key, actual: manifest.workspaceKey },
    { field: "canonicalPath" as const, expected: layout.canonicalPath, actual: manifest.canonicalPath },
    { field: "platform" as const, expected: layout.platform, actual: manifest.platform },
  ].find(candidate => candidate.expected !== candidate.actual);
  return mismatch
    ? Result.fail({
      type: "manifest-mismatch",
      path: layout.manifestPath,
      ...mismatch,
      message: `Workspace manifest '${layout.manifestPath}' has ${mismatch.field} '${mismatch.actual}', expected '${mismatch.expected}'.`,
    })
    : Result.succeed(manifest);
}

export function isWorkspaceManifest(value: unknown): value is AnyWorkspaceManifest {
  return isPlainRecord(value)
    && (value.manifestVersion === 1 || value.manifestVersion === RUNTIME_LAYOUT_VERSION)
    && typeof value.workspaceKey === "string"
    && /^[a-f0-9]{32}$/.test(value.workspaceKey)
    && typeof value.canonicalPath === "string"
    && isNodePlatform(value.platform)
    && isCanonicalTimestamp(value.createdAt)
    && (value.manifestVersion === RUNTIME_LAYOUT_VERSION
      ? hasExactKeys(value, ["manifestVersion", "workspaceKey", "canonicalPath", "platform", "createdAt", "activeGenerationId"])
        && typeof value.activeGenerationId === "string"
        && isGenerationId(value.activeGenerationId)
      : hasExactKeys(value, ["manifestVersion", "workspaceKey", "canonicalPath", "platform", "createdAt"], ["filesystemIdentity"])
        && (value.filesystemIdentity === undefined || typeof value.filesystemIdentity === "string"));
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

export function runAcpStateRoot(layout: RuntimeLayout, runId: string): string {
  return join(layout.runsRoot, runId, "acp");
}

export async function ensureRuntimeLayoutValue(
  cwd: string,
  options: RuntimeLayoutOptions,
): Promise<RuntimeLayout> {
  const { runtimeHome: _runtimeHome, ...overrides } = options;
  let workspace: RuntimeLayout;
  try {
    workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  } catch (error) {
    throw operationFailure("resolve-workspace", resolve(cwd), error);
  }
  return ensureRuntimeLayoutAtWorkspaceWithDependencies(workspace, { ...defaultDependencies, ...overrides });
}

export async function ensureRuntimeLayoutAtWorkspaceValue(
  workspace: RuntimeLayout,
  options: RuntimeLayoutOptions = {},
): Promise<RuntimeLayout> {
  const { runtimeHome: _runtimeHome, ...overrides } = options;
  return ensureRuntimeLayoutAtWorkspaceWithDependencies(workspace, { ...defaultDependencies, ...overrides });
}

async function ensureRuntimeLayoutAtWorkspaceWithDependencies(
  workspace: RuntimeLayout,
  dependencies: RuntimeLayoutDependencies,
): Promise<RuntimeLayout> {
  for (const path of [workspace.home, join(workspace.home, "workspaces"), workspace.workspaceRoot]) {
    await ensurePrivateDirectory(path, workspace.platform);
  }
  const read = await readWorkspaceManifest(workspace.manifestPath);
  let layout: RuntimeLayout;
  if (read === undefined) {
    layout = await initializeFreshLayout(workspace, dependencies);
  } else {
    const validated = validateWorkspaceManifest(read, workspace);
    if (Result.isFailure(validated)) throw manifestFailure(validated.failure);
    if (validated.success.manifestVersion === 1) {
      throw layoutFailure({
        type: "layout-update-required",
        path: workspace.manifestPath,
        observedLayoutVersion: 1,
        targetLayoutVersion: RUNTIME_LAYOUT_VERSION,
        message: `Runtime store layout v1 requires repair to layout v${RUNTIME_LAYOUT_VERSION}.`,
      });
    }
    layout = runtimeLayoutForGeneration(workspace, validated.success.activeGenerationId);
  }
  await ensureGenerationDirectories(layout);
  return layout;
}

async function initializeFreshLayout(
  workspace: RuntimeLayout,
  dependencies: RuntimeLayoutDependencies,
): Promise<RuntimeLayout> {
  await ensurePrivateDirectory(workspace.generationsRoot, workspace.platform);
  const generationId = `gen_${randomUUID()}`;
  const layout = runtimeLayoutForGeneration(workspace, generationId);
  await ensureGenerationDirectories(layout);
  await writeGenerationMetadata(layout.generationMetadataPath, {
    schemaVersion: 1,
    id: generationId,
    storageVersion: RUNTIME_STORAGE_VERSION,
    createdAt: dependencies.now().toISOString(),
  });
  await writeManifestAtomically(workspace.manifestPath, {
    manifestVersion: RUNTIME_LAYOUT_VERSION,
    workspaceKey: workspace.workspaceKey,
    canonicalPath: workspace.canonicalPath,
    platform: workspace.platform,
    createdAt: dependencies.now().toISOString(),
    activeGenerationId: generationId,
  });
  return layout;
}

async function ensureGenerationDirectories(layout: RuntimeLayout): Promise<void> {
  if (!layout.generationRoot) throw new Error("Runtime generation root is unavailable.");
  for (const path of [
    layout.generationRoot,
    layout.runtimeRoot,
    layout.runsRoot,
    layout.sourcesRoot,
    layout.trashRoot,
    layout.acpRoot,
    layout.acpWorkersRoot,
  ]) await ensurePrivateDirectory(path, layout.platform);
}

async function ensurePrivateDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: privateDirectoryMode });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("path is not a regular directory");
    if (platform !== "win32") await chmod(path, privateDirectoryMode);
  } catch (error) {
    throw operationFailure("create-directory", path, error);
  }
}

function workspaceLayout(
  base: Pick<RuntimeLayout, "canonicalPath" | "key" | "workspaceKey" | "platform" | "home" | "workspaceRoot">,
  dependencies: RuntimeLayoutDependencies,
): RuntimeLayout {
  const daemonSocketPath = join(base.workspaceRoot, "daemon.sock");
  const legacyRuntimeRoot = join(base.workspaceRoot, "runtime");
  return {
    ...base,
    layoutVersion: 1,
    manifestPath: join(base.workspaceRoot, "workspace.json"),
    generationsRoot: join(base.workspaceRoot, "generations"),
    transitionJournalPath: join(base.workspaceRoot, "runtime-store-transition.json"),
    legacyRuntimeRoot,
    legacyArchivesRoot: join(base.workspaceRoot, "archives"),
    generationMetadataPath: join(base.workspaceRoot, "generation.json"),
    runIndexPath: join(base.workspaceRoot, "run-index.json"),
    ...storePaths(legacyRuntimeRoot),
    daemonSocketPath,
    daemonEndpoint: resolveDaemonEndpoint(daemonSocketPath, base.key, base.home, dependencies),
  };
}

function storePaths(runtimeRoot: string) {
  return {
    runtimeRoot,
    databasePath: join(runtimeRoot, "runtime.db"),
    runsRoot: join(runtimeRoot, "runs"),
    sourcesRoot: join(runtimeRoot, "sources"),
    trashRoot: join(runtimeRoot, "trash"),
    acpRoot: join(runtimeRoot, "acp"),
    acpWorkersRoot: join(runtimeRoot, "acp", "workers"),
  };
}

function readWorkspaceManifestSync(path: string): AnyWorkspaceManifest | undefined {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Workspace manifest '${path}' is not a regular file.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Workspace manifest '${path}' is not valid JSON.`);
  }
  if (!isWorkspaceManifest(value)) {
    throw new Error(`Workspace manifest '${path}' does not match a supported layout.`);
  }
  return value;
}

async function readWorkspaceManifest(path: string): Promise<unknown | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw operationFailure("read-manifest", path, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw operationFailure("read-manifest", path, new Error("manifest path is not a regular file"));
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw manifestFailure({ type: "manifest-invalid", path, message: `Workspace manifest '${path}' is not valid JSON.` });
  }
}

async function writeManifestAtomically(path: string, manifest: WorkspaceManifest): Promise<void> {
  try {
    await writePrivateJsonAtomically(path, manifest);
  } catch (error) {
    throw operationFailure("write-manifest", path, error);
  }
}

function workspaceKey(canonicalPath: string, platform: NodeJS.Platform): string {
  return createHash("sha256").update(`acpus-workspace-v1\0${platform}\0${canonicalPath}`).digest("hex").slice(0, 32);
}

function resolveDaemonEndpoint(
  daemonSocketPath: string,
  key: string,
  home: string,
  dependencies: RuntimeLayoutDependencies,
): string {
  const scope = createHash("sha256").update(`acpus-daemon-home-v1\0${resolve(home)}`).digest("hex").slice(0, 32);
  const name = `acpus-daemon-${scope}-${key}`;
  if (dependencies.platform === "win32") return `\\\\.\\pipe\\${name}`;
  if (Buffer.byteLength(daemonSocketPath) < 100) return daemonSocketPath;
  if (dependencies.platform === "linux") return `\0${name}`;
  const temporaryEndpoint = join(dependencies.tmpdir(), `acpus-daemon-${scope}`, `${key}.sock`);
  return Buffer.byteLength(temporaryEndpoint) < 100 ? temporaryEndpoint : join("/tmp", `acpus-daemon-${scope}`, `${key}.sock`);
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === "string" && [
    "aix", "android", "darwin", "freebsd", "haiku", "linux", "netbsd", "openbsd", "sunos", "win32", "cygwin",
  ].includes(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
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
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
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

function layoutFailure(failure: RuntimeLayoutFailure): RuntimeLayoutOperationError {
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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
