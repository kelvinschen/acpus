import { valueToExprIR } from "../../expressions/expr.js";
import { refExpr } from "../../graph/refs.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type Template } from "../../template/template.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, FanoutNodeIR } from "../../ir/types.js";
import type { BuildScope, FanoutJoinMode, FanoutScopeContext } from "./shared.js";

export type FanoutStepSpec<OutSchema extends Schema<any> | undefined> = {
  over: unknown;
  item?: Schema<any>;
  key?: Template | string;
  maxConcurrency?: number;
  join?: FanoutJoinMode;
  quorum?: number;
  do: (ctx: FanoutScopeContext) => ReturnType<FanoutScopeContext["output"]>;
  output?: OutSchema;
};

export function buildFanoutNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: FanoutStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): FanoutNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "fanout",
    over: valueToExprIR(spec.over),
    itemSchema: spec.item ? toSchemaIR(spec.item) : undefined,
    key: spec.key ? templateToIR(spec.key) : undefined,
    do: buildScope(spec.do, {
      item: refExpr<any>(["fanout", id, "item"]),
      itemIndex: refExpr<number>(["fanout", id, "index"]),
    }),
    join: spec.join,
    maxConcurrency: spec.maxConcurrency,
    quorum: spec.quorum,
    outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
  }) as FanoutNodeIR;
}

export type FanoutNodeRefOutput<OutSchema extends Schema<any> | undefined> = OutSchema extends Schema<any> ? Array<InferSchema<OutSchema>> : unknown[];
