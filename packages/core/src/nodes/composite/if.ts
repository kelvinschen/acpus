import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { WorkflowValue } from "@acpus/expression";
import type { DiagnosticIR, IfNodeIR } from "../../ir/types.js";
import type { BuildScope, CheckedScopeCallback, RuntimeValueOf, ScopeCallback } from "./shared.js";

/** Authoring spec for a graph-level conditional branch. */
export type IfStepSpec<Then extends ScopeCallback = ScopeCallback, Else extends ScopeCallback = ScopeCallback> = {
  condition: WorkflowValue<boolean>;
  outputSchema?: never;
  then: Then & CheckedScopeCallback<NoInfer<Then>>;
  else: Else & CheckedScopeCallback<NoInfer<Else>>;
};

export type IfNodeRefOutput<Then extends ScopeCallback, Else extends ScopeCallback> =
  RuntimeValueOf<ReturnType<Then> | ReturnType<Else>>;

export function buildIfNode<Then extends ScopeCallback, Else extends ScopeCallback>(
  id: string,
  spec: IfStepSpec<Then, Else>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): IfNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "if",
    condition: valueToExprIR(spec.condition),
    then: buildScope(spec.then),
    else: buildScope(spec.else),
  }) as IfNodeIR;
}
