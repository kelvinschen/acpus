import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR } from "../../schema/index.js";
import type { WorkflowValue } from "../../expressions/expr.js";
import type { DiagnosticIR, SwitchNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, ObjectSchema, SchemaScopeOutput } from "./shared.js";

type SwitchStepSpecBase<OutSchema extends ObjectSchema | undefined, AgentKey extends string> = {
  cases: Array<{ when: WorkflowValue<boolean>; then: ScopeCallback<SchemaScopeOutput<OutSchema>, AgentKey> }>;
};

export type SwitchStepSpec<OutSchema extends ObjectSchema | undefined = ObjectSchema | undefined, AgentKey extends string = string> =
  OutSchema extends ObjectSchema
    ? SwitchStepSpecBase<OutSchema, AgentKey> & {
        outputSchema: OutSchema;
        default: ScopeCallback<SchemaScopeOutput<OutSchema>, AgentKey>;
      }
    : SwitchStepSpecBase<undefined, AgentKey> & {
        outputSchema?: undefined;
        default?: ScopeCallback<SchemaScopeOutput<undefined>, AgentKey>;
      };

export function buildSwitchNode<OutSchema extends ObjectSchema | undefined, AgentKey extends string = string>(
  id: string,
  spec: SwitchStepSpec<OutSchema, AgentKey>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope<AgentKey>,
): SwitchNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "switch",
    cases: spec.cases.map(c => ({ when: valueToExprIR(c.when), then: buildScope<{}, SchemaScopeOutput<OutSchema>>(c.then as any) })),
    default: spec.default ? buildScope<{}, SchemaScopeOutput<OutSchema>>(spec.default as any) : undefined,
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
  }) as SwitchNodeIR;
}
