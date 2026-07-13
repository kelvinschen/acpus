import type { Resolvable } from "@acpus/expression";
import { valueToExprIR } from "@acpus/expression/ir";
import { refExpr } from "../../graph/refs.js";
import { stripUndefined } from "../../graph/lowering.js";
import type { GraphOutputCheck } from "../../graph/scope.js";
import type { LoopNodeIR } from "../../ir/types.js";
import type { BuildScope, LoopScopeContext, RuntimeValueOf } from "./shared.js";

type LoopState<Initial> = RuntimeValueOf<Initial>;

type LoopTransition<State> = {
  state: State;
  stop: boolean;
};

export type LoopTransitionOutput<Initial> = {
  [Key in keyof LoopTransition<LoopState<Initial>>]: Resolvable<LoopTransition<LoopState<Initial>>[Key]>;
};

type ExactTransition<Actual extends object> =
  Actual & Record<Exclude<keyof Actual, keyof LoopTransition<unknown>>, never>;

/** Authoring spec for a transition-style loop that always executes at least one iteration. */
export type LoopStepSpec<
  Initial = unknown,
  Transition extends LoopTransitionOutput<Initial> = LoopTransitionOutput<Initial>,
> = {
  state: Initial & GraphOutputCheck<NoInfer<Initial>>;
  do: (ctx: LoopScopeContext<LoopState<Initial>>) => ExactTransition<Transition> & GraphOutputCheck<NoInfer<Transition>>;
  outputSchema?: never;
};

export function buildLoopNode<Initial, Transition extends LoopTransitionOutput<Initial> = LoopTransitionOutput<Initial>>(
  id: string,
  spec: LoopStepSpec<Initial, Transition>,
  buildScope: BuildScope,
): LoopNodeIR {
  const index = refExpr<number>(["loop", id, "index"]);
  const round = refExpr<number>(["loop", id, "round"]);
  const state = refExpr<LoopState<Initial>>(["loop", id, "state"]);
  return stripUndefined({
    id,
    kind: "loop",
    state: valueToExprIR(spec.state),
    do: buildScope(spec.do, {
      index,
      round,
      state,
    }),
  }) as LoopNodeIR;
}
