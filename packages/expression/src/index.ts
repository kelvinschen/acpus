export type { Expr, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
import { accessor, callExpr, valueToExprIR } from "./internal/expr.js";
import type { Expr, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
import type { ExprIR } from "./ir.js";

type TemplatePart = { kind: "text"; value: string } | { kind: "expr"; expr: ExprIR };
type LiftDeps = { readonly [key: string]: Resolvable<any> };
type ResolvedResolvable<T> =
  T extends undefined
    ? undefined
    : T extends Expr<infer Value>
    ? Value
    : T extends readonly (infer Item)[]
      ? readonly ResolvedResolvable<Item>[]
      : T extends object
        ? { readonly [K in keyof T]: ResolvedResolvable<T[K]> }
        : T;
type ResolvedLiftDeps<Deps extends LiftDeps> = {
  readonly [K in keyof Deps]: ResolvedResolvable<Deps[K]>;
};

export function fmap<A, R extends WorkflowData>(
  value: Resolvable<A>,
  fn: (value: A) => R,
): ExprValue<R> {
  return callExpr<R>("fmap", [value, fn.toString()]);
}

export function lift2<A, B, R extends WorkflowData>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  fn: (a: A, b: B) => R,
): ExprValue<R> {
  return callExpr<R>("lift2", [a, b, fn.toString()]);
}

export function lift3<A, B, C, R extends WorkflowData>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  c: Resolvable<C>,
  fn: (a: A, b: B, c: C) => R,
): ExprValue<R> {
  return callExpr<R>("lift3", [a, b, c, fn.toString()]);
}

export function lift<const Deps extends LiftDeps, R extends WorkflowData>(
  deps: Deps,
  fn: (deps: ResolvedLiftDeps<Deps>) => R,
): ExprValue<R> {
  assertPlainDeps(deps);
  return callExpr<R>("lift", [deps, fn.toString()]);
}

/**
 * Builds an exact string template expression and preserves authored whitespace.
 * Use `md` for multiline Markdown prompts that should be dedented.
 */
export function template(strings: TemplateStringsArray, ...values: Resolvable<any>[]): ExprValue<string> {
  return templateExpr(templateParts(strings, values));
}

/**
 * Builds a multiline Markdown template for prompts and messages.
 * Unlike `template`, this helper removes surrounding blank lines and common indentation.
 */
export function md(strings: TemplateStringsArray, ...values: Resolvable<any>[]): ExprValue<string> {
  return templateExpr(dedentTemplateParts(templateParts(strings, values)));
}

function assertPlainDeps(deps: unknown): void {
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) throw new Error("lift(deps, fn) requires a plain object dependency map.");
  const prototype = Object.getPrototypeOf(deps);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("lift(deps, fn) requires a plain object dependency map.");
}

function templateParts(strings: TemplateStringsArray, values: Resolvable<any>[]): TemplatePart[] {
  const parts: TemplatePart[] = [];
  strings.forEach((text, index) => {
    parts.push({ kind: "text", value: text });
    if (index < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[index]) });
  });
  return parts;
}

function templateExpr(parts: TemplatePart[]): ExprValue<string> {
  return accessor<string>({ kind: "template", template: { kind: "template", parts } });
}

function dedentTemplateParts(parts: TemplatePart[]): TemplatePart[] {
  const trimmed = trimBoundaryBlankLines(parts);
  const commonIndent = findCommonIndent(trimmed);
  if (commonIndent === 0) return trimmed;
  let atLineStart = true;
  let remainingIndent = commonIndent;
  return trimmed.map(part => {
    if (part.kind === "expr") {
      atLineStart = false;
      return part;
    }
    let value = "";
    for (const char of part.value) {
      if (char === "\n") {
        value += char;
        atLineStart = true;
        remainingIndent = commonIndent;
        continue;
      }
      if (atLineStart && remainingIndent > 0 && (char === " " || char === "\t")) {
        remainingIndent--;
        continue;
      }
      value += char;
      if (char !== " " && char !== "\t") atLineStart = false;
    }
    return { kind: "text", value };
  });
}

function trimBoundaryBlankLines(parts: TemplatePart[]): TemplatePart[] {
  const trimmed = parts.map(part => part.kind === "text" ? { ...part } : part);
  const firstText = trimmed.find(part => part.kind === "text");
  if (firstText?.kind === "text") firstText.value = firstText.value.replace(/^(?:[ \t]*\r?\n)+/, "");
  for (let index = trimmed.length - 1; index >= 0; index--) {
    const part = trimmed[index];
    if (part?.kind === "text") {
      part.value = part.value.replace(/(?:\r?\n[ \t]*)+$/, "");
      break;
    }
  }
  return trimmed;
}

function findCommonIndent(parts: TemplatePart[]): number {
  const indents: number[] = [];
  let atLineStart = true;
  let indent = 0;
  let lineHasContent = false;
  for (const part of parts) {
    if (part.kind === "expr") {
      lineHasContent = true;
      atLineStart = false;
      continue;
    }
    for (const char of part.value) {
      if (char === "\n") {
        if (lineHasContent) indents.push(indent);
        atLineStart = true;
        indent = 0;
        lineHasContent = false;
        continue;
      }
      if (atLineStart && (char === " " || char === "\t")) {
        indent++;
        continue;
      }
      lineHasContent = true;
      atLineStart = false;
    }
  }
  if (lineHasContent) indents.push(indent);
  return indents.length === 0 ? 0 : Math.min(...indents);
}
