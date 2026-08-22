import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProcessHostShape, ProcessTarget } from "@acpus/owned-process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  matchesProcessStartToken,
  processGroupLiveness,
  processIdentityLiveness,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  processTreeDeadline,
  stopProcessTree,
  type ProcessTreeDeadline,
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
export function inspectAcpOwnership(
  input: AcpOwnershipInspectionInput,
  processes: ProcessHostShape,
): Effect.Effect<AcpOwnershipHealth> {
  return Effect.gen(function*() {
    const decoded = yield* Effect.promise(() => readOwnershipManifestFiles(input.workersRoot));
    if (Result.isFailure(decoded)) return { degraded: 1, orphaned: 0, manifests: [] };
    let degraded = 0;
    let orphaned = 0;
    const manifests: AcpOwnershipHealth["manifests"] = [];
    for (const { manifest } of decoded.success) {
      if (manifest.state.phase === "degraded") degraded += 1;
      const belongsToCurrentOwner = input.owner !== undefined
        && manifest.owner.pid === input.owner.pid
        && manifest.owner.epoch === input.owner.epoch
        && (input.owner.startToken === undefined || manifest.owner.startToken === input.owner.startToken);
      const liveness = yield* matchesProcessStartToken(
        processes,
        manifest.worker.pid,
        manifest.worker.startToken,
      );
      if (!belongsToCurrentOwner || liveness === false) orphaned += 1;
      manifests.push(manifestReference(manifest, belongsToCurrentOwner, liveness));
    }
    return { degraded, orphaned, manifests };
  });
}

/** Performs the factory-owned bounded recovery sweep before the supervisor is returned. */
export function recoverProcessCapsules(
  input: AgentSessionSupervisorOptions,
  processes: ProcessHostShape,
): Effect.Effect<ReadonlyMap<string, QuarantinedOwnership>, AgentSessionSupervisorStartError> {
  return Effect.gen(function*() {
    const entries = yield* Effect.promise(() => readOwnershipManifestFiles(input.workersRoot)).pipe(
      Effect.flatMap(Effect.fromResult),
    );
    const quarantined = new Map<string, QuarantinedOwnership>();
    const deadline = yield* processTreeDeadline(PROCESS_TREE_CLEANUP_BUDGET_MS);
    for (const entry of entries) {
      const recovered = yield* recoverManifest(entry, deadline, processes);
      if (recovered.state !== "dead") quarantined.set(entry.manifest.agentSessionId, { evidence: recovered, manifest: entry });
    }
    return quarantined as ReadonlyMap<string, QuarantinedOwnership>;
  }).pipe(Effect.mapError(error => isSupervisorStartError(error)
    ? error
    : { type: "startup_recovery_failed" as const, message: `Could not recover ACP capsule ownership: ${errorMessage(error)}` }));
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

export function revalidateOwnership(
  entry: OwnershipManifestFile,
  processes: ProcessHostShape,
): Effect.Effect<SessionOwnershipEvidence, unknown> {
  return Effect.gen(function*() {
    const observedAt = new Date().toISOString();
    const root = yield* processIdentityLiveness(
      processes,
      entry.manifest.worker.pid,
      entry.manifest.worker.startToken,
    );
    const group = yield* processGroupLiveness(processes, manifestTarget(entry.manifest));
    if ((root === "absent" || root === "mismatch") && group === "dead") {
      yield* promiseOperation(() => removeManifest(entry.path));
      return { state: "dead", observedAt, reason: "Recorded root identity and process group are both absent." };
    }
    return root === "match" || group === "live"
      ? { state: "live", observedAt, reason: "Recorded process ownership remains live." }
      : { state: "unverified", observedAt, reason: "Recorded process ownership could not be verified." };
  });
}

export function findOwnershipManifest(
  workersRoot: string,
  agentSessionId: string,
): Effect.Effect<OwnershipManifestFile | undefined, AgentSessionSupervisorStartError> {
  return Effect.promise(() => findOwnershipManifestResult(workersRoot, agentSessionId)).pipe(
    Effect.flatMap(Effect.fromResult),
  );
}

async function findOwnershipManifestResult(
  workersRoot: string,
  agentSessionId: string,
): Promise<Result.Result<OwnershipManifestFile | undefined, AgentSessionSupervisorStartError>> {
  const decoded = await readOwnershipManifestFiles(workersRoot);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  return Result.succeed(decoded.success.find(entry => entry.manifest.agentSessionId === agentSessionId));
}

function recoverManifest(
  entry: OwnershipManifestFile,
  deadline: ProcessTreeDeadline,
  processes: ProcessHostShape,
): Effect.Effect<SessionOwnershipEvidence, unknown> {
  return Effect.gen(function*() {
    const root = yield* processIdentityLiveness(
      processes,
      entry.manifest.worker.pid,
      entry.manifest.worker.startToken,
    );
    const target = manifestTarget(entry.manifest);
    const group = yield* processGroupLiveness(processes, target);
    if ((root === "absent" || root === "mismatch") && group === "dead") {
      yield* promiseOperation(() => removeManifest(entry.path));
      return { state: "dead", observedAt: new Date().toISOString(), reason: "Recorded root identity and process group are both absent." };
    }
    if (root !== "match" || (yield* Clock.monotonicTimeNanos) >= deadline) {
      return yield* promiseOperation(() => finishAcpOwnership(
        entry.path,
        entry.manifest,
        root === "match" || group === "live" ? "live" : "unverified",
        "startup_recovery_unverified",
      ));
    }
    const alive = yield* stopProcessTree(processes, target, deadline);
    return yield* promiseOperation(() => finishAcpOwnership(
      entry.path,
      entry.manifest,
      alive,
      "startup_recovery_unverified",
    ));
  });
}

async function readOwnershipManifestFiles(
  workersRoot: string,
): Promise<Result.Result<readonly OwnershipManifestFile[], AgentSessionSupervisorStartError>> {
  let names: string[];
  try {
    names = await readdir(workersRoot);
  } catch (error) {
    if (isMissing(error)) return Result.succeed([]);
    return Result.fail({ type: "startup_recovery_failed", message: `Could not inspect ACP capsule ownership: ${errorMessage(error)}` });
  }
  const files = names.filter(name => MANIFEST_NAME.test(name)).sort();
  const entries: OwnershipManifestFile[] = [];
  for (const name of files) {
    const path = join(workersRoot, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return Result.fail(unsupported(path));
    }
    if (!validManifest(value)) return Result.fail(unsupported(path));
    entries.push({ path, manifest: value });
  }
  return Result.succeed(entries);
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

function manifestTarget(manifest: AcpOwnershipManifest): ProcessTarget {
  return {
    pid: manifest.worker.pid,
    ...(manifest.worker.pgid === undefined ? {} : { processGroupId: manifest.worker.pgid }),
  };
}

function promiseOperation<A>(evaluate: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: evaluate, catch: cause => cause });
}

function isSupervisorStartError(error: unknown): error is AgentSessionSupervisorStartError {
  return record(error)
    && typeof error.type === "string"
    && typeof error.message === "string"
    && (error.type === "startup_recovery_failed"
      || (error.type === "ownership_state_unsupported" && typeof error.manifestName === "string"));
}
