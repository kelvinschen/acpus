import { NODE_REF } from "../internal/symbols.js";
import type { Expr, ExprValue } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

declare const POISONED_OUTPUT: unique symbol;
type NodeOutput<Out> = [Out] extends [never]
  ? Expr<unknown> & { readonly [POISONED_OUTPUT]: true }
  : ExprValue<Out>;

export type NodeRef<Out> = {
  readonly [NODE_REF]: true;
  readonly id: string;
  readonly output: NodeOutput<Out>;
};
export { refExpr, type ExprValue };

export function makeNodeRef<Out>(id: string): NodeRef<Out> {
  return {
    [NODE_REF]: true as const,
    id,
    output: refExpr<Out>(["nodes", id, "output"]) as NodeOutput<Out>,
  };
}
