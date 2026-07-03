import type { JsonValue } from "@acpus/expression/ir";

export class ArtifactRewriteError extends Error {
  constructor(readonly artifactId: string) {
    super(`Missing fork artifact id for '${artifactId}'.`);
  }
}

export function rewriteArtifactValue(value: JsonValue, sourceRunId: string, forkRunId: string, artifactIds: Record<string, string>): JsonValue {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds));
  if (value.kind === "artifact" && typeof value.uri === "string") {
    const prefix = `artifact://${sourceRunId}/`;
    if (value.uri.startsWith(prefix)) {
      const sourceArtifactId = value.uri.slice(prefix.length);
      const forkArtifactId = artifactIds[sourceArtifactId];
      if (!forkArtifactId) throw new ArtifactRewriteError(sourceArtifactId);
      return { ...value, uri: `artifact://${forkRunId}/${forkArtifactId}` };
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    rewriteArtifactValue(item, sourceRunId, forkRunId, artifactIds),
  ])) as JsonValue;
}
