import { NODE_REF } from "../internal/symbols.js";
import type { ExprValue } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

export type NodeRef<Out> = {
  readonly [NODE_REF]: true;
  readonly id: string;
  readonly output: ExprValue<Out>;
};
export { refExpr, type ExprValue };

export function makeNodeRef<Out>(id: string): NodeRef<Out> {
  return {
    [NODE_REF]: true as const,
    id,
    output: refExpr<Out>(["nodes", id, "output"]),
  };
}
