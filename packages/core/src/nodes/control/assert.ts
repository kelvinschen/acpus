import { type WorkflowValue } from "@acpus/expression";
import { valueToExprIR } from "@acpus/expression/ir";
import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type TemplateInput } from "../../template/template.js";
import type { AssertNodeIR, DiagnosticIR } from "../../ir/types.js";

export type AssertSpec = {
  condition: WorkflowValue<boolean>;
  message?: TemplateInput;
};

export function buildAssertNode(id: string, spec: AssertSpec, diagnostics: DiagnosticIR[]): AssertNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "assert",
    condition: valueToExprIR(spec.condition),
    message: spec.message === undefined ? undefined : templateToIR(spec.message),
  }) as AssertNodeIR;
}
