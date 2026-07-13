import { type Resolvable } from "@acpus/expression";
import { valueToExprIR } from "@acpus/expression/ir";
import { stripUndefined } from "../../graph/lowering.js";
import type { AssertNodeIR } from "../../ir/types.js";

/** Authoring spec for an Assert node that fails when `condition` is false. */
export type AssertSpec = {
  condition: Resolvable<boolean>;
  message?: Resolvable<string>;
};

export function buildAssertNode(id: string, spec: AssertSpec): AssertNodeIR {
  return stripUndefined({
    id,
    kind: "assert",
    condition: valueToExprIR(spec.condition),
    message: spec.message === undefined ? undefined : valueToExprIR(spec.message),
  }) as AssertNodeIR;
}
