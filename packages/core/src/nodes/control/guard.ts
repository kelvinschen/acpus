import { valueToExprIR } from "../../expressions/expr.js";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type Template } from "../../template/template.js";
import type { DiagnosticIR, GuardNodeIR } from "../../ir/types.js";

export type GuardSpec = {
  when: unknown;
  then?: "continue" | "fail" | "complete";
  otherwise: "continue" | "fail" | "complete";
  message?: Template | string;
};

export function buildGuardNode(id: string, spec: GuardSpec, diagnostics: DiagnosticIR[]): GuardNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "guard",
    when: valueToExprIR(spec.when),
    then: spec.then,
    otherwise: spec.otherwise,
    message: spec.message === undefined ? undefined : templateToIR(spec.message),
  }) as GuardNodeIR;
}
