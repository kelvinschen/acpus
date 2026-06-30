import { isExpr, type WorkflowValue } from "@acpus/expression";
import { valueToExprIR, type TemplateIR } from "@acpus/expression/ir";

export type TemplateInput = WorkflowValue<string>;

export function templateToIR(value: TemplateInput): TemplateIR {
  if (typeof value === "string") return { kind: "template", parts: [{ kind: "text", value }] };
  if (isExpr(value) && value.ir.kind === "template") return value.ir.template;
  return { kind: "template", parts: [{ kind: "expr", expr: valueToExprIR(value) }] };
}
