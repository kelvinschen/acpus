import { isExpr, valueToExprIR } from "@acpus/expression/ir";
import { NODE_REF } from "../internal/symbols.js";
import type { ExprIR } from "../ir/types.js";
import type { EnvInput, StaticEnvInput } from "../nodes/leaf/shared.js";

export function bindingsToIR(bindings: Record<string, unknown>): Record<string, ExprIR> {
  if (!isPlainObject(bindings) || isExpr(bindings) || isNodeRef(bindings)) {
    throw new Error("Expression bindings must be plain objects.");
  }
  assertNoNodeRef(bindings);
  return (valueToExprIR(bindings) as Extract<ExprIR, { kind: "object" }>).fields;
}

export function outputToIR(value: unknown): ExprIR {
  assertNoNodeRef(value);
  return valueToExprIR(value);
}

export function envToIR(env: EnvInput): Record<string, ExprIR>;
export function envToIR(env?: EnvInput): Record<string, ExprIR> | undefined;
export function envToIR(env?: EnvInput): Record<string, ExprIR> | undefined {
  if (!env) return undefined;
  const out: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(env)) out[key] = valueToExprIR(value);
  return out;
}

export function staticEnvToIR(env?: StaticEnvInput): Record<string, string> | undefined {
  if (!env) return undefined;
  return { ...env };
}

export function stripUndefined<T>(value: T): T {
  if (isExpr(value)) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = stripUndefined(item);
    }
    return out as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoNodeRef(value: unknown): void {
  if (!value || typeof value !== "object" || isExpr(value)) return;
  if (isNodeRef(value)) {
    throw new Error("NodeRef cannot be lowered as durable data; return node.output instead.");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoNodeRef(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertNoNodeRef(item);
  }
}

function isNodeRef(value: object): boolean {
  return Boolean((value as { [NODE_REF]?: unknown })[NODE_REF]);
}
