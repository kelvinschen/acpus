import type { AgentOverrideMap } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { usageError } from "../errors.js";

export function parseAgents(raw: string | undefined): AgentOverrideMap | undefined {
  if (raw === undefined) return undefined;
  const value = parseJsonOption(raw, "--agents");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("--agents must be a JSON object.");
  return value as AgentOverrideMap;
}

export function parseInput(raw: string | undefined): JsonValue {
  if (raw === undefined) return {};
  return parseJsonOption(raw, "--input");
}

export function parseRequiredPayload(raw: string | undefined): JsonValue {
  if (raw === undefined) throw usageError("--payload is required.");
  return parseJsonOption(raw, "--payload");
}

export function parseJsonOption(raw: string, name: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonValue(value)) throw usageError(`${name} must be JSON-serializable.`);
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(isJsonValue));
}
