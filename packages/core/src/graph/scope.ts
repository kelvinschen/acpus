import type { Expr, Resolvable } from "@acpus/expression";
import { bindingsToIR } from "./lowering.js";
import type { NodeRef } from "./refs.js";
import type { NodeIR, ScopeIR } from "../ir/types.js";

export type OutputValues<T extends object> = {
  [K in keyof T]: Resolvable<T[K]>;
};

type DurableOutput<T, AllowUndefined extends boolean, AllowExpr extends boolean> =
  unknown extends T ? never
      : T extends NodeRef<any> ? never
      : T extends undefined ? AllowUndefined extends true ? undefined : never
        : T extends string | number | boolean | null ? T
          : T extends Expr<infer Value> ? AllowExpr extends true
            ? [Value] extends [DurableOutput<Value, true, false>] ? T : never
            : never
            : T extends (...args: any[]) => any ? never
              : T extends abstract new (...args: any[]) => any ? never
                : T extends readonly (infer Item)[] ? readonly DurableOutput<Item, false, AllowExpr>[]
                  : T extends object ? { readonly [K in keyof T]: DurableOutput<T[K], AllowUndefined, AllowExpr> }
                    : never;

type OutputCheck<T, AllowUndefined extends boolean, AllowExpr extends boolean> =
  [T] extends [DurableOutput<T, AllowUndefined, AllowExpr>] ? unknown : never;

export type GraphOutputCheck<T> =
  [T] extends [Expr<any> | NodeRef<any>] ? never
    : [T] extends [Record<string, unknown>] ? OutputCheck<T, false, true> : never;
export type TaskOutputCheck<T> = OutputCheck<T, true, false>;

type ScopeBuildState = {
  readonly nodes: NodeIR[];
};

export function buildImplicitScope<Extra extends object>(
  child: ScopeBuildState,
  fn: (ctx: Extra) => Record<string, unknown>,
  extra: Extra,
): ScopeIR {
  return { nodes: child.nodes, outputs: bindingsToIR(fn(extra)) };
}
