import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { WorkflowValue } from "@acpus/expression";
import type { DiagnosticIR, IfNodeIR } from "../../ir/types.js";
import type { ScopeCallback, BuildScope, OutputObject } from "./shared.js";

/** Authoring spec for a graph-level conditional branch. */
export type IfStepSpec<Output extends OutputObject = OutputObject> = {
  condition: WorkflowValue<boolean>;
  outputSchema?: never;
  then: ScopeCallback<Output>;
  else: ScopeCallback<Output>;
};

export function buildIfNode<Output extends OutputObject>(
  id: string,
  spec: IfStepSpec<Output>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): IfNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "if",
    condition: valueToExprIR(spec.condition),
    then: buildScope<{}, Output>(spec.then),
    else: buildScope<{}, Output>(spec.else),
  }) as IfNodeIR;
}
