import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentOverrideMap } from "@acpus/runtime";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { err, errAsync, ok, okAsync, Result, ResultAsync, type Result as NeverthrowResult } from "neverthrow";
import { usageError } from "../errors.js";

type JsonOptionError =
  | { type: "invalid-json"; option: string; filePath?: string; message: string }
  | { type: "non-json-value"; option: string; filePath?: string };

type JsonArgumentError = JsonOptionError
  | { type: "json-file-read"; option: string; path: string; message: string }
  | { type: "json-file-empty"; option: string; path: string };

const parseJson = Result.fromThrowable(
  (raw: string) => JSON.parse(raw) as unknown,
  causeMessage,
);

export async function parseAgents(raw: string | undefined, cwd: string): Promise<AgentOverrideMap | undefined> {
  if (raw === undefined) return undefined;
  const value = await parseJsonArgument(raw, cwd, "--agents");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--agents must be a JSON object.");
  return value as AgentOverrideMap;
}

export function parseInput(raw: string, cwd: string): Promise<JsonValue> {
  return parseJsonArgument(raw, cwd, "--input");
}

function parseJsonArgument(raw: string, cwd: string, option: string): Promise<JsonValue> {
  return tryParseJsonArgument(raw, cwd, option).match(
    value => value,
    error => { throw usageError(jsonArgumentErrorMessage(error)); },
  );
}

export function parseRequiredPayload(raw: string | undefined): JsonValue {
  if (raw === undefined) throw usageError("--payload is required.");
  return parseJsonOption(raw, "--payload");
}

function parseJsonOption(raw: string, name: string): JsonValue {
  return tryParseJsonOption(raw, { option: name }).match(
    value => value,
    error => { throw usageError(jsonArgumentErrorMessage(error)); },
  );
}

function tryParseJsonArgument(raw: string, cwd: string, option: string): ResultAsync<JsonValue, JsonArgumentError> {
  if (!/\.json$/i.test(raw)) {
    const parsed = tryParseJsonOption(raw, { option });
    return parsed.isOk() ? okAsync(parsed.value) : errAsync(parsed.error);
  }
  const path = resolve(cwd, raw);
  return ResultAsync.fromPromise(
    readFile(path, "utf8"),
    cause => ({ type: "json-file-read", option, path, message: causeMessage(cause) } as const),
  ).andThen(content => {
    if (/^[\t\n\r ]*$/.test(content)) return err({ type: "json-file-empty", option, path } as const);
    return tryParseJsonOption(content, { option, filePath: path });
  });
}

function tryParseJsonOption(
  raw: string,
  source: { option: string; filePath?: string },
): NeverthrowResult<JsonValue, JsonOptionError> {
  return parseJson(raw)
    .mapErr(message => ({ type: "invalid-json", ...source, message } as const))
    .andThen(value => isJsonValue(value)
      ? ok(value)
      : err({ type: "non-json-value", ...source } as const));
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
