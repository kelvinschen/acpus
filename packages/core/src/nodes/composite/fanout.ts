import { valueToExprIR } from "../../expressions/expr.js";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify } from "../../internal/type-utils.js";
import { templateToIR, type Template } from "../../template/template.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, FanoutNodeIR } from "../../ir/types.js";
import type { OutputValues } from "../../graph/scope.js";
import type { ArrayItem, BuildScope, FanoutScopeContext, FanoutStrategy, ObjectSchema, SchemaScopeOutput, WorkflowArrayValue } from "./shared.js";

type BaseFanoutStepSpec<Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema> = {
  over: Over;
  key?: Template | string | ((ctx: Pick<FanoutScopeContext<ArrayItem<Over>>, "item" | "itemIndex">) => Template | string);
  maxConcurrency?: number;
  do: (ctx: FanoutScopeContext<ArrayItem<Over>>) => OutputValues<SchemaScopeOutput<OutSchema>>;
  itemOutputSchema: OutSchema;
};

export type FanoutStepSpec<
  Over extends WorkflowArrayValue<any> = WorkflowArrayValue<any>,
  OutSchema extends ObjectSchema = ObjectSchema,
  Strategy extends FanoutStrategy = FanoutStrategy,
> = Strategy extends "quorum"
  ? Simplify<BaseFanoutStepSpec<Over, OutSchema> & { strategy: "quorum"; count: number }>
  : Simplify<BaseFanoutStepSpec<Over, OutSchema> & { strategy?: "all"; count?: never }>;

export type FanoutNodeRefOutput<
  OutSchema extends ObjectSchema,
  Strategy extends FanoutStrategy,
> = Strategy extends "quorum"
  ? { accepted: Array<InferSchema<OutSchema>>; completed: Array<InferSchema<OutSchema>> }
  : Array<InferSchema<OutSchema>>;

export function buildFanoutNode<
  Over extends WorkflowArrayValue<any>,
  OutSchema extends ObjectSchema,
  Strategy extends FanoutStrategy,
>(
  id: string,
  spec: FanoutStepSpec<Over, OutSchema, Strategy>,
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
    itemOutputSchema: toSchemaIR(spec.itemOutputSchema),
    do: buildScope<{ item: typeof item; itemIndex: typeof itemIndex }, SchemaScopeOutput<OutSchema>>(spec.do, {
      item,
      itemIndex,
    }),
  }) as FanoutNodeIR;
}
