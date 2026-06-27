import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, IfNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope } from "./shared.js";

export type IfStepSpec<OutSchema extends Schema<any> | undefined> = {
  when: unknown;
  then: ScopeCallback;
  otherwise?: ScopeCallback;
  output?: OutSchema;
};

export function buildIfNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: IfStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): IfNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "if",
    when: valueToExprIR(spec.when),
    then: buildScope(spec.then),
    otherwise: spec.otherwise ? buildScope(spec.otherwise) : undefined,
    outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
  }) as IfNodeIR;
}
