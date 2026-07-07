import { valueToExprIR } from "@acpus/expression/ir";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { WorkflowValue } from "@acpus/expression";
import type { OutputValues } from "../../graph/scope.js";
import type { DiagnosticIR, LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext, LoopStopContext, OutputObject, RuntimeValueOf, WidenRuntimeValue } from "./shared.js";

type LoopState<Initial extends OutputObject> =
  WidenRuntimeValue<RuntimeValueOf<Initial>> extends infer State
    ? State extends OutputObject ? State : never
    : never;

/** Authoring spec for a seeded pre-check loop with a bounded iteration count. */
export type LoopStepSpec<Initial extends OutputObject = OutputObject> = {
  initial: WorkflowValue<Initial>;
  maxIterations: WorkflowValue<number>;
  do: (ctx: LoopScopeContext<LoopState<Initial>>) => OutputValues<LoopState<Initial>>;
  stopWhen?: (ctx: LoopStopContext<LoopState<Initial>>) => WorkflowValue<boolean>;
  outputSchema?: never;
  onExhausted?: "fail" | "returnLast";
};

export function buildLoopNode<Initial extends OutputObject>(
  id: string,
  spec: LoopStepSpec<Initial>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): LoopNodeIR {
  assertStableId(id, diagnostics);
  const iter = refExpr<number>(["loop", id, "iter"]);
  const previous = refExpr<LoopState<Initial>>(["loop", id, "previous"]);
  const result = refExpr<LoopState<Initial>>(["loop", id, "result"]);
  return stripUndefined({
    id,
    kind: "loop",
    initial: valueToExprIR(spec.initial),
    maxIterations: valueToExprIR(spec.maxIterations),
    stopWhen: spec.stopWhen ? valueToExprIR(spec.stopWhen({ iter, result })) : { kind: "literal", value: false },
    onExhausted: spec.onExhausted,
    do: buildScope<{ iter: typeof iter; previous: typeof previous }, LoopState<Initial>>(spec.do, {
      iter,
      previous,
    }),
  }) as LoopNodeIR;
}
