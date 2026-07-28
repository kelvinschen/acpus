import { isExpr, valueToExprIR } from "@acpus/expression/ir";
import { NODE_REF } from "../internal/symbols.js";
import type { ExprIR } from "../ir/types.js";
import type { EnvInput } from "../nodes/leaf/shared.js";

export function durableValueToIR(value: unknown): ExprIR {
  assertNoNodeRef(value);
  return valueToExprIR(value);
}

export function envToIR(env: EnvInput): Record<string, ExprIR>;
export function envToIR(env?: EnvInput): Record<string, ExprIR> | undefined;
export function envToIR(env?: EnvInput): Record<string, ExprIR> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, valueToExprIR(value)]),
  );
}

export function stripUndefined<T>(value: T): T {
  if (isExpr(value)) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    ) as T;
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
