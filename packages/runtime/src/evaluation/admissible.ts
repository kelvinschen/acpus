import type { JsonValue } from "@acpus/expression/ir";

export function normalizeWorkflowData(value: unknown, label: string, options: { allowTopLevelUndefined?: boolean } = {}): JsonValue | undefined {
  try {
    return normalizeValue(value, "$", new Set(), options.allowTopLevelUndefined === true);
  } catch (error) {
    throw new Error(`${label} is not workflow-admissible: ${(error as Error).message}.`);
  }
}

function normalizeValue(value: unknown, path: string, seen: Set<object>, allowUndefined: boolean): JsonValue | undefined {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    throw new Error(`${path} is undefined`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`${path} is non-finite number`);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") throw new Error(`${path} is ${typeof value}`);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${path} is cyclic`);
    seen.add(value);
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${path}[${index}] is a sparse array hole`);
      normalized.push(normalizeValue(value[index], `${path}[${index}]`, seen, false) as JsonValue);
    }
    seen.delete(value);
    return normalized;
  }
  if (typeof value !== "object") throw new Error(`${path} is ${typeof value}`);
  if (seen.has(value)) throw new Error(`${path} is cyclic`);
  if (!isPlainObject(value)) throw new Error(`${path} is ${objectKind(value)}`);
  seen.add(value);
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    normalized[key] = normalizeValue(item, `${path}.${key}`, seen, false) as JsonValue;
  }
  seen.delete(value);
  return normalized;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectKind(value: object): string {
  const tag = Object.prototype.toString.call(value).slice("[object ".length, -1);
  return tag || "non-plain object";
}
