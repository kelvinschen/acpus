import * as Result from "effect/Result";

export type InvalidArtifactReference = {
  type: "invalid-artifact-ref";
  message: string;
};

export function parseArtifactUri(
  uri: string,
): Result.Result<{ runId: string; artifactId: string }, InvalidArtifactReference> {
  const match = /^artifact:\/\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(uri);
  return match
    ? Result.succeed({ runId: match[1]!, artifactId: match[2]! })
    : Result.fail({ type: "invalid-artifact-ref", message: `ArtifactRef uri '${uri}' must use artifact://<runId>/<artifactId>.` });
}
