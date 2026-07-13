import { valueToExprIR } from "@acpus/expression/ir";
import { stripUndefined } from "../../graph/lowering.js";
import type { Resolvable } from "@acpus/expression";
import type { IfNodeIR } from "../../ir/types.js";
import type { BuildScope, CheckedScopeCallback, RuntimeValueOf, ScopeCallback, ScopeOutput } from "./shared.js";

/** Authoring spec for a graph-level conditional branch. */
export type IfStepSpec<Then extends ScopeCallback = ScopeCallback, Else extends ScopeCallback = ScopeCallback> = {
  condition: Resolvable<boolean>;
  outputSchema?: never;
  then: Then & CheckedScopeCallback<NoInfer<Then>>;
  else: Else & CheckedScopeCallback<NoInfer<Else>>;
};

export type IfNodeRefOutput<Then extends ScopeCallback, Else extends ScopeCallback> =
  RuntimeValueOf<ScopeOutput<Then> | ScopeOutput<Else>>;

export function buildIfNode<Then extends ScopeCallback, Else extends ScopeCallback>(
  id: string,
  spec: IfStepSpec<Then, Else>,
  buildScope: BuildScope,
): IfNodeIR {
  return stripUndefined({
    id,
    kind: "if",
    condition: valueToExprIR(spec.condition),
    then: buildScope(spec.then),
    else: buildScope(spec.else),
  }) as IfNodeIR;
}
