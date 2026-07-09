import type { WorkflowValue } from "@acpus/expression";
import { isExpr, valueToExprIR, type TemplateIR } from "@acpus/expression/ir";

export type TemplateInput = WorkflowValue<string>;

export function templateToIR(value: TemplateInput): TemplateIR {
  if (typeof value === "string") return { kind: "template", parts: [{ kind: "text", value }] };
  if (isExpr(value) && value.__ir.kind === "template") return value.__ir.template;
  return { kind: "template", parts: [{ kind: "expr", expr: valueToExprIR(value) }] };
}
