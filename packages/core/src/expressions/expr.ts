import { EXPR } from "../internal/symbols.js";
import type { IsAny } from "../internal/type-utils.js";
import type { ExprIR, TypeIR } from "../ir/types.js";

export interface Expr<T> {
  readonly [EXPR]: true;
  readonly __type?: T;
  readonly ir: ExprIR;
}

export type WorkflowPrimitive = string | number | boolean | null;
export type AnyWorkflowValue =
  | Expr<any>
  | WorkflowPrimitive
  | readonly AnyWorkflowValue[]
  | { readonly [key: string]: AnyWorkflowValue };

type WorkflowLiteralValue<T> =
  T extends undefined
    ? never
    : T extends WorkflowPrimitive
      ? T
      : T extends readonly (infer Item)[]
      ? readonly WorkflowValue<Item>[]
      : T extends object
        ? { readonly [K in keyof T]: WorkflowValue<T[K]> }
        : never;

export type WorkflowValue<T = any> = IsAny<T> extends true
  ? AnyWorkflowValue
  : Expr<T> | WorkflowLiteralValue<T>;

class ExprImpl<T> implements Expr<T> {
  readonly [EXPR] = true as const;
  readonly __type?: T;
  constructor(readonly ir: ExprIR) {}
}

export function isExpr(value: unknown): value is Expr<any> {
  return Boolean(value && typeof value === "object" && (value as any)[EXPR]);
}

export function expr<T>(ir: ExprIR): Expr<T> {
  return new ExprImpl<T>(ir);
}

export function valueToExprIR(value: unknown): ExprIR {
  if (isExpr(value)) return value.ir;
  if (Array.isArray(value)) return { kind: "array", items: value.map(valueToExprIR) };
  if (value && typeof value === "object") {
    const fields: Record<string, ExprIR> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) fields[key] = valueToExprIR(item);
    return { kind: "object", fields };
  }
  return { kind: "literal", value };
}

export function call<T>(fn: string, args: unknown[], type?: TypeIR): Expr<T> {
  return expr<T>(type === undefined ? { kind: "call", fn, args: args.map(valueToExprIR) } : { kind: "call", fn, args: args.map(valueToExprIR), type });
}
