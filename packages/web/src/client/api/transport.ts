import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { hasOnlyKeys, isRecord, type JsonRecord } from "./wire.js";

export type WebApiFailure =
  | { type: "network-failed"; message: string }
  | { type: "response-invalid-json"; status: number; message: string }
  | { type: "response-invalid-envelope"; status: number; message: string }
  | { type: "request-failed"; status: number; code: string; message: string };

export class WebApiError extends Error {
  constructor(readonly failure: WebApiFailure) {
    super(failure.message);
  }
}

export const invalidPayload: unique symbol = Symbol("invalid-payload");
export type InvalidPayload = typeof invalidPayload;
type EndpointDecoder<T> = (body: JsonRecord) => T | InvalidPayload;

export function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  decode: EndpointDecoder<T>,
): Promise<T> {
  return toWebApiPromise(requestJsonResult(input, init, decode));
}

export async function toWebApiPromise<T>(effect: Effect.Effect<T, WebApiFailure>): Promise<T> {
  const result = await Effect.runPromise(Effect.result(effect));
  return Result.match(result, {
    onSuccess: value => value,
    onFailure: failure => { throw new WebApiError(failure); },
  });
}

export function decodeField<T>(
  key: string,
  guard: (value: unknown) => value is T,
): EndpointDecoder<T> {
  return body => hasOnlyKeys(body, ["ok", key]) && guard(body[key])
    ? body[key]
    : invalidPayload;
}

export const decodeEmpty: EndpointDecoder<void> = body => Object.keys(body).length === 1
  ? undefined
  : invalidPayload;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function requestJsonResult<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  decode: EndpointDecoder<T>,
): Effect.Effect<T, WebApiFailure> {
  return Effect.gen(function*() {
    const response = yield* Effect.tryPromise({
      try: () => fetch(input, init),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Network request failed."),
      }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: cause => ({
        type: "network-failed" as const,
        message: errorMessage(cause, "Response body could not be read."),
      }),
    });
    const body = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => ({
        type: "response-invalid-json" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not valid JSON.`,
      }),
    });
    if (!isRecord(body)) {
      return yield* Effect.fail({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not an object envelope.`,
      });
    }
    if (!response.ok || body.ok !== true) {
      const failure = isRecord(body.error) ? body.error : undefined;
      if (body.ok === false && typeof failure?.code === "string" && typeof failure.message === "string") {
        return yield* Effect.fail({
          type: "request-failed" as const,
          status: response.status,
          code: failure.code,
          message: failure.message,
        });
      }
      return yield* Effect.fail({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} did not contain a valid error envelope.`,
      });
    }
    let payload: T | InvalidPayload;
    try {
      payload = decode(body);
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
      payload = invalidPayload;
    }
    if (payload === invalidPayload) {
      return yield* Effect.fail({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} did not contain the expected result.`,
      });
    }
    return payload;
  });
}

function requestLabel(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}
