import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR } from "../../schema/index.js";
import type { WorkflowValue } from "../../expressions/expr.js";
import type { DiagnosticIR, SwitchNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, ObjectSchema, SchemaScopeOutput } from "./shared.js";

type SwitchStepSpecBase<OutSchema extends ObjectSchema | undefined> = {
  cases: Array<{ when: WorkflowValue<boolean>; then: ScopeCallback<SchemaScopeOutput<OutSchema>> }>;
};

export type SwitchStepSpec<OutSchema extends ObjectSchema | undefined = ObjectSchema | undefined> =
  OutSchema extends ObjectSchema
    ? SwitchStepSpecBase<OutSchema> & {
        outputSchema: OutSchema;
        default: ScopeCallback<SchemaScopeOutput<OutSchema>>;
      }
    : SwitchStepSpecBase<undefined> & {
        outputSchema?: undefined;
        default?: ScopeCallback<SchemaScopeOutput<undefined>>;
      };

export function buildSwitchNode<OutSchema extends ObjectSchema | undefined>(
  id: string,
  spec: SwitchStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): SwitchNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "switch",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    cases: spec.cases.map(c => ({ when: valueToExprIR(c.when), then: buildScope<{}, SchemaScopeOutput<OutSchema>>(c.then as any) })),
    default: spec.default ? buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.default as any) : undefined,
  }) as SwitchNodeIR;
}
