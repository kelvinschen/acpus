import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeStore } from "../store/store.js";

export type ArtifactPathError =
  | { type: "invalid-artifact-ref"; message: string }
  | { type: "artifact-run-mismatch"; expectedRunId: string; actualRunId: string; message: string }
  | { type: "artifact-not-found"; runId: string; artifactId: string; message: string }
  | { type: "artifact-path-invalid"; runId: string; artifactId: string; message: string };

export type ArtifactPathContext = {
  cwd: string;
  runId: string;
  store: RuntimeStore;
};

export function isArtifactRefCandidate(value: unknown): value is { kind: "artifact"; uri?: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "artifact";
}

export function tryResolveArtifactPath(value: unknown, context: ArtifactPathContext): Result<string, ArtifactPathError> {
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
  return validateRegisteredArtifactPath(value.uri, context, artifact);
}

export function readVerifiedArtifactBytes(context: ArtifactPathContext, artifactId: string): Buffer {
  const artifact = context.store.getArtifact(context.runId, artifactId);
  if (!artifact) throw new Error(`Artifact '${artifactId}' is not registered for run '${context.runId}'.`);
  const uri = `artifact://${context.runId}/${artifactId}`;
  const path = validateRegisteredArtifactPath(uri, context, artifact);
  if (path.isErr()) throw new Error(path.error.message);
  const bytes = readFileSync(path.value);
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== artifact.size || actualDigest !== artifact.digest) {
    throw new Error(`Artifact '${artifactId}' failed size/digest verification for run '${context.runId}'.`);
  }
  return bytes;
}

function validateRegisteredArtifactPath(
  uri: string,
  context: ArtifactPathContext,
  artifact: NonNullable<ReturnType<RuntimeStore["getArtifact"]>>,
): Result<string, ArtifactPathError> {
  const runDir = context.store.getRunDir(context.runId);
  if (!runDir) throw new Error(`Run '${context.runId}' has no run directory for registered artifact '${artifact.id}'.`);
  const root = resolve(context.cwd, runDir);
  const runsRoot = resolve(context.cwd, ".acpus", ".local", "runs");
  if (dirname(root) !== runsRoot) throw new Error(`Registered artifact '${artifact.id}' run directory escapes the runtime runs root.`);
  if (!isAbsolute(artifact.path) || !isContainedPath(root, artifact.path)) {
    throw new Error(`Registered artifact '${artifact.id}' path escapes the run directory.`);
  }
  const runsRootInfo = lstatSync(runsRoot);
  const realWorkspace = realpathSync(resolve(context.cwd));
  const realRunsRoot = realpathSync(runsRoot);
  if (runsRootInfo.isSymbolicLink() || !runsRootInfo.isDirectory() || !isContainedPath(realWorkspace, realRunsRoot)) {
    throw new Error("Runtime runs root is a symbolic link or resolves outside the workspace.");
  }
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Run directory for registered artifact '${artifact.id}' is not a regular directory.`);
  }
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(artifact.path);
  } catch (error) {
    if (isMissingPathError(error)) return err(unavailablePath(uri, context.runId, artifact.id, "file is missing"));
    throw error;
  }
  if (info.isSymbolicLink()) return err(unavailablePath(uri, context.runId, artifact.id, "file is a symbolic link"));
  if (!info.isFile()) return err(unavailablePath(uri, context.runId, artifact.id, "path is not a regular file"));
  const realRoot = realpathSync(root);
  let realPath: string;
  try {
    realPath = realpathSync(artifact.path);
  } catch (error) {
    if (isMissingPathError(error)) return err(unavailablePath(uri, context.runId, artifact.id, "file is missing"));
    throw error;
  }
  if (dirname(realRoot) !== realRunsRoot || !isContainedPath(realRoot, realPath)) {
    throw new Error(`Registered artifact '${artifact.id}' resolves outside the run directory.`);
  }
  return ok(artifact.path);
}

function unavailablePath(uri: string, runId: string, artifactId: string, reason: string): ArtifactPathError {
  return {
    type: "artifact-path-invalid",
    runId,
    artifactId,
    message: `Artifact '${uri}' has no consumable local file: ${reason}.`,
  };
}

function isMissingPathError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function parseArtifactUri(uri: string): Result<{ runId: string; artifactId: string }, ArtifactPathError> {
  const match = /^artifact:\/\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(uri);
  return match
    ? ok({ runId: match[1]!, artifactId: match[2]! })
    : err({ type: "invalid-artifact-ref", message: `ArtifactRef uri '${uri}' must use artifact://<runId>/<artifactId>.` });
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
