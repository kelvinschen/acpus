import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR } from "../../schema/index.js";
import type { WorkflowValue } from "../../expressions/expr.js";
import type { DiagnosticIR, IfNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, ObjectSchema, SchemaScopeOutput } from "./shared.js";

type IfStepSpecBase<OutSchema extends ObjectSchema | undefined, AgentKey extends string> = {
  condition: WorkflowValue<boolean>;
  then: ScopeCallback<SchemaScopeOutput<OutSchema>, AgentKey>;
};

export type IfStepSpec<OutSchema extends ObjectSchema | undefined = ObjectSchema | undefined, AgentKey extends string = string> =
  OutSchema extends ObjectSchema
    ? IfStepSpecBase<OutSchema, AgentKey> & {
        outputSchema: OutSchema;
        else: ScopeCallback<SchemaScopeOutput<OutSchema>, AgentKey>;
      }
    : IfStepSpecBase<undefined, AgentKey> & {
        outputSchema?: undefined;
        else?: ScopeCallback<SchemaScopeOutput<undefined>, AgentKey>;
      };

export function buildIfNode<OutSchema extends ObjectSchema | undefined, AgentKey extends string = string>(
  id: string,
  spec: IfStepSpec<OutSchema, AgentKey>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope<AgentKey>,
): IfNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "if",
    condition: valueToExprIR(spec.condition),
    then: buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.then as any),
    else: spec.else ? buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.else as any) : undefined,
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
  }) as IfNodeIR;
}
