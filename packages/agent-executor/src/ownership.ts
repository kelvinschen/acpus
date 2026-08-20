import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  matchesProcessStartToken,
  processGroupLiveness,
  processIdentityLiveness,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  stopProcessTree,
} from "./process-tree.js";
import type {
  AcpOwnershipHealth,
  AcpOwnershipManifest,
  AgentSessionSupervisorOptions,
  AgentSessionSupervisorStartError,
  SessionOwnershipEvidence,
} from "./types.js";

const MANIFEST_MODE = 0o600;
const MANIFEST_NAME = /^acp_capsule_[0-9a-f-]+\.json$/u;

type AcpOwnershipInspectionInput = Readonly<{
  workersRoot: string;
  owner?: AgentSessionSupervisorOptions["owner"];
}>;

export type OwnershipManifestFile = Readonly<{
  path: string;
  manifest: AcpOwnershipManifest;
}>;

export type QuarantinedOwnership = Readonly<{
  evidence: SessionOwnershipEvidence;
  manifest?: OwnershipManifestFile;
}>;

/** Reads bounded residual ownership evidence without changing or signalling it. */
export async function inspectAcpOwnership(input: AcpOwnershipInspectionInput): Promise<AcpOwnershipHealth> {
  const decoded = await readOwnershipManifestFiles(input.workersRoot);
  if (decoded.isErr()) return { degraded: 1, orphaned: 0, manifests: [] };
  let degraded = 0;
  let orphaned = 0;
  const manifests: AcpOwnershipHealth["manifests"] = [];
  for (const { manifest } of decoded.value) {
    if (manifest.state.phase === "degraded") degraded += 1;
    const belongsToCurrentOwner = input.owner !== undefined
      && manifest.owner.pid === input.owner.pid
      && manifest.owner.epoch === input.owner.epoch
      && (input.owner.startToken === undefined || manifest.owner.startToken === input.owner.startToken);
    const liveness = await matchesProcessStartToken(manifest.worker.pid, manifest.worker.startToken);
    if (!belongsToCurrentOwner || liveness === false) orphaned += 1;
    manifests.push(manifestReference(manifest, belongsToCurrentOwner, liveness));
  }
  return { degraded, orphaned, manifests };
}

/** Performs the factory-owned bounded recovery sweep before the supervisor is returned. */
export async function recoverProcessCapsules(
  input: AgentSessionSupervisorOptions,
): Promise<Result<ReadonlyMap<string, QuarantinedOwnership>, AgentSessionSupervisorStartError>> {
  const decoded = await readOwnershipManifestFiles(input.workersRoot);
  if (decoded.isErr()) return err(decoded.error);
  const quarantined = new Map<string, QuarantinedOwnership>();
  const deadline = performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS;
  try {
    for (const entry of decoded.value) {
      const recovered = await recoverManifest(entry, deadline);
      if (recovered.state !== "dead") quarantined.set(entry.manifest.agentSessionId, { evidence: recovered, manifest: entry });
    }
  } catch (error) {
    return err({ type: "startup_recovery_failed", message: `Could not recover ACP capsule ownership: ${errorMessage(error)}` });
  }
  return ok(quarantined);
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
    await unlink(temporary).catch(() => undefined);
  }
}

export async function finishAcpOwnership(
  path: string,
  manifest: AcpOwnershipManifest,
  treeLiveness: boolean | "live" | "dead" | "unverified",
  reason: "cleanup_unverified" | "startup_recovery_unverified",
): Promise<SessionOwnershipEvidence> {
  const observedAt = new Date().toISOString();
  const liveness = typeof treeLiveness === "boolean" ? treeLiveness ? "live" : "dead" : treeLiveness;
  if (liveness === "dead") {
    await removeManifest(path);
    return { state: "dead", observedAt, reason: "Process tree death was proven." };
  }
  const previousPhase = manifest.state.phase === "degraded" ? manifest.state.previousPhase : manifest.state.phase;
  const degraded: AcpOwnershipManifest = {
    ...manifest,
    state: {
      phase: "degraded",
      previousPhase,
      evidence: { reason, liveness: liveness === "live" ? "live" : "unverified", observedAt },
    },
  };
  await writeAcpOwnershipManifest(path, degraded);
  return liveness === "live"
    ? { state: "live", observedAt, reason: "Residual process tree remains live after bounded cleanup." }
    : { state: "unverified", observedAt, reason: "Residual process tree liveness could not be verified." };
}

export async function revalidateOwnership(
  entry: OwnershipManifestFile,
): Promise<SessionOwnershipEvidence> {
  const observedAt = new Date().toISOString();
  const root = await processIdentityLiveness(entry.manifest.worker.pid, entry.manifest.worker.startToken);
  const group = await processGroupLiveness(entry.manifest.worker.pgid ?? entry.manifest.worker.pid);
  if ((root === "absent" || root === "mismatch") && group === "dead") {
    await removeManifest(entry.path);
    return { state: "dead", observedAt, reason: "Recorded root identity and process group are both absent." };
  }
  return root === "match" || group === "live"
    ? { state: "live", observedAt, reason: "Recorded process ownership remains live." }
    : { state: "unverified", observedAt, reason: "Recorded process ownership could not be verified." };
}

export async function findOwnershipManifest(
  workersRoot: string,
  agentSessionId: string,
): Promise<Result<OwnershipManifestFile | undefined, AgentSessionSupervisorStartError>> {
  const decoded = await readOwnershipManifestFiles(workersRoot);
  if (decoded.isErr()) return err(decoded.error);
  return ok(decoded.value.find(entry => entry.manifest.agentSessionId === agentSessionId));
}

async function recoverManifest(
  entry: OwnershipManifestFile,
  deadline: number,
): Promise<SessionOwnershipEvidence> {
  const root = await processIdentityLiveness(entry.manifest.worker.pid, entry.manifest.worker.startToken);
  const group = await processGroupLiveness(entry.manifest.worker.pgid ?? entry.manifest.worker.pid);
  if ((root === "absent" || root === "mismatch") && group === "dead") {
    await removeManifest(entry.path);
    return { state: "dead", observedAt: new Date().toISOString(), reason: "Recorded root identity and process group are both absent." };
  }
  if (root !== "match" || performance.now() >= deadline) {
    return finishAcpOwnership(
      entry.path,
      entry.manifest,
      root === "match" || group === "live" ? "live" : "unverified",
      "startup_recovery_unverified",
    );
  }
  const alive = await stopProcessTree(entry.manifest.worker.pgid ?? entry.manifest.worker.pid, deadline);
  return finishAcpOwnership(
    entry.path,
    entry.manifest,
    alive,
    "startup_recovery_unverified",
  );
}

async function readOwnershipManifestFiles(
  workersRoot: string,
): Promise<Result<readonly OwnershipManifestFile[], AgentSessionSupervisorStartError>> {
  let names: string[];
  try {
    names = await readdir(workersRoot);
  } catch (error) {
    if (isMissing(error)) return ok([]);
    return err({ type: "startup_recovery_failed", message: `Could not inspect ACP capsule ownership: ${errorMessage(error)}` });
  }
  const files = names.filter(name => MANIFEST_NAME.test(name)).sort();
  const entries: OwnershipManifestFile[] = [];
  for (const name of files) {
    const path = join(workersRoot, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return err(unsupported(path));
    }
    if (!validManifest(value)) return err(unsupported(path));
    entries.push({ path, manifest: value });
  }
  return ok(entries);
}

async function removeManifest(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (!isMissing(error)) throw error;
  });
}

function validManifest(value: unknown): value is AcpOwnershipManifest {
  if (!record(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.schemaVersion === 3
    && typeof manifest.hostId === "string"
    && typeof manifest.agentSessionId === "string"
    && typeof manifest.sessionLeaseId === "string"
    && typeof manifest.runId === "string"
    && typeof manifest.attemptId === "string"
    && ownerIdentity(manifest.owner)
    && workerIdentity(manifest.worker)
    && manifestState(manifest.state)
    && typeof manifest.createdAt === "string";
}

function ownerIdentity(value: unknown): boolean {
  return record(value)
    && positiveProcessId(value.pid)
    && Number.isSafeInteger(value.epoch)
    && (value.startToken === undefined || typeof value.startToken === "string");
}

function workerIdentity(value: unknown): boolean {
  return record(value)
    && positiveProcessId(value.pid)
    && (value.startToken === undefined || typeof value.startToken === "string")
    && (value.pgid === undefined || positiveProcessId(value.pgid));
}

function manifestState(value: unknown): boolean {
  if (!record(value) || typeof value.phase !== "string") return false;
  if (["opening", "ready", "cleaning"].includes(value.phase)) return true;
  if (["running", "cancelling"].includes(value.phase)) return typeof value.turnId === "string";
  return value.phase === "degraded"
    && ["opening", "ready", "running", "cancelling", "cleaning"].includes(String(value.previousPhase))
    && record(value.evidence)
    && ["cleanup_unverified", "startup_recovery_unverified"].includes(String(value.evidence.reason))
    && ["live", "unverified"].includes(String(value.evidence.liveness))
    && typeof value.evidence.observedAt === "string";
}

function manifestReference(
  manifest: AcpOwnershipManifest,
  belongsToCurrentOwner: boolean,
  liveness: boolean | undefined,
): AcpOwnershipHealth["manifests"][number] {
  const health = manifest.state.phase === "degraded"
    ? manifest.state.evidence.liveness === "unverified" ? "unverified" as const : "quarantined" as const
    : belongsToCurrentOwner && liveness === true
      ? "healthy" as const
      : liveness === undefined
        ? "unverified" as const
        : "quarantined" as const;
  return {
    hostId: manifest.hostId,
    agentSessionId: manifest.agentSessionId,
    runId: manifest.runId,
    attemptId: manifest.attemptId,
    state: manifest.state,
    health,
  };
}

function unsupported(path: string): AgentSessionSupervisorStartError {
  return {
    type: "ownership_state_unsupported",
    manifestName: basename(path),
    message: `Unsupported ACP capsule ownership manifest '${basename(path)}'.`,
  };
}

function positiveProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
