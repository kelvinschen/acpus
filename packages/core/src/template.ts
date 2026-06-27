import { TEMPLATE } from "./internal.js";
import type { ExprIR, TemplateIR, TemplatePartIR } from "./ir.js";
import { isExpr, valueToExprIR } from "./expr.js";

export type TemplateFormat = "markdown" | "text" | "json";

export interface Template {
  readonly [TEMPLATE]: true;
  readonly ir: TemplateIR;
}

class TemplateImpl implements Template {
  readonly [TEMPLATE] = true as const;
  constructor(readonly ir: TemplateIR) {}
}

export function isTemplate(value: unknown): value is Template {
  return Boolean(value && typeof value === "object" && (value as any)[TEMPLATE]);
}

function makeTemplate(format: TemplateFormat, strings: TemplateStringsArray, values: unknown[]): Template {
  const parts: TemplatePartIR[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    const literal = strings[i] ?? "";
    if (literal) parts.push({ kind: "text", value: literal });
    if (i < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[i]), renderAs: inferRender(values[i]) });
  }
  return new TemplateImpl({ kind: "template", format, parts });
}

function inferRender(value: unknown): "text" | "json" | "artifact" {
  if (isExpr(value) && value.ir.kind === "call" && value.ir.fn === "json") return "json";
  return "text";
}

export function md(strings: TemplateStringsArray, ...values: unknown[]): Template {
  return makeTemplate("markdown", strings, values);
}

export function text(strings: TemplateStringsArray, ...values: unknown[]): Template {
  return makeTemplate("text", strings, values);
}

export function jsonTemplate(value: unknown): Template {
  const expr: ExprIR = valueToExprIR(value);
  return new TemplateImpl({ kind: "template", format: "json", parts: [{ kind: "expr", expr, renderAs: "json" }] });
}

export function templateToIR(value: Template | string): TemplateIR {
  if (isTemplate(value)) return value.ir;
  return { kind: "template", format: "text", parts: [{ kind: "text", value }] };
}
