import type { Expr } from "../../expressions/expr.js";
import type { NodeRef } from "../../graph/refs.js";
import type { OutputToken, ScopeContext } from "../../graph/scope.js";
import type { ScopeIR } from "../../ir/types.js";

export type ScopeCallback = (ctx: ScopeContext) => OutputToken<any>;
export type BuildScope = <Extra extends object = {}>(fn: (ctx: ScopeContext & Extra) => OutputToken<any>, extra?: Extra) => ScopeIR;
export type JoinMode = "all" | "race";
export type FanoutJoinMode = JoinMode | "quorum";

export type FanoutScopeContext = ScopeContext & {
  item: Expr<any>;
  itemIndex: Expr<number>;
};

export type LoopScopeContext<Output> = ScopeContext & {
  iter: Expr<number>;
  last: NodeRef<Output>;
};
