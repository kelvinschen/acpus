import { valueToExprIR } from "@acpus/expression/ir";
import { stripUndefined } from "../../graph/lowering.js";
import type { Resolvable } from "@acpus/expression";
import type { SwitchNodeIR } from "../../ir/types.js";
import type { BuildScope, CheckedScopeCallback, RuntimeValueOf, ScopeCallback, ScopeOutput } from "./shared.js";

type SwitchCase = { when: Resolvable<boolean>; then: ScopeCallback };
type CheckedSwitchCases<Cases extends ReadonlyArray<SwitchCase>> = {
  readonly [Index in keyof Cases]: Cases[Index] extends { then: infer Then extends ScopeCallback }
    ? Cases[Index] & { then: Then & CheckedScopeCallback<NoInfer<Then>> }
    : Cases[Index];
};

/** Authoring spec for selecting one branch from ordered cases plus a required default. */
export type SwitchStepSpec<
  Cases extends ReadonlyArray<SwitchCase> = ReadonlyArray<SwitchCase>,
  Default extends ScopeCallback = ScopeCallback,
> = {
  outputSchema?: never;
  cases: Cases & CheckedSwitchCases<NoInfer<Cases>>;
  default: Default & CheckedScopeCallback<NoInfer<Default>>;
};

type SwitchCaseOutput<Case> = Case extends { then: infer Then extends ScopeCallback } ? ScopeOutput<Then> : never;

export type SwitchNodeRefOutput<Cases extends ReadonlyArray<SwitchCase>, Default extends ScopeCallback> =
  RuntimeValueOf<SwitchCaseOutput<Cases[number]> | ScopeOutput<Default>>;

export function buildSwitchNode<Cases extends ReadonlyArray<SwitchCase>, Default extends ScopeCallback>(
  id: string,
  spec: SwitchStepSpec<Cases, Default>,
  buildScope: BuildScope,
): SwitchNodeIR {
  return stripUndefined({
    id,
    kind: "switch",
    cases: spec.cases.map(c => ({ when: valueToExprIR(c.when), then: buildScope(c.then) })),
    default: buildScope(spec.default),
  }) as SwitchNodeIR;
}
