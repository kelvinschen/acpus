import { valueToExprIR } from "../../expressions/expr.js";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify } from "../../internal/type-utils.js";
import { templateToIR, type Template } from "../../template/template.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, FanoutNodeIR } from "../../ir/types.js";
import type { ScopeIdentity } from "../../graph/scope.js";
import type { ArrayItem, BuildScope, FanoutScopeContext, FanoutStrategy, ObjectSchema, SchemaScopeOutput, WorkflowArrayValue } from "./shared.js";

type BaseFanoutStepSpec<Over extends WorkflowArrayValue<any>, OutSchema extends ObjectSchema, AgentKey extends string = string> = {
  over: Over;
  key?: Template | string | ((ctx: Pick<FanoutScopeContext<ArrayItem<Over>, Record<string, unknown>, AgentKey>, "item" | "itemIndex">) => Template | string);
  maxConcurrency?: number;
  do: <Scope extends ScopeIdentity>(ctx: FanoutScopeContext<ArrayItem<Over>, SchemaScopeOutput<OutSchema>, AgentKey, Scope>) => ReturnType<FanoutScopeContext<ArrayItem<Over>, SchemaScopeOutput<OutSchema>, AgentKey, Scope>["output"]>;
  itemOutputSchema: OutSchema;
};

export type FanoutStepSpec<
  Over extends WorkflowArrayValue<any> = WorkflowArrayValue<any>,
  OutSchema extends ObjectSchema = ObjectSchema,
  Strategy extends FanoutStrategy = FanoutStrategy,
  AgentKey extends string = string,
> = Strategy extends "quorum"
  ? Simplify<BaseFanoutStepSpec<Over, OutSchema, AgentKey> & { strategy: "quorum"; count: number }>
  : Simplify<BaseFanoutStepSpec<Over, OutSchema, AgentKey> & { strategy?: "all"; count?: never }>;

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
  AgentKey extends string = string,
>(
  id: string,
  spec: FanoutStepSpec<Over, OutSchema, Strategy, AgentKey>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope<AgentKey>,
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
