import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, SwitchNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope } from "./shared.js";

export type SwitchStepSpec<OutSchema extends Schema<any> | undefined> = {
  cases: Array<{ when: unknown; then: ScopeCallback }>;
  otherwise?: ScopeCallback;
  output?: OutSchema;
};

export function buildSwitchNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: SwitchStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): SwitchNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "switch",
    cases: spec.cases.map(c => ({ when: valueToExprIR(c.when), then: buildScope(c.then) })),
    otherwise: spec.otherwise ? buildScope(spec.otherwise) : undefined,
    outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
  }) as SwitchNodeIR;
}
