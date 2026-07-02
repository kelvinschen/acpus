import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { WorkflowValue } from "@acpus/expression";
import type { DiagnosticIR, SwitchNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, RuntimeValueOf } from "./shared.js";

export type SwitchStepSpec = {
  outputSchema?: never;
  cases: ReadonlyArray<{ when: WorkflowValue<boolean>; then: ScopeCallback }>;
  default: ScopeCallback;
};

type SwitchCaseOutput<Case> = Case extends { then: (ctx: never) => infer Output } ? Output : never;

export type SwitchNodeRefOutput<Spec extends SwitchStepSpec> =
  Spec extends { cases: ReadonlyArray<infer Case>; default: (ctx: never) => infer DefaultOutput }
    ? RuntimeValueOf<SwitchCaseOutput<Case> | DefaultOutput>
    : never;

export function buildSwitchNode(
  id: string,
  spec: SwitchStepSpec,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): SwitchNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "switch",
    cases: spec.cases.map(c => ({ when: valueToExprIR(c.when), then: buildScope(c.then) })),
    default: buildScope(spec.default),
  }) as SwitchNodeIR;
}
