import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR } from "../../schema/index.js";
import type { WorkflowValue } from "@acpus/expression";
import type { DiagnosticIR, IfNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, ObjectSchema, SchemaScopeOutput } from "./shared.js";

type IfStepSpecBase<OutSchema extends ObjectSchema | undefined> = {
  condition: WorkflowValue<boolean>;
  then: ScopeCallback<SchemaScopeOutput<OutSchema>>;
};

export type IfStepSpec<OutSchema extends ObjectSchema | undefined = ObjectSchema | undefined> =
  OutSchema extends ObjectSchema
    ? IfStepSpecBase<OutSchema> & {
        outputSchema: OutSchema;
        else: ScopeCallback<SchemaScopeOutput<OutSchema>>;
      }
    : IfStepSpecBase<undefined> & {
        outputSchema?: undefined;
        else?: ScopeCallback<SchemaScopeOutput<undefined>>;
      };

export function buildIfNode<OutSchema extends ObjectSchema | undefined>(
  id: string,
  spec: IfStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): IfNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "if",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    condition: valueToExprIR(spec.condition),
    then: buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.then as any),
    else: spec.else ? buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.else as any) : undefined,
  }) as IfNodeIR;
}
