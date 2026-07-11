import { isExpr, valueToExprIR } from "@acpus/expression/ir";
import type { DiagnosticIR, ExprIR } from "../ir/types.js";
import type { EnvInput, StaticEnvInput } from "../nodes/leaf/shared.js";

export function bindingsToIR(bindings?: Record<string, unknown>): Record<string, ExprIR> {
  const result: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(bindings ?? {})) {
    result[key] = valueToExprIR(value);
  }
  return result;
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

export function assertStableId(id: string, diagnostics: DiagnosticIR[]): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
    diagnostics.push({
      code: "ID001",
      severity: "error",
      message: `Invalid node id '${id}'. Use /^[A-Za-z_][A-Za-z0-9_-]*$/.`,
      hint: "Node ids must be compile-time stable strings. Runtime Expr values are not allowed in node ids.",
    });
  }
}
