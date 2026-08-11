import { err, ok, ResultAsync, type Result } from "neverthrow";
import { workspaceRunUrl } from "./runs.js";
import {
  errorMessage,
  toWebApiPromise,
  type WebApiFailure,
} from "./transport.js";
import { isRecord } from "./wire.js";

export type ArtifactPreview = {
  text: string;
  mediaType: string;
  size: number;
  truncated: boolean;
};

export type ArtifactContent = {
  bytes: Uint8Array;
  mediaType: string;
  size: number;
  fileName: string;
};

export async function getArtifactPreview(
  workspaceKey: string,
  runId: string,
  artifactId: string,
): Promise<ArtifactPreview> {
  const url = `${workspaceRunUrl(workspaceKey, runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`;
  const result: ResultAsync<ArtifactPreview, WebApiFailure> = requestArtifactResponse(url).andThen(response => {
    const metadata = parseArtifactMetadata(response, true);
    if (metadata.isErr()) return err(metadata.error);
    return ResultAsync.fromPromise(response.arrayBuffer(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact preview body could not be read."),
    })).andThen(buffer => {
      const expectedLength = Math.min(metadata.value.size, 128 * 1024);
      if (buffer.byteLength !== expectedLength || metadata.value.truncated !== (metadata.value.size > expectedLength)) {
        return invalidArtifactMetadata<ArtifactPreview>(
          response,
          "Artifact preview body did not match its metadata.",
        );
      }
      return ok({ text: new TextDecoder().decode(buffer), ...metadata.value });
    });
  });
  return toWebApiPromise(result);
}

export async function getArtifactContent(
  workspaceKey: string,
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactContent> {
  const url = `${workspaceRunUrl(workspaceKey, runId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
  const result: ResultAsync<ArtifactContent, WebApiFailure> = requestArtifactResponse(url, signal).andThen(response => {
    const metadata = parseArtifactMetadata(response, false);
    if (metadata.isErr()) return err(metadata.error);
    return ResultAsync.fromPromise(response.arrayBuffer(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact content body could not be read."),
    })).andThen(buffer => buffer.byteLength === metadata.value.size
      ? ok({ bytes: new Uint8Array(buffer), ...metadata.value })
      : invalidArtifactMetadata<ArtifactContent>(
          response,
          "Artifact content byte length did not match its metadata.",
        ));
  });
  return toWebApiPromise(result);
}

function requestArtifactResponse(url: string, signal?: AbortSignal): ResultAsync<Response, WebApiFailure> {
  return ResultAsync.fromPromise(fetch(url, signal === undefined ? undefined : { signal }), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Artifact request failed."),
  })).andThen(response => {
    if (response.ok) return ok(response);
    return ResultAsync.fromPromise(response.text(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact error body could not be read."),
    })).andThen(text => {
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return err({
          type: "response-invalid-json" as const,
          status: response.status,
          message: "Artifact error response was not valid JSON.",
        });
      }
      const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
      return typeof failure?.code === "string" && typeof failure.message === "string"
        ? err({
            type: "request-failed" as const,
            status: response.status,
            code: failure.code,
            message: failure.message,
          })
        : err({
            type: "response-invalid-envelope" as const,
            status: response.status,
            message: "Artifact error response did not contain a valid error envelope.",
          });
    });
  });
}

function parseArtifactMetadata(
  response: Response,
  preview: true,
): Result<Omit<ArtifactPreview, "text">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: false,
): Result<Omit<ArtifactContent, "bytes">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: boolean,
): Result<Omit<ArtifactPreview, "text"> | Omit<ArtifactContent, "bytes">, WebApiFailure> {
  const mediaType = response.headers.get("content-type");
  const sizeText = response.headers.get("x-acpus-artifact-size");
  if (!mediaType?.trim() || sizeText === null || !/^(0|[1-9]\d*)$/.test(sizeText)) {
    return invalidArtifactMetadata(response, "Artifact response metadata was invalid.");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) {
    return invalidArtifactMetadata(response, "Artifact response metadata was invalid.");
  }
  if (preview) {
    const truncated = response.headers.get("x-acpus-artifact-truncated");
    if (truncated !== "true" && truncated !== "false") {
      return invalidArtifactMetadata(response, "Artifact preview truncation metadata was invalid.");
    }
    return ok({ mediaType, size, truncated: truncated === "true" });
  }
  const encodedName = response.headers.get("x-acpus-artifact-name");
  if (encodedName === null) {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  if (!fileName || fileName === "." || fileName === ".." || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  return ok({ mediaType, size, fileName });
}

function invalidArtifactMetadata<T>(response: Response, message: string): Result<T, WebApiFailure> {
  return err({ type: "response-invalid-envelope", status: response.status, message });
}
