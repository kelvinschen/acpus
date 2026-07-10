import { valueToExprIR } from "@acpus/expression/ir";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { WorkflowValue } from "@acpus/expression";
import type { GraphOutputCheck, OutputValues } from "../../graph/scope.js";
import type { DiagnosticIR, LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext, OutputObject, RuntimeValueOf, WidenRuntimeValue } from "./shared.js";

type LoopState<Initial extends OutputObject> =
  WidenRuntimeValue<RuntimeValueOf<Initial>> extends infer State
    ? State extends OutputObject ? State : never
    : never;

type LoopTransition<State extends OutputObject> = {
  state: State;
  stop: boolean;
};

export type LoopTransitionOutput<Initial extends OutputObject> = OutputValues<LoopTransition<LoopState<Initial>>>;

type ExactTransition<Actual extends object> =
  Actual & Record<Exclude<keyof Actual, keyof LoopTransition<OutputObject>>, never>;

/** Authoring spec for a transition-style loop that always executes at least one iteration. */
export type LoopStepSpec<
  Initial extends OutputObject = OutputObject,
  Transition extends LoopTransitionOutput<Initial> = LoopTransitionOutput<Initial>,
> = {
  state: WorkflowValue<Initial> & GraphOutputCheck<NoInfer<Initial>>;
  do: (ctx: LoopScopeContext<LoopState<Initial>>) => ExactTransition<Transition>;
  outputSchema?: never;
};

export function buildLoopNode<Initial extends OutputObject, Transition extends LoopTransitionOutput<Initial> = LoopTransitionOutput<Initial>>(
  id: string,
  spec: LoopStepSpec<Initial, Transition>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): LoopNodeIR {
  assertStableId(id, diagnostics);
  const index = refExpr<number>(["loop", id, "index"]);
  const round = refExpr<number>(["loop", id, "round"]);
  const state = refExpr<LoopState<Initial>>(["loop", id, "state"]);
  return stripUndefined({
    id,
    kind: "loop",
    state: valueToExprIR(spec.state),
    do: buildScope<{ index: typeof index; round: typeof round; state: typeof state }, LoopTransition<LoopState<Initial>>>(spec.do as (ctx: { index: typeof index; round: typeof round; state: typeof state }) => OutputValues<LoopTransition<LoopState<Initial>>>, {
      index,
      round,
      state,
    }),
  }) as LoopNodeIR;
}
