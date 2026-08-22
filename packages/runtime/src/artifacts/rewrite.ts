import type { JsonValue } from "@acpus/expression/ir";
import * as Result from "effect/Result";

export type ArtifactRewriteFailure = { type: "artifact-rewrite-failure"; artifactId: string; message: string };

export function rewriteArtifactValue(value: JsonValue, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): Result.Result<JsonValue, ArtifactRewriteFailure> {
  if (!value || typeof value !== "object") return Result.succeed(value);
  if (Array.isArray(value)) {
    const rewritten: JsonValue[] = [];
    for (const item of value) {
      const next = rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds);
      if (Result.isFailure(next)) return Result.fail(next.failure);
      rewritten.push(next.success);
    }
    return Result.succeed(rewritten);
  }
  if (value.kind === "artifact" && typeof value.uri === "string") {
    const prefix = `artifact://${sourceRunId}/`;
    if (value.uri.startsWith(prefix)) {
      const sourceArtifactId = value.uri.slice(prefix.length);
      const forkArtifactId = artifactIds[sourceArtifactId];
      if (!forkArtifactId) return Result.fail({ type: "artifact-rewrite-failure", artifactId: sourceArtifactId, message: `Missing fork artifact id for '${sourceArtifactId}'.` });
      return Result.succeed({ ...value, uri: `artifact://${forkRunId}/${forkArtifactId}` });
    }
  }
  const rewritten: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds);
    if (Result.isFailure(next)) return Result.fail(next.failure);
    Object.defineProperty(rewritten, key, {
      value: next.success,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Result.succeed(rewritten);
}
