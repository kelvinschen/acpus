import { lstatSync, realpathSync } from "node:fs";
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
  let artifact: ReturnType<RuntimeStore["getArtifact"]>;
  try {
    artifact = context.store.getArtifact(context.runId, parsed.value.artifactId);
  } catch (cause) {
    return err(invalidPath(value.uri, context.runId, parsed.value.artifactId, cause));
  }
  if (!artifact) {
    return err({
      type: "artifact-not-found",
      runId: context.runId,
      artifactId: parsed.value.artifactId,
      message: `Artifact '${value.uri}' is not registered in current run '${context.runId}'.`,
    });
  }
  let runDir: string | undefined;
  try {
    runDir = context.store.getRunDir(context.runId);
  } catch (cause) {
    return err(invalidPath(value.uri, context.runId, parsed.value.artifactId, cause));
  }
  if (!runDir) {
    return err({
      type: "artifact-path-invalid",
      runId: context.runId,
      artifactId: parsed.value.artifactId,
      message: `Run '${context.runId}' has no run directory for artifact '${value.uri}'.`,
    });
  }
  try {
    const root = resolve(context.cwd, runDir);
    if (!isAbsolute(artifact.path) || !isContainedPath(root, artifact.path)) {
      throw new Error("registered path escapes the run directory");
    }
    const rootInfo = lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("run directory is not a regular directory");
    const info = lstatSync(artifact.path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("registered path is not a regular file");
    const realRunsRoot = realpathSync(dirname(root));
    const realRoot = realpathSync(root);
    const realPath = realpathSync(artifact.path);
    if (dirname(realRoot) !== realRunsRoot || !isContainedPath(realRoot, realPath)) {
      throw new Error("registered path resolves outside the run directory");
    }
    return ok(artifact.path);
  } catch (cause) {
    return err(invalidPath(value.uri, context.runId, parsed.value.artifactId, cause));
  }
}

function invalidPath(uri: string, runId: string, artifactId: string, cause: unknown): ArtifactPathError {
  return {
    type: "artifact-path-invalid",
    runId,
    artifactId,
    message: `Artifact '${uri}' has no consumable local file: ${cause instanceof Error ? cause.message : String(cause)}.`,
  };
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
