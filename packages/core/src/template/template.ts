import { TEMPLATE } from "../internal/symbols.js";
import type { TemplateIR, TemplatePartIR } from "../ir/types.js";
import { valueToExprIR } from "../expressions/expr.js";

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

function makeTemplate(strings: TemplateStringsArray, values: unknown[]): Template {
  const parts: TemplatePartIR[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    const literal = strings[i] ?? "";
    if (literal) parts.push({ kind: "text", value: literal });
    if (i < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[i]) });
  }
  return new TemplateImpl({ kind: "template", parts });
}

export function template(strings: TemplateStringsArray, ...values: unknown[]): Template {
  return makeTemplate(strings, values);
}

export function templateToIR(value: Template | string): TemplateIR {
  if (isTemplate(value)) return value.ir;
  return { kind: "template", parts: [{ kind: "text", value }] };
}
