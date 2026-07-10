import { valueToExprIR } from "@acpus/expression/ir";
import type { Resolvable } from "@acpus/expression";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify } from "../../internal/type-utils.js";
import type { GraphOutputCheck, OutputValues } from "../../graph/scope.js";
import type { DiagnosticIR, FanoutNodeIR } from "../../ir/types.js";
import type { ArrayItem, BuildScope, FanoutScopeContext, FanoutStrategy, OutputObject, ResolvableArray, RuntimeValueOf } from "./shared.js";

type BaseFanoutStepSpec<Over extends ResolvableArray<any>, Output extends OutputObject> = {
  over: Over;
  maxConcurrency?: Resolvable<number>;
  do: (ctx: FanoutScopeContext<ArrayItem<Over>>) => OutputValues<Output> & GraphOutputCheck<NoInfer<Output>>;
  itemOutputSchema?: never;
};

/** Authoring spec for runtime fanout over a workflow array value. */
export type FanoutStepSpec<
  Over extends ResolvableArray<any> = ResolvableArray<any>,
  Output extends OutputObject = any,
  Strategy extends FanoutStrategy = FanoutStrategy,
> = Strategy extends "quorum"
  ? Simplify<BaseFanoutStepSpec<Over, Output> & { strategy: "quorum"; count: Resolvable<number> }>
  : Simplify<BaseFanoutStepSpec<Over, Output> & { strategy?: "all"; count?: never }>;

export type FanoutNodeRefOutput<
  Output extends OutputObject,
  Strategy extends FanoutStrategy,
> = Array<RuntimeValueOf<Output>>;

export function buildFanoutNode<
  Over extends ResolvableArray<any>,
  Output extends OutputObject,
  Strategy extends FanoutStrategy,
>(
  id: string,
  spec: FanoutStepSpec<Over, Output, Strategy>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): FanoutNodeIR {
  assertStableId(id, diagnostics);
  const item = refExpr<ArrayItem<Over>>(["fanout", id, "item"]);
  const itemIndex = refExpr<number>(["fanout", id, "itemIndex"]);
  return stripUndefined({
    id,
    kind: "fanout",
    over: valueToExprIR(spec.over),
    strategy: spec.strategy ?? "all",
    maxConcurrency: spec.maxConcurrency === undefined ? undefined : valueToExprIR(spec.maxConcurrency),
    count: (spec as { count?: Resolvable<number> }).count === undefined
      ? undefined
      : valueToExprIR((spec as { count: Resolvable<number> }).count),
    do: buildScope<{ item: typeof item; itemIndex: typeof itemIndex }, Output>(spec.do, {
      item,
      itemIndex,
    }),
  }) as FanoutNodeIR;
}
