import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  resolveRuntimeLayout,
  runtimeLayoutFromManifest,
  validateRuntimeLayoutBoundary,
  validateWorkspaceManifest,
  type AnyWorkspaceManifest,
  type RuntimeLayout,
} from "./runtime-layout.js";

export type DiscoveredWorkspaceShard = {
  layout: RuntimeLayout;
  manifest: AnyWorkspaceManifest;
};

export type WorkspaceShardDiscovery =
  | DiscoveredWorkspaceShard
  | { failure: { workspaceKey: string; message: string } };

export async function discoverWorkspaceShards(home: string): Promise<WorkspaceShardDiscovery[]> {
  const root = join(home, "workspaces");
  let entries;
  try {
    await assertOwnedDirectory(home, "Acpus home");
    entries = await readOwnedDirectory(root, "Workspace shards root");
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }

  const shards: WorkspaceShardDiscovery[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const shard = await inspectWorkspaceShardEntry(home, root, entry);
    if (shard) shards.push(shard);
  }
  return shards;
}

export async function readWorkspaceShardByKey(
  home: string,
  workspaceKey: string,
): Promise<WorkspaceShardDiscovery | undefined> {
  if (!isWorkspaceKey(workspaceKey)) throw new Error(`Workspace key '${workspaceKey}' is invalid.`);
  const root = join(home, "workspaces");
  try {
    await assertOwnedDirectory(home, "Acpus home");
    await assertOwnedDirectory(root, "Workspace shards root");
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  let info;
  try {
    info = await lstat(join(root, workspaceKey));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  return inspectWorkspaceShardEntry(home, root, {
    name: workspaceKey,
    isSymbolicLink: () => info.isSymbolicLink(),
    isDirectory: () => info.isDirectory(),
  });
}

export async function resolveAvailableWorkspaceLayout(
  shard: DiscoveredWorkspaceShard,
): Promise<RuntimeLayout> {
  let current: RuntimeLayout;
  try {
    current = resolveRuntimeLayout(shard.manifest.canonicalPath);
  } catch (error) {
    throw new Error(
      `Workspace '${shard.layout.workspaceKey}' is unavailable: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (current.home !== shard.layout.home
    || current.workspaceRoot !== shard.layout.workspaceRoot) {
    throw new Error(`Workspace '${shard.layout.workspaceKey}' no longer belongs to this Acpus home.`);
  }
  const validation = validateWorkspaceManifest(shard.manifest, current);
  if (validation.isErr()) throw new Error(validation.error.message);
  await validateRuntimeLayoutBoundary(current);
  return current;
}

export function isWorkspaceKey(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

async function inspectWorkspaceShardEntry(
  home: string,
  root: string,
  entry: {
    name: string;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
  },
): Promise<WorkspaceShardDiscovery | undefined> {
  const workspaceRoot = join(root, entry.name);
  if (entry.isSymbolicLink()) {
    return {
      failure: {
        workspaceKey: entry.name,
        message: `Workspace shard '${workspaceRoot}' is a symbolic link.`,
      },
    };
  }
  if (!entry.isDirectory()) {
    return isWorkspaceKey(entry.name)
      ? {
        failure: {
          workspaceKey: entry.name,
          message: `Workspace shard '${workspaceRoot}' is not a regular directory.`,
        },
      }
      : undefined;
  }
  try {
    return await readWorkspaceShard(home, workspaceRoot);
  } catch (error) {
    return {
      failure: {
        workspaceKey: entry.name,
        message: errorMessage(error),
      },
    };
  }
}

async function readWorkspaceShard(
  home: string,
  workspaceRoot: string,
): Promise<DiscoveredWorkspaceShard> {
  const manifestPath = join(workspaceRoot, "workspace.json");
  const info = await lstat(manifestPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Workspace manifest '${manifestPath}' is not a regular file.`);
  }
  const manifest = parseWorkspaceManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const layout = runtimeLayoutFromManifest(home, workspaceRoot, manifest);
  const validated = validateWorkspaceManifest(manifest, layout);
  if (validated.isErr()) throw new Error(validated.error.message);
  if (basename(workspaceRoot) !== layout.workspaceKey) {
    throw new Error(`Workspace shard '${workspaceRoot}' does not match manifest key '${layout.workspaceKey}'.`);
  }
  return { layout, manifest };
}

function parseWorkspaceManifest(value: unknown): AnyWorkspaceManifest {
  if (!isRecord(value)
    || (value.manifestVersion !== 1 && value.manifestVersion !== 2)
    || typeof value.workspaceKey !== "string"
    || !isWorkspaceKey(value.workspaceKey)
    || typeof value.canonicalPath !== "string"
    || !isNodePlatform(value.platform)
    || typeof value.createdAt !== "string"
    || (value.filesystemIdentity !== undefined && typeof value.filesystemIdentity !== "string")) {
    throw new Error("Workspace manifest does not match a supported layout version.");
  }
  return value as AnyWorkspaceManifest;
}

async function readOwnedDirectory(root: string, label: string) {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${root}' is not a regular directory.`);
  }
  return readdir(root, { withFileTypes: true });
}

async function assertOwnedDirectory(root: string, label: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${root}' is not a regular directory.`);
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
