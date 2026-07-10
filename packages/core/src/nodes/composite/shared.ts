import type { Expr, Resolvable } from "@acpus/expression";
import type { ExprValue } from "../../graph/refs.js";
import type { GraphOutputCheck, OutputValues } from "../../graph/scope.js";
import type { IsUnion } from "../../internal/type-utils.js";
import type { ScopeIR } from "../../ir/types.js";
export type OutputObject = Record<string, unknown>;
export type ScopeCallback<Output extends OutputObject = any> =
  () => OutputValues<Output>;
export type CheckedScopeCallback<Callback extends (...args: any[]) => OutputObject> =
  Callback & ((...args: Parameters<Callback>) => ReturnType<Callback> & GraphOutputCheck<NoInfer<ReturnType<Callback>>>);
export type BuildScope = <Extra extends object = {}, Output extends OutputObject = OutputObject>(
  fn: (ctx: Extra) => OutputValues<Output>,
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
type WidenLiteral<T> =
  [T] extends [string] ? string extends T ? T : IsUnion<T> extends true ? T : string
    : [T] extends [number] ? number extends T ? T : IsUnion<T> extends true ? T : number
      : [T] extends [boolean] ? boolean extends T ? T : IsUnion<T> extends true ? T : boolean
        : T;

export type WidenRuntimeValue<T> =
  [T] extends [string | number | boolean] ? WidenLiteral<T>
        : T extends readonly (infer Item)[] ? WidenRuntimeValue<Item>[]
          : T extends object ? { [K in keyof T]: WidenRuntimeValue<T[K]> }
            : T;
export type ArrayItem<Over> =
  Over extends Expr<readonly (infer Item)[]> ? Item
    : Over extends readonly (infer Value)[] ? RuntimeValueOf<Value>
      : never;

export type FanoutScopeContext<Item = any> = {
  item: ExprValue<Item>;
  itemIndex: Expr<number>;
};

export type LoopScopeContext<Output extends OutputObject> = {
  index: Expr<number>;
  round: Expr<number>;
  state: ExprValue<Output>;
};
