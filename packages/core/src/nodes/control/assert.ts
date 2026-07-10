import { type Resolvable } from "@acpus/expression";
import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { AssertNodeIR, DiagnosticIR } from "../../ir/types.js";

/** Authoring spec for an Assert node that fails when `condition` is false. */
export type AssertSpec = {
  condition: Resolvable<boolean>;
  message?: Resolvable<string>;
};

export function buildAssertNode(id: string, spec: AssertSpec, diagnostics: DiagnosticIR[]): AssertNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "assert",
    condition: valueToExprIR(spec.condition),
    message: spec.message === undefined ? undefined : valueToExprIR(spec.message),
  }) as AssertNodeIR;
}
