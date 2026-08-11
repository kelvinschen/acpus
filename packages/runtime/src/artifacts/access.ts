import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { resolveRuntimeLayout } from "../runtime-layout.js";
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
  cwd: string;
  runId: string;
  store: {
    getArtifact(runId: string, artifactId: string): ArtifactRecord | undefined;
    getRunDirectoryToken(runId: string): RunDirectoryToken | undefined;
  };
};

type BoundRegisteredArtifact = {
  artifact: ArtifactRecord;
  run: RunDirectoryToken;
  file: RunFileToken;
};

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
): Result<RunFileToken, ArtifactPathError> {
  const resolved = tryResolveArtifactRef(value, context);
  return resolved.isErr() ? err(resolved.error) : ok(resolved.value.file);
}

export function tryResolveArtifactRef(
  value: unknown,
  context: ArtifactAccessContext,
): Result<BoundRegisteredArtifact, ArtifactPathError> {
  if (!isArtifactRefCandidate(value) || typeof value.uri !== "string") {
    return err({ type: "invalid-artifact-ref", message: "ArtifactRef must contain a string uri." });
  }
  const parsed = parseArtifactUri(value.uri);
  if (parsed.isErr()) return err(parsed.error);
  if (parsed.value.runId !== context.runId) {
    return err({
      type: "artifact-run-mismatch",
      expectedRunId: context.runId,
      actualRunId: parsed.value.runId,
      message: `Artifact '${value.uri}' belongs to run '${parsed.value.runId}', not current run '${context.runId}'.`,
    });
  }
  const artifact = context.store.getArtifact(context.runId, parsed.value.artifactId);
  if (!artifact) {
    return err({
      type: "artifact-not-found",
      runId: context.runId,
      artifactId: parsed.value.artifactId,
      message: `Artifact '${value.uri}' is not registered in current run '${context.runId}'.`,
    });
  }
  const bound = tryBindRegisteredArtifact(value.uri, context, artifact);
  return bound.isErr() ? err(bound.error) : ok(bound.value);
}

export function readVerifiedArtifact(
  context: ArtifactAccessContext,
  artifactId: string,
): { artifact: ArtifactRecord; bytes: Buffer } | undefined {
  const artifact = context.store.getArtifact(context.runId, artifactId);
  if (!artifact) return undefined;
  const uri = `artifact://${context.runId}/${artifactId}`;
  const bound = tryBindRegisteredArtifact(uri, context, artifact);
  if (bound.isErr()) throw new Error(bound.error.message);
  const label = `Artifact '${artifactId}'`;
  const descriptor = openSync(bound.value.file.path, verifiedReadFlags);
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    assertRegularDescriptor(beforeRead, label);
    assertRunFileIdentity(bound.value.file, beforeRead, label);
    verifyRunFile(bound.value.run, bound.value.file, label);
    const bytes = readFileSync(descriptor);
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== artifact.size || actualDigest !== artifact.digest) {
      throw new Error(`Artifact '${artifactId}' failed size/digest verification for run '${context.runId}'.`);
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    assertRegularDescriptor(afterRead, label);
    assertRunFileIdentity(bound.value.file, afterRead, label);
    verifyRunFile(bound.value.run, bound.value.file, label);
    return { artifact, bytes };
  } finally {
    closeSync(descriptor);
  }
}

function tryBindRegisteredArtifact(
  uri: string,
  context: ArtifactAccessContext,
  artifact: ArtifactRecord,
): Result<BoundRegisteredArtifact, ArtifactPathError> {
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
  if (run.runsRoot.path !== resolveRuntimeLayout(context.cwd).runsRoot) {
    throw new Error(`Registered artifact '${artifact.id}' run directory escapes the runtime runs root.`);
  }
  const file = tryCaptureRunFile(run, artifact.path, `Registered artifact '${artifact.id}'`);
  if (file.isErr()) {
    const reason = file.error.reason === "missing"
      ? "file is missing"
      : file.error.reason === "symbolic-link"
        ? "file is a symbolic link"
        : "path is not a regular file";
    return err(unavailablePath(uri, context.runId, artifact.id, reason));
  }
  return ok({ artifact, run, file: file.value });
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
