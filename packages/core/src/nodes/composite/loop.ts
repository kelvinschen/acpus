import { valueToExprIR } from "../../expressions/expr.js";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type InferSchema } from "../../schema/index.js";
import type { WorkflowValue } from "../../expressions/expr.js";
import type { ScopeIdentity } from "../../graph/scope.js";
import type { DiagnosticIR, LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext, LoopStopContext, ObjectSchema, ScopeOutput } from "./shared.js";

export type LoopStepSpec<OutSchema extends ObjectSchema, AgentKey extends string = string> = {
  maxIterations: number;
  do: <Scope extends ScopeIdentity>(ctx: LoopScopeContext<ScopeOutput<InferSchema<OutSchema>>, AgentKey, Scope>) => ReturnType<LoopScopeContext<ScopeOutput<InferSchema<OutSchema>>, AgentKey, Scope>["output"]>;
  stopWhen: (ctx: LoopStopContext<ScopeOutput<InferSchema<OutSchema>>>) => WorkflowValue<boolean>;
  outputSchema: OutSchema;
  onExhausted?: "fail" | "returnLast";
};

export function buildLoopNode<OutSchema extends ObjectSchema, AgentKey extends string = string>(
  id: string,
  spec: LoopStepSpec<OutSchema, AgentKey>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope<AgentKey>,
): LoopNodeIR {
  assertStableId(id, diagnostics);
  const iter = refExpr<number>(["loop", id, "iter"]);
  const previous = refExpr<ScopeOutput<InferSchema<OutSchema>> | undefined>(["loop", id, "previous"]);
  const result = refExpr<ScopeOutput<InferSchema<OutSchema>>>(["loop", id, "result"]);
  return stripUndefined({
    id,
    kind: "loop",
    maxIterations: spec.maxIterations,
    do: buildScope<{ iter: typeof iter; previous: typeof previous }, ScopeOutput<InferSchema<OutSchema>>>(spec.do, {
      iter,
      previous,
    }),
    stopWhen: valueToExprIR(spec.stopWhen({ iter, result })),
    outputSchema: toSchemaIR(spec.outputSchema),
    onExhausted: spec.onExhausted,
  }) as LoopNodeIR;
}
