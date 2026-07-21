import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentOverrideMap } from "@acpus/runtime";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { err, errAsync, ok, okAsync, Result, ResultAsync, type Result as NeverthrowResult } from "neverthrow";
import { usageError } from "../errors.js";

type JsonOptionError =
  | { type: "invalid-json"; option: string; filePath?: string; message: string }
  | { type: "non-json-value"; option: string; filePath?: string };

type InputOptionError = JsonOptionError
  | { type: "input-file-read"; path: string; message: string }
  | { type: "input-file-empty"; path: string };

const parseJson = Result.fromThrowable(
  (raw: string) => JSON.parse(raw) as unknown,
  causeMessage,
);

export function parseAgents(raw: string | undefined): AgentOverrideMap | undefined {
  if (raw === undefined) return undefined;
  const value = parseJsonOption(raw, "--agents");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--agents must be a JSON object.");
  return value as AgentOverrideMap;
}

export function parseInput(raw: string, cwd: string): Promise<JsonValue> {
  return tryParseInput(raw, cwd).match(
    value => value,
    error => { throw usageError(inputErrorMessage(error)); },
  );
}

export function parseRequiredPayload(raw: string | undefined): JsonValue {
  if (raw === undefined) throw usageError("--payload is required.");
  return parseJsonOption(raw, "--payload");
}

function parseJsonOption(raw: string, name: string): JsonValue {
  return tryParseJsonOption(raw, { option: name }).match(
    value => value,
    error => { throw usageError(inputErrorMessage(error)); },
  );
}

function tryParseInput(raw: string, cwd: string): ResultAsync<JsonValue, InputOptionError> {
  if (!/\.json$/i.test(raw)) {
    const parsed = tryParseJsonOption(raw, { option: "--input" });
    return parsed.isOk() ? okAsync(parsed.value) : errAsync(parsed.error);
  }
  const path = resolve(cwd, raw);
  return ResultAsync.fromPromise(
    readFile(path, "utf8"),
    cause => ({ type: "input-file-read", path, message: causeMessage(cause) } as const),
  ).andThen(content => {
    if (/^[\t\n\r ]*$/.test(content)) return err({ type: "input-file-empty", path } as const);
    return tryParseJsonOption(content, { option: "--input", filePath: path });
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

function inputErrorMessage(error: InputOptionError): string {
  if (error.type === "input-file-read") return `--input file '${error.path}' could not be read: ${error.message}`;
  if (error.type === "input-file-empty") return `--input file '${error.path}' is empty.`;
  const source = error.filePath === undefined ? error.option : `${error.option} file '${error.filePath}'`;
  return error.type === "invalid-json"
    ? `${source} must be valid JSON: ${error.message}`
    : `${source} must be JSON-serializable.`;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
