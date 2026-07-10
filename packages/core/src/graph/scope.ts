import type { Expr } from "@acpus/expression";
import type { IsAny } from "../internal/type-utils.js";
import { isExpr } from "@acpus/expression/ir";
import { bindingsToIR } from "./lowering.js";
import type { DiagnosticIR, NodeIR, ScopeIR } from "../ir/types.js";

type Primitive = string | number | boolean | null | undefined;

export type OutputValue<T> =
  | Expr<T>
  | (T extends Primitive
    ? T
    : T extends readonly (infer Item)[]
      ? readonly OutputValue<Item>[]
      : T extends object
        ? { readonly [K in keyof T]: OutputValue<T[K]> }
        : T);

export type OutputValues<T extends object> = {
  [K in keyof T]: OutputValue<T[K]>;
};

type DurableOutput<T, AllowUndefined extends boolean, AllowExpr extends boolean> =
  IsAny<T> extends true ? T
    : unknown extends T ? never
      : T extends undefined ? AllowUndefined extends true ? undefined : never
        : T extends string | number | boolean | null ? T
          : T extends Expr<infer Value> ? AllowExpr extends true
            ? [Value] extends [DurableOutput<Value, AllowUndefined, false>] ? T : never
            : never
            : T extends (...args: any[]) => any ? never
              : T extends abstract new (...args: any[]) => any ? never
                : T extends readonly (infer Item)[] ? readonly DurableOutput<Item, false, AllowExpr>[]
                  : T extends object ? { readonly [K in keyof T]: DurableOutput<T[K], true, AllowExpr> }
                    : never;

type OutputCheck<T, AllowUndefined extends boolean, AllowExpr extends boolean> =
  IsAny<T> extends true ? unknown
    : [T] extends [DurableOutput<T, AllowUndefined, AllowExpr>] ? unknown : never;

export type GraphOutputCheck<T> = OutputCheck<T, false, true>;
export type TaskOutputCheck<T> = OutputCheck<T, true, false>;

type ScopeBuildState = {
  readonly nodes: NodeIR[];
};

export function isOutputObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isExpr(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function buildImplicitScope<Extra extends object>(
  diagnostics: DiagnosticIR[],
  child: ScopeBuildState,
  fn: (ctx: Extra) => Record<string, unknown>,
  extra: Extra,
): ScopeIR {
  const result = fn(extra);
  if (!isOutputObject(result)) {
    diagnostics.push({
      code: "B001",
      severity: "error",
      message: "Composite scope must return an output object.",
      hint: "Return a plain object from the composite callback, for example return { result: value }.",
    });
    return { nodes: child.nodes };
  }
  return { nodes: child.nodes, outputs: bindingsToIR(result) };
}
