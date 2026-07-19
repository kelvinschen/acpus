import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";

export type ArtifactRewriteFailure = { type: "artifact-rewrite-failure"; artifactId: string; message: string };

export function rewriteArtifactValue(value: JsonValue, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): Result<JsonValue, ArtifactRewriteFailure> {
  if (!value || typeof value !== "object") return ok(value);
  if (Array.isArray(value)) {
    const rewritten: JsonValue[] = [];
    for (const item of value) {
      const next = rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds);
      if (next.isErr()) return err(next.error);
      rewritten.push(next.value);
    }
    return ok(rewritten);
  }
  if (value.kind === "artifact" && typeof value.uri === "string") {
    const prefix = `artifact://${sourceRunId}/`;
    if (value.uri.startsWith(prefix)) {
      const sourceArtifactId = value.uri.slice(prefix.length);
      const forkArtifactId = artifactIds[sourceArtifactId];
      if (!forkArtifactId) return err({ type: "artifact-rewrite-failure", artifactId: sourceArtifactId, message: `Missing fork artifact id for '${sourceArtifactId}'.` });
      return ok({ ...value, uri: `artifact://${forkRunId}/${forkArtifactId}` });
    }
  }
  const rewritten: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds);
    if (next.isErr()) return err(next.error);
    Object.defineProperty(rewritten, key, {
      value: next.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return ok(rewritten);
}
