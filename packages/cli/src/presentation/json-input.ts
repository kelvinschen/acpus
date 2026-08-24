import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentInjectionMap } from "@acpus/runtime";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { usageError } from "./errors.js";

type JsonOptionError =
  | { type: "invalid-json"; option: string; filePath?: string; message: string }
  | { type: "non-json-value"; option: string; filePath?: string };

type JsonArgumentError = JsonOptionError
  | { type: "json-file-read"; option: string; path: string; message: string }
  | { type: "json-file-empty"; option: string; path: string };

export async function parseAgents(raw: string | undefined, cwd: string): Promise<AgentInjectionMap | undefined> {
  if (raw === undefined) return undefined;
  const value = await parseJsonArgument(raw, cwd, "--agents");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--agents must be a JSON object.");
  return value as AgentInjectionMap;
}

export function parseInput(raw: string, cwd: string): Promise<JsonValue> {
  return parseJsonArgument(raw, cwd, "--input");
}

export async function parseJsonArgument(raw: string, cwd: string, option: string): Promise<JsonValue> {
  const result = await Effect.runPromise(Effect.result(tryParseJsonArgument(raw, cwd, option)));
  return Result.match(result, {
    onSuccess: value => value,
    onFailure: error => { throw usageError(jsonArgumentErrorMessage(error)); },
  });
}

export function parseRequiredPayload(raw: string | undefined): JsonValue {
  if (raw === undefined) throw usageError("--payload is required.");
  return parseJsonOption(raw, "--payload");
}

function parseJsonOption(raw: string, name: string): JsonValue {
  return Result.match(tryParseJsonOption(raw, { option: name }), {
    onSuccess: value => value,
    onFailure: error => { throw usageError(jsonArgumentErrorMessage(error)); },
  });
}

function tryParseJsonArgument(raw: string, cwd: string, option: string): Effect.Effect<JsonValue, JsonArgumentError> {
  if (!/\.json$/i.test(raw)) {
    return Effect.fromResult(tryParseJsonOption(raw, { option }));
  }
  const path = resolve(cwd, raw);
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: cause => ({
      type: "json-file-read",
      option,
      path,
      message: causeMessage(cause),
    } satisfies JsonArgumentError),
  }).pipe(Effect.flatMap(content => Effect.fromResult(parseJsonFileContent(content, option, path))));
}

function parseJsonFileContent(content: string, option: string, path: string): Result.Result<JsonValue, JsonArgumentError> {
  return /^[\t\n\r ]*$/.test(content)
    ? Result.fail({ type: "json-file-empty", option, path })
    : tryParseJsonOption(content, { option, filePath: path });
}

function tryParseJsonOption(
  raw: string,
  source: { option: string; filePath?: string },
): Result.Result<JsonValue, JsonOptionError> {
  return Result.flatMap(
    Result.try({
      try: () => JSON.parse(raw) as unknown,
      catch: causeMessage,
    }).pipe(Result.mapError(message => ({ type: "invalid-json", ...source, message } as const))),
    value => isJsonValue(value)
      ? Result.succeed(value)
      : Result.fail({ type: "non-json-value", ...source } as const),
  );
}

function jsonArgumentErrorMessage(error: JsonArgumentError): string {
  if (error.type === "json-file-read") return `${error.option} file '${error.path}' could not be read: ${error.message}`;
  if (error.type === "json-file-empty") return `${error.option} file '${error.path}' is empty.`;
  const source = error.filePath === undefined ? error.option : `${error.option} file '${error.filePath}'`;
  return error.type === "invalid-json"
    ? `${source} must be valid JSON: ${error.message}`
    : `${source} must be JSON-serializable.`;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
