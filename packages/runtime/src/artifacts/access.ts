import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { sha256Digest } from "@acpus/core/content-identity";
import * as Result from "effect/Result";
import {
  assertRunFileIdentity,
  tryCaptureRunFile,
  verifyRunFile,
  type RunFileToken,
} from "../store/run-file.js";
import type { RunDirectoryToken } from "../store/path-fence.js";
import { parseArtifactUri } from "./reference.js";
import type { ArtifactRecord } from "./types.js";

export type ArtifactPathError =
  | { type: "invalid-artifact-ref"; message: string }
  | { type: "artifact-run-mismatch"; expectedRunId: string; actualRunId: string; message: string }
  | { type: "artifact-not-found"; runId: string; artifactId: string; message: string }
  | { type: "artifact-path-invalid"; runId: string; artifactId: string; message: string };

export type ArtifactAccessContext = {
  runId: string;
  store: {
    readonly runsRoot: string;
    getArtifact(runId: string, artifactId: string): ArtifactRecord | undefined;
    getRunDirectoryToken(runId: string): RunDirectoryToken | undefined;
  };
};

export type BoundRegisteredArtifact = {
  artifact: ArtifactRecord;
  run: RunDirectoryToken;
  file: RunFileToken;
};

export class ArtifactReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactReadUnavailableError";
  }
}

const verifiedReadFlags = fsConstants.O_RDONLY
  | (fsConstants.O_NONBLOCK ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0);

export function isArtifactRefCandidate(value: unknown): value is { kind: "artifact"; uri?: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "artifact";
}

export function tryBindArtifactRef(
  value: unknown,
  context: ArtifactAccessContext,
): Result.Result<RunFileToken, ArtifactPathError> {
  const resolved = tryResolveArtifactRef(value, context);
  return Result.isFailure(resolved) ? Result.fail(resolved.failure) : Result.succeed(resolved.success.file);
}

export function tryResolveArtifactRef(
  value: unknown,
  context: ArtifactAccessContext,
): Result.Result<BoundRegisteredArtifact, ArtifactPathError> {
  if (!isArtifactRefCandidate(value) || typeof value.uri !== "string") {
    return Result.fail({ type: "invalid-artifact-ref", message: "ArtifactRef must contain a string uri." });
  }
  const parsed = parseArtifactUri(value.uri);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  if (parsed.success.runId !== context.runId) {
    return Result.fail({
      type: "artifact-run-mismatch",
      expectedRunId: context.runId,
      actualRunId: parsed.success.runId,
      message: `Artifact '${value.uri}' belongs to run '${parsed.success.runId}', not current run '${context.runId}'.`,
    });
  }
  const artifact = context.store.getArtifact(context.runId, parsed.success.artifactId);
  if (!artifact) {
    return Result.fail({
      type: "artifact-not-found",
      runId: context.runId,
      artifactId: parsed.success.artifactId,
      message: `Artifact '${value.uri}' is not registered in current run '${context.runId}'.`,
    });
  }
  const bound = tryBindRegisteredArtifact(value.uri, context, artifact);
  return Result.isFailure(bound) ? Result.fail(bound.failure) : Result.succeed(bound.success);
}

export function readVerifiedArtifact(
  context: ArtifactAccessContext,
  artifactId: string,
): { artifact: ArtifactRecord; bytes: Buffer } | undefined {
  const artifact = context.store.getArtifact(context.runId, artifactId);
  if (!artifact) return undefined;
  const uri = `artifact://${context.runId}/${artifactId}`;
  const bound = tryBindRegisteredArtifact(uri, context, artifact);
  if (Result.isFailure(bound)) throw new ArtifactReadUnavailableError(bound.failure.message);
  const label = `Artifact '${artifactId}'`;
  const descriptor = openSync(bound.success.file.path, verifiedReadFlags);
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    assertRegularDescriptor(beforeRead, label);
    assertRunFileIdentity(bound.success.file, beforeRead, label);
    verifyRunFile(bound.success.run, bound.success.file, label);
    const bytes = readFileSync(descriptor);
    const actualDigest = sha256Digest(bytes);
    if (bytes.byteLength !== artifact.size || actualDigest !== artifact.digest) {
      throw new ArtifactReadUnavailableError(
        `Artifact '${artifactId}' failed size/digest verification for run '${context.runId}'.`,
      );
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    assertRegularDescriptor(afterRead, label);
    assertRunFileIdentity(bound.success.file, afterRead, label);
    verifyRunFile(bound.success.run, bound.success.file, label);
    return { artifact, bytes };
  } finally {
    closeSync(descriptor);
  }
}

function tryBindRegisteredArtifact(
  uri: string,
  context: ArtifactAccessContext,
  artifact: ArtifactRecord,
): Result.Result<BoundRegisteredArtifact, ArtifactPathError> {
  if (artifact.runId !== context.runId) {
    throw new Error(`Registered artifact '${artifact.id}' belongs to run '${artifact.runId}', not '${context.runId}'.`);
  }
  if (!isAbsolute(artifact.path)) {
    throw new Error(`Registered artifact '${artifact.id}' path escapes the run directory.`);
  }
  const run = context.store.getRunDirectoryToken(context.runId);
  if (!run) {
    throw new Error(`Run '${context.runId}' has no run directory for registered artifact '${artifact.id}'.`);
  }
  if (run.runId !== context.runId) {
    throw new Error(`Registered artifact '${artifact.id}' run directory belongs to run '${run.runId}', not '${context.runId}'.`);
  }
  if (run.runsRoot.path !== context.store.runsRoot) {
    throw new Error(`Registered artifact '${artifact.id}' run directory escapes the runtime runs root.`);
  }
  const file = tryCaptureRunFile(run, artifact.path, `Registered artifact '${artifact.id}'`);
  if (Result.isFailure(file)) {
    const reason = file.failure.reason === "missing"
      ? "file is missing"
      : file.failure.reason === "symbolic-link"
        ? "file is a symbolic link"
        : "path is not a regular file";
    return Result.fail(unavailablePath(uri, context.runId, artifact.id, reason));
  }
  return Result.succeed({ artifact, run, file: file.success });
}

function assertRegularDescriptor(
  info: BigIntStats,
  label: string,
): void {
  if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
}

function unavailablePath(uri: string, runId: string, artifactId: string, reason: string): ArtifactPathError {
  return {
    type: "artifact-path-invalid",
    runId,
    artifactId,
    message: `Artifact '${uri}' has no consumable local file: ${reason}.`,
  };
}
