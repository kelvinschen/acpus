import { valueToExprIR } from "@acpus/expression/ir";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type InferSchema } from "../../schema/index.js";
import type { WorkflowValue } from "@acpus/expression";
import type { OutputValues } from "../../graph/scope.js";
import type { DiagnosticIR, LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext, LoopStopContext, ObjectSchema, ScopeOutput } from "./shared.js";

export type LoopStepSpec<OutSchema extends ObjectSchema> = {
  maxIterations: number;
  do: (ctx: LoopScopeContext<ScopeOutput<InferSchema<OutSchema>>>) => OutputValues<ScopeOutput<InferSchema<OutSchema>>>;
  stopWhen: (ctx: LoopStopContext<ScopeOutput<InferSchema<OutSchema>>>) => WorkflowValue<boolean>;
  outputSchema: OutSchema;
  onExhausted?: "fail" | "returnLast";
};

export function buildLoopNode<OutSchema extends ObjectSchema>(
  id: string,
  spec: LoopStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): LoopNodeIR {
  assertStableId(id, diagnostics);
  const iter = refExpr<number>(["loop", id, "iter"]);
  const previous = refExpr<ScopeOutput<InferSchema<OutSchema>> | undefined>(["loop", id, "previous"]);
  const result = refExpr<ScopeOutput<InferSchema<OutSchema>>>(["loop", id, "result"]);
  return stripUndefined({
    id,
    kind: "loop",
    outputSchema: toSchemaIR(spec.outputSchema),
    maxIterations: spec.maxIterations,
    stopWhen: valueToExprIR(spec.stopWhen({ iter, result })),
    onExhausted: spec.onExhausted,
    do: buildScope<{ iter: typeof iter; previous: typeof previous }, ScopeOutput<InferSchema<OutSchema>>>(spec.do, {
      iter,
      previous,
    }),
  }) as LoopNodeIR;
}
