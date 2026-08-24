import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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
  const effect = Effect.gen(function*() {
    const response = yield* requestArtifactResponse(url);
    const metadata = parseArtifactMetadata(response, true);
    const value = yield* Effect.fromResult(metadata);
    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Artifact preview body could not be read."),
      }),
    });
    const expectedLength = Math.min(value.size, 128 * 1024);
    if (buffer.byteLength !== expectedLength || value.truncated !== (value.size > expectedLength)) {
      return yield* Effect.fromResult(invalidArtifactMetadata<ArtifactPreview>(
        response,
        "Artifact preview body did not match its metadata.",
      ));
    }
    return { text: new TextDecoder().decode(buffer), ...value };
  });
  return toWebApiPromise(effect);
}

export async function getArtifactContent(
  workspaceKey: string,
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactContent> {
  const url = `${workspaceRunUrl(workspaceKey, runId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
  const effect = Effect.gen(function*() {
    const response = yield* requestArtifactResponse(url, signal);
    const metadata = parseArtifactMetadata(response, false);
    const value = yield* Effect.fromResult(metadata);
    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Artifact content body could not be read."),
      }),
    });
    return buffer.byteLength === value.size
      ? { bytes: new Uint8Array(buffer), ...value }
      : yield* Effect.fromResult(invalidArtifactMetadata<ArtifactContent>(
          response,
          "Artifact content byte length did not match its metadata.",
        ));
  });
  return toWebApiPromise(effect);
}

function requestArtifactResponse(url: string, signal?: AbortSignal): Effect.Effect<Response, WebApiFailure> {
  return Effect.gen(function*() {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, signal === undefined ? undefined : { signal }),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Artifact request failed."),
      }),
    });
    if (response.ok) return response;
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Artifact error body could not be read."),
      }),
    });
    const body = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => ({
        type: "response-invalid-json" as const,
        status: response.status,
        message: "Artifact error response was not valid JSON.",
      }),
    });
    const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
    return yield* Effect.fail(typeof failure?.code === "string" && typeof failure.message === "string"
      ? {
          type: "request-failed" as const,
          status: response.status,
          code: failure.code,
          message: failure.message,
        }
      : {
          type: "response-invalid-envelope" as const,
          status: response.status,
          message: "Artifact error response did not contain a valid error envelope.",
        });
  });
}

function parseArtifactMetadata(
  response: Response,
  preview: true,
): Result.Result<Omit<ArtifactPreview, "text">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: false,
): Result.Result<Omit<ArtifactContent, "bytes">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: boolean,
): Result.Result<Omit<ArtifactPreview, "text"> | Omit<ArtifactContent, "bytes">, WebApiFailure> {
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
    return Result.succeed({ mediaType, size, truncated: truncated === "true" });
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
  return Result.succeed({ mediaType, size, fileName });
}

function invalidArtifactMetadata<T>(response: Response, message: string): Result.Result<T, WebApiFailure> {
  return Result.fail({ type: "response-invalid-envelope", status: response.status, message });
}
