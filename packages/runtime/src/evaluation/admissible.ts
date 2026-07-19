import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";

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
): Result<JsonValue | undefined, WorkflowDataFailure> {
  return normalizeValue(value, "$", new Set(), options.allowTopLevelUndefined === true, label);
}

export function normalizeWorkflowData(value: unknown, label: string, options: { allowTopLevelUndefined?: boolean } = {}): JsonValue | undefined {
  const normalized = tryNormalizeWorkflowData(value, label, options);
  if (normalized.isErr()) throw new Error(normalized.error.message);
  return normalized.value;
}

function normalizeValue(
  value: unknown,
  path: string,
  seen: Set<object>,
  allowUndefined: boolean,
  label: string,
): Result<JsonValue | undefined, WorkflowDataFailure> {
  if (value === undefined) {
    return allowUndefined ? ok(undefined) : invalid(label, path, "undefined", `${path} is undefined`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(value);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? ok(value)
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
      if (item.isErr()) {
        seen.delete(value);
        return err(item.error);
      }
      normalized.push(item.value as JsonValue);
    }
    seen.delete(value);
    return ok(normalized);
  }
  if (typeof value !== "object") return invalid(label, path, "unsupported-type", `${path} is ${typeof value}`);
  if (seen.has(value)) return invalid(label, path, "cyclic", `${path} is cyclic`);
  if (!isPlainObject(value)) return invalid(label, path, "non-plain-object", `${path} is ${objectKind(value)}`);
  seen.add(value);
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const child = normalizeValue(item, `${path}.${key}`, seen, false, label);
    if (child.isErr()) {
      seen.delete(value);
      return err(child.error);
    }
    Object.defineProperty(normalized, key, {
      value: child.value as JsonValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return ok(normalized);
}

function invalid(
  label: string,
  path: string,
  reason: WorkflowDataFailure["reason"],
  detail: string,
): Result<never, WorkflowDataFailure> {
  return err({
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
