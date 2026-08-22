import type { JsonValue } from "@acpus/expression/ir";
import * as Result from "effect/Result";

export type WorkflowDataFailure = {
  type: "workflow-data-invalid";
  label: string;
  path: string;
  reason: "undefined" | "non-finite-number" | "unsupported-type" | "cyclic" | "sparse-array-hole" | "non-plain-object";
  message: string;
};

export function tryNormalizeWorkflowData(
  value: unknown,
  label: string,
  options: { allowTopLevelUndefined?: boolean } = {},
): Result.Result<JsonValue | undefined, WorkflowDataFailure> {
  return normalizeValue(value, "$", new Set(), options.allowTopLevelUndefined === true, label);
}

export function normalizeWorkflowData(value: unknown, label: string, options: { allowTopLevelUndefined?: boolean } = {}): JsonValue | undefined {
  const normalized = tryNormalizeWorkflowData(value, label, options);
  if (Result.isFailure(normalized)) throw new Error(normalized.failure.message);
  return normalized.success;
}

function normalizeValue(
  value: unknown,
  path: string,
  seen: Set<object>,
  allowUndefined: boolean,
  label: string,
): Result.Result<JsonValue | undefined, WorkflowDataFailure> {
  if (value === undefined) {
    return allowUndefined ? Result.succeed(undefined) : invalid(label, path, "undefined", `${path} is undefined`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return Result.succeed(value);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Result.succeed(value)
      : invalid(label, path, "non-finite-number", `${path} is non-finite number`);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return invalid(label, path, "unsupported-type", `${path} is ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return invalid(label, path, "cyclic", `${path} is cyclic`);
    seen.add(value);
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        seen.delete(value);
        return invalid(label, itemPath, "sparse-array-hole", `${itemPath} is a sparse array hole`);
      }
      const item = normalizeValue(value[index], itemPath, seen, false, label);
      if (Result.isFailure(item)) {
        seen.delete(value);
        return Result.fail(item.failure);
      }
      normalized.push(item.success as JsonValue);
    }
    seen.delete(value);
    return Result.succeed(normalized);
  }
  if (typeof value !== "object") return invalid(label, path, "unsupported-type", `${path} is ${typeof value}`);
  if (seen.has(value)) return invalid(label, path, "cyclic", `${path} is cyclic`);
  if (!isPlainObject(value)) return invalid(label, path, "non-plain-object", `${path} is ${objectKind(value)}`);
  seen.add(value);
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const child = normalizeValue(item, `${path}.${key}`, seen, false, label);
    if (Result.isFailure(child)) {
      seen.delete(value);
      return Result.fail(child.failure);
    }
    Object.defineProperty(normalized, key, {
      value: child.success as JsonValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return Result.succeed(normalized);
}

function invalid(
  label: string,
  path: string,
  reason: WorkflowDataFailure["reason"],
  detail: string,
): Result.Result<never, WorkflowDataFailure> {
  return Result.fail({
    type: "workflow-data-invalid",
    label,
    path,
    reason,
    message: `${label} is not workflow-admissible: ${detail}.`,
  });
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectKind(value: object): string {
  const tag = Object.prototype.toString.call(value).slice("[object ".length, -1);
  return tag || "non-plain object";
}
