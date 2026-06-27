import { valueToExprIR } from "../../expressions/expr.js";
import { refExpr, makeNodeRef, type NodeRef } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext } from "./shared.js";

export type LoopStepSpec<OutSchema extends Schema<any>> = {
  maxIterations: number;
  do: (ctx: LoopScopeContext<InferSchema<OutSchema>>) => ReturnType<LoopScopeContext<InferSchema<OutSchema>>["output"]>;
  until: (ctx: { last: NodeRef<InferSchema<OutSchema>> }) => unknown;
  output: OutSchema;
  onMaxIterations?: "fail" | "complete";
};

export function buildLoopNode<OutSchema extends Schema<any>>(
  id: string,
  spec: LoopStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): LoopNodeIR {
  assertStableId(id, diagnostics);
  const lastRef = makeNodeRef<InferSchema<OutSchema>>(`${id}.__last`);
  return stripUndefined({
    id,
    kind: "loop",
    maxIterations: spec.maxIterations,
    do: buildScope(spec.do, {
      iter: refExpr<number>(["loop", id, "iter"]),
      last: lastRef,
    }),
    until: valueToExprIR(spec.until({ last: lastRef })),
    outputSchema: toSchemaIR(spec.output),
    onMaxIterations: spec.onMaxIterations,
  }) as LoopNodeIR;
}
