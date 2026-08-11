import { err, ok, type Result } from "neverthrow";

export type InvalidArtifactReference = {
  type: "invalid-artifact-ref";
  message: string;
};

export function parseArtifactUri(
  uri: string,
): Result<{ runId: string; artifactId: string }, InvalidArtifactReference> {
  const match = /^artifact:\/\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(uri);
  return match
    ? ok({ runId: match[1]!, artifactId: match[2]! })
    : err({ type: "invalid-artifact-ref", message: `ArtifactRef uri '${uri}' must use artifact://<runId>/<artifactId>.` });
}
