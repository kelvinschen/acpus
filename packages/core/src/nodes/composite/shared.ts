import type { Expr, Resolvable } from "@acpus/expression";
import type { ExprValue } from "../../graph/refs.js";
import type { GraphOutputCheck } from "../../graph/scope.js";
import type { ScopeIR } from "../../ir/types.js";
export type ScopeCallback<Output = unknown> = () => Output;
export type ScopeOutput<Callback extends (...args: any[]) => unknown> =
  ReturnType<Callback> & GraphOutputCheck<ReturnType<Callback>>;
export type CheckedScopeCallback<Callback extends (...args: any[]) => unknown> =
  (...args: Parameters<Callback>) => ReturnType<Callback>
    & (unknown extends ReturnType<NoInfer<Callback>> ? never
        : GraphOutputCheck<ReturnType<NoInfer<Callback>>>);
export type BuildScope = <Extra extends object = {}>(
  fn: (ctx: Extra) => unknown,
  extra?: Extra,
) => ScopeIR;

export type ParallelStrategy = "all" | "race";
export type FanoutStrategy = "all" | "quorum";
export type ResolvableArray<Item> = Resolvable<readonly Item[]>;
export type RuntimeValueOf<T> =
  T extends Expr<infer Value> ? Value
    : T extends readonly (infer Item)[] ? RuntimeValueOf<Item>[]
      : T extends object ? { readonly [K in keyof T]: RuntimeValueOf<T[K]> }
        : T;
export type ArrayItem<Over> =
  Over extends Expr<readonly (infer Item)[]> ? Item
    : Over extends readonly (infer Value)[] ? RuntimeValueOf<Value>
      : never;

export type FanoutScopeContext<Item = any> = {
  item: ExprValue<Item>;
  itemIndex: Expr<number>;
};

export type LoopScopeContext<Output> = {
  index: Expr<number>;
  round: Expr<number>;
  state: ExprValue<Output>;
};
