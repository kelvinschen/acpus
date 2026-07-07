import { valueToExprIR } from "@acpus/expression/ir";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify } from "../../internal/type-utils.js";
import { templateToIR, type TemplateInput } from "../../template/template.js";
import type { OutputValues } from "../../graph/scope.js";
import type { DiagnosticIR, FanoutNodeIR } from "../../ir/types.js";
import type { ArrayItem, BuildScope, FanoutScopeContext, FanoutStrategy, OutputObject, RuntimeValueOf, WorkflowArrayValue } from "./shared.js";

type BaseFanoutStepSpec<Over extends WorkflowArrayValue<any>, Output extends OutputObject> = {
  over: Over;
  key?: TemplateInput | ((ctx: Pick<FanoutScopeContext<ArrayItem<Over>>, "item" | "itemIndex">) => TemplateInput);
  maxConcurrency?: number;
  do: (ctx: FanoutScopeContext<ArrayItem<Over>>) => OutputValues<Output>;
  itemOutputSchema?: never;
};

/** Authoring spec for runtime fanout over a workflow array value. */
export type FanoutStepSpec<
  Over extends WorkflowArrayValue<any> = WorkflowArrayValue<any>,
  Output extends OutputObject = OutputObject,
  Strategy extends FanoutStrategy = FanoutStrategy,
> = Strategy extends "quorum"
  ? Simplify<BaseFanoutStepSpec<Over, Output> & { strategy: "quorum"; count: number }>
  : Simplify<BaseFanoutStepSpec<Over, Output> & { strategy?: "all"; count?: never }>;

export type FanoutNodeRefOutput<
  Output extends OutputObject,
  Strategy extends FanoutStrategy,
> = Array<RuntimeValueOf<Output>>;

export function buildFanoutNode<
  Over extends WorkflowArrayValue<any>,
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
  const key = typeof spec.key === "function" ? spec.key({ item, itemIndex }) : spec.key;
  return stripUndefined({
    id,
    kind: "fanout",
    over: valueToExprIR(spec.over),
    key: key ? templateToIR(key) : undefined,
    strategy: spec.strategy ?? "all",
    maxConcurrency: spec.maxConcurrency,
    count: (spec as { count?: number }).count,
    do: buildScope<{ item: typeof item; itemIndex: typeof itemIndex }, Output>(spec.do, {
      item,
      itemIndex,
    }),
  }) as FanoutNodeIR;
}
