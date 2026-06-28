import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { JsonValue } from "@acpus/core";
import { usageError } from "../errors.js";

export async function readJsonOption(args: {
  cwd: string;
  input?: string;
  inputFile?: string;
  defaultValue?: JsonValue;
}): Promise<JsonValue> {
  if (args.input && args.inputFile) throw usageError("Use either --input or --input-file, not both.");
  if (args.inputFile) return parseJson(await readFile(resolve(args.cwd, args.inputFile), "utf8"), `--input-file ${args.inputFile}`);
  if (args.input) return parseJson(args.input, "--input");
  return args.defaultValue ?? {};
}

export function parseJson(text: string, label: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw usageError(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
