import type { Expr, WorkflowValue } from "../../expressions/expr.js";
import type { OutputAccessor } from "../../graph/refs.js";
import type { ScopeContext, ScopeIdentity } from "../../graph/scope.js";
import type { ScopeIR } from "../../ir/types.js";
import type { InferSchema, Schema } from "../../schema/index.js";

export type ObjectSchema = Schema<Record<string, unknown>>;
export type ScopeOutput<Output> = Output extends object ? Output : Record<string, unknown>;
export type SchemaScopeOutput<OutSchema> = OutSchema extends ObjectSchema ? ScopeOutput<InferSchema<OutSchema>> : Record<string, unknown>;
export type ScopeCallback<Output extends object = Record<string, unknown>> =
  <Scope extends ScopeIdentity>(ctx: ScopeContext<Output, Scope>) => ReturnType<ScopeContext<Output, Scope>["output"]>;
export type BuildScope = <Extra extends object = {}, Output extends object = Record<string, unknown>>(
  fn: <Scope extends ScopeIdentity>(ctx: ScopeContext<Output, Scope> & Extra) => ReturnType<ScopeContext<Output, Scope>["output"]>,
  extra?: Extra,
) => ScopeIR;

export type ParallelStrategy = "all" | "race";
export type FanoutStrategy = "all" | "quorum";
export type WorkflowArrayValue<Item> = Expr<readonly Item[]> | readonly WorkflowValue<Item>[];
export type RuntimeValueOf<T> =
  T extends Expr<infer Value> ? Value
    : T extends readonly (infer Item)[] ? RuntimeValueOf<Item>[]
      : T extends object ? { readonly [K in keyof T]: RuntimeValueOf<T[K]> }
        : T;
export type ArrayItem<Over> =
  Over extends Expr<readonly (infer Item)[]> ? Item
    : Over extends readonly (infer Value)[] ? RuntimeValueOf<Value>
      : never;

export type FanoutScopeContext<Item = any, Output extends object = Record<string, unknown>, Scope = ScopeIdentity> = ScopeContext<Output, Scope> & {
  item: OutputAccessor<Item>;
  itemIndex: Expr<number>;
};

export type LoopScopeContext<Output extends object, Scope = ScopeIdentity> = ScopeContext<Output, Scope> & {
  iter: Expr<number>;
  previous: OutputAccessor<Output | undefined>;
};

export type LoopStopContext<Output> = {
  iter: Expr<number>;
  result: OutputAccessor<Output>;
};
