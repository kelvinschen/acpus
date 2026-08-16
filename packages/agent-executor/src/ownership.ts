import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  matchesProcessStartToken,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  stopProcessTree,
} from "./process-tree.js";
import { normalizeAcpExecutorOwner } from "./owner.js";
import type { AcpOwnershipHealth, AcpOwnershipManifest, ManagedAcpExecutorOptions } from "./types.js";

const MANIFEST_MODE = 0o600;

type AcpOwnershipInspectionInput = {
  workersRoot: string;
  owner?: { generation: string | number; pid?: number; startToken?: string };
};

type OwnershipManifestFile = {
  path: string;
  manifest: AcpOwnershipManifest;
};

/** Reads residual ownership evidence without creating, changing, or signalling anything. */
export async function inspectAcpOwnership(input: AcpOwnershipInspectionInput): Promise<AcpOwnershipHealth> {
  const manifests = await readOwnershipManifests(input.workersRoot);
  const current = input.owner === undefined ? undefined : await normalizeAcpExecutorOwner(input.owner);
  let degraded = 0;
  let orphaned = 0;
  const records: AcpOwnershipHealth["manifests"] = [];
  for (const manifest of manifests) {
    if (manifest.state === "degraded") {
      degraded += 1;
      records.push(manifestReference(manifest));
      continue;
    }
    const belongsToCurrentOwner = current !== undefined
      && manifest.owner.pid === current.pid
      && manifest.owner.generation === current.generation
      && (current.startToken === undefined || manifest.owner.startToken === current.startToken);
    const workerLiveness = await matchesProcessStartToken(manifest.worker.pid, manifest.worker.startToken);
    if (!belongsToCurrentOwner || workerLiveness === false) {
      orphaned += 1;
      records.push(manifestReference(manifest));
    }
  }
  return { degraded, orphaned, manifests: records.slice(0, 12) };
}

/** Performs the single bounded startup sweep for the supplied workers root. */
export async function recoverAcpOwnership(input: ManagedAcpExecutorOptions): Promise<void> {
  const manifests = await readOwnershipManifestFiles(input.workersRoot);
  const deadline = performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS;
  for (const entry of manifests) {
    await recoverManifest(input, entry, deadline).catch(() => {});
  }
}

export async function writeAcpOwnershipManifest(
  path: string,
  manifest: AcpOwnershipManifest,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: MANIFEST_MODE });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function finishAcpOwnership(
  options: ManagedAcpExecutorOptions,
  path: string,
  manifest: AcpOwnershipManifest,
  treeAlive: boolean,
  reason: string,
): Promise<void> {
  if (!treeAlive) {
    await removeManifest(path);
    return;
  }
  const degraded = withCleanup(manifest, reason);
  await writeAcpOwnershipManifest(path, degraded).catch(() => {});
  try {
    options.onDegraded?.(degraded);
  } catch {
    // Degraded ownership reporting must not replace cleanup settlement.
  }
}

async function recoverManifest(
  input: ManagedAcpExecutorOptions,
  entry: OwnershipManifestFile,
  deadline: number,
): Promise<void> {
  const { manifest, path } = entry;
  const liveness = await matchesProcessStartToken(manifest.worker.pid, manifest.worker.startToken);
  if (liveness === false) {
    await removeManifest(path);
    return;
  }
  if (liveness !== true || performance.now() >= deadline) return;
  const alive = await stopProcessTree(manifest.worker.pid, deadline);
  await finishAcpOwnership(input, path, manifest, alive, "startup recovery");
}

async function readOwnershipManifests(workersRoot: string): Promise<AcpOwnershipManifest[]> {
  return (await readOwnershipManifestFiles(workersRoot)).map(entry => entry.manifest);
}

async function readOwnershipManifestFiles(workersRoot: string): Promise<OwnershipManifestFile[]> {
  let names: string[];
  try {
    names = await readdir(workersRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    return [];
  }
  const files = names.filter(name => /^acp_worker_[0-9a-f-]+\.json$/u.test(name)).sort();
  const parsed = await Promise.all(files.map(async name => {
    const path = join(workersRoot, name);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      return validManifest(value) ? { path, manifest: value } : undefined;
    } catch {
      return undefined;
    }
  }));
  return parsed.filter((entry): entry is OwnershipManifestFile => entry !== undefined);
}

async function removeManifest(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (!isMissing(error)) throw error;
  });
}

function validManifest(value: unknown): value is AcpOwnershipManifest {
  if (!record(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.schemaVersion === 2
    && typeof manifest.workerId === "string"
    && typeof manifest.runId === "string"
    && typeof manifest.attemptId === "string"
    && typeof manifest.sessionName === "string"
    && ownerIdentity(manifest.owner)
    && workerIdentity(manifest.worker)
    && (manifest.state === "active" || manifest.state === "degraded");
}

function ownerIdentity(value: unknown): value is { pid: number; startToken?: string; generation: string } {
  if (!record(value) || !positiveProcessId(value.pid)) return false;
  return typeof value.generation === "string"
    && (value.startToken === undefined || typeof value.startToken === "string");
}

function workerIdentity(value: unknown): value is { pid: number; startToken?: string; pgid?: number } {
  if (!record(value) || !positiveProcessId(value.pid)) return false;
  return (value.startToken === undefined || typeof value.startToken === "string")
    && (value.pgid === undefined || positiveProcessId(value.pgid));
}

function positiveProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withCleanup(manifest: AcpOwnershipManifest, reason: string): AcpOwnershipManifest {
  return {
    ...manifest,
    state: "degraded",
    cleanup: { attemptedAt: new Date().toISOString(), reason },
  };
}

function manifestReference(manifest: AcpOwnershipManifest) {
  return {
    workerId: manifest.workerId,
    runId: manifest.runId,
    attemptId: manifest.attemptId,
    state: manifest.state,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
