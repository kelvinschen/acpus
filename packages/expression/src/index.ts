export type { Expr, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
import { accessor, callExpr, valueToExprIR } from "./internal/expr.js";
import type { Expr, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
import type { TemplatePartIR } from "./ir.js";

type LiftDependency = Resolvable<any>;
type Comparable = string | number | boolean | null;
type BooleanOperands = [
  Resolvable<boolean>,
  Resolvable<boolean>,
  ...Resolvable<boolean>[],
];
type IsAny<T> = unknown extends T
  ? [keyof T] extends [never] ? false : true
  : false;
type ResolvedExpressionValue<T> =
  T extends Expr<infer Value>
    ? Value
    : never;
type ResolvedDependency<T> =
  IsAny<T> extends true
    ? any
    : [T] extends [Expr<infer Value>]
      ? Value
      : [ResolvedExpressionValue<T>] extends [never]
        ? T extends Expr<infer Value>
          ? Value
          : [T] extends [WorkflowData]
            ? T
            : T extends readonly unknown[]
              ? { readonly [K in keyof T]: ResolvedDependency<T[K]> }
              : T extends (...args: any[]) => any
                ? T
                : T extends object
                  ? { readonly [K in keyof T]: ResolvedDependency<T[K]> }
                  : T
        : ResolvedExpressionValue<T>;
type NextDepth = [1, 2, 3, 4, 5, 6, 7, 8, 8];
type InvalidOrdinaryObjectShape<T> =
  T extends Expr<any>
    ? never
    : T extends readonly unknown[]
      ? never
      : T extends (...args: any[]) => any
        ? never
        : T extends object
          ? [Extract<keyof T, symbol>] extends [never]
            ? [object] extends [T]
              ? [string] extends [T] ? never : T
              : never
            : T
          : never;
type InvalidLiftDependency<T, Depth extends number = 0> =
  Depth extends 8
    ? never
    : [InvalidOrdinaryObjectShape<T>] extends [never]
      ? [T] extends [LiftDependency]
        ? never
        : T extends readonly (infer Item)[]
          ? InvalidLiftDependency<Item, NextDepth[Depth]>
          : T extends (...args: any[]) => any
            ? T
            : T extends object
              ? { [K in keyof T]-?: InvalidLiftDependency<{} extends Pick<T, K> ? Exclude<T[K], undefined> : T[K], NextDepth[Depth]> }[keyof T]
              : T
      : InvalidOrdinaryObjectShape<T>;
type ValidLiftDependency<T> =
  [T] extends [string | number | boolean | null]
    ? unknown
    : [InvalidLiftDependency<T>] extends [never] ? unknown : never;

type InvalidLiftResult<T> =
  IsAny<T> extends true
    ? unknown
    : unknown extends T
      ? unknown
      : undefined extends T
        ? unknown
        : [InvalidOrdinaryObjectShape<T>] extends [never]
          ? [T] extends [WorkflowData]
            ? never
            : T extends Expr<any>
              ? T
              : T extends string | number | boolean | null
                ? never
                : T extends (...args: any[]) => any
                  ? T
                  : T extends abstract new (...args: any[]) => any
                    ? T
                    : T extends readonly (infer Item)[]
                      ? InvalidLiftResult<Item>
                      : T extends object
                        ? {
                            [K in keyof T]-?: InvalidLiftResult<
                              {} extends Pick<T, K> ? Exclude<T[K], undefined> : T[K]
                            >
                          }[keyof T]
                        : T
          : InvalidOrdinaryObjectShape<T>;
type ValidLiftResult<T> =
  [InvalidLiftResult<T>] extends [never] ? unknown : never;
type LiftCallback<Args extends readonly unknown[], Result> =
  ((...args: Args) => Result)
  & ((...args: Args) => Result & ValidLiftResult<Result>);
type SafeLiftResult<Result> =
  ExprValue<Result>
  & ValidLiftResult<Result>
  & (IsAny<Result> extends true ? never : unknown);
type LiftFallbackValidation<Result> =
  IsAny<Result> extends true
    ? []
    : ValidLiftResult<Result> extends never
      ? [invalidLiftResult: never]
      : [];

// Authored-shape signatures preserve structured inference; Resolvable fallbacks keep generic wrappers reducible.
export function lift<const A, R>(
  value: A & ValidLiftDependency<A>,
  fn: LiftCallback<[value: ResolvedDependency<A>], R>,
): ExprValue<R>;
export function lift<A, R>(
  value: Resolvable<A>,
  fn: LiftCallback<[value: A], R>,
): ExprValue<R>;
export function lift<A, R extends WorkflowData>(
  value: Resolvable<A>,
  fn: (value: A) => R,
  ...invalidResult: LiftFallbackValidation<NoInfer<R>>
): SafeLiftResult<R>;
export function lift<const A, const B, R>(
  a: A & ValidLiftDependency<A>,
  b: B & ValidLiftDependency<B>,
  fn: LiftCallback<[a: ResolvedDependency<A>, b: ResolvedDependency<B>], R>,
): ExprValue<R>;
export function lift<A, B, R>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  fn: LiftCallback<[a: A, b: B], R>,
): ExprValue<R>;
export function lift<A, B, R extends WorkflowData>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  fn: (a: A, b: B) => R,
  ...invalidResult: LiftFallbackValidation<NoInfer<R>>
): SafeLiftResult<R>;
export function lift<const A, const B, const C, R>(
  a: A & ValidLiftDependency<A>,
  b: B & ValidLiftDependency<B>,
  c: C & ValidLiftDependency<C>,
  fn: LiftCallback<[a: ResolvedDependency<A>, b: ResolvedDependency<B>, c: ResolvedDependency<C>], R>,
): ExprValue<R>;
export function lift<A, B, C, R>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  c: Resolvable<C>,
  fn: LiftCallback<[a: A, b: B, c: C], R>,
): ExprValue<R>;
export function lift<A, B, C, R extends WorkflowData>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  c: Resolvable<C>,
  fn: (a: A, b: B, c: C) => R,
  ...invalidResult: LiftFallbackValidation<NoInfer<R>>
): SafeLiftResult<R>;
export function lift(...args: [...unknown[], (...dependencies: any[]) => unknown]): ExprValue<any> {
  const fn = args.at(-1) as (...dependencies: any[]) => unknown;
  return liftExpr(args.slice(0, -1), fn);
}

/** Compares two scalar workflow values with JavaScript strict equality. */
export function eq<T extends Comparable>(a: Resolvable<T>, b: Resolvable<T>): ExprValue<boolean> {
  return liftExpr([a, b], (left: T, right: T) => left === right);
}

/** Compares two scalar workflow values with JavaScript strict inequality. */
export function ne<T extends Comparable>(a: Resolvable<T>, b: Resolvable<T>): ExprValue<boolean> {
  return liftExpr([a, b], (left: T, right: T) => left !== right);
}

/** Checks whether the first workflow number is less than the second. */
export function lt(a: Resolvable<number>, b: Resolvable<number>): ExprValue<boolean> {
  return liftExpr([a, b], (left: number, right: number) => left < right);
}

/** Checks whether the first workflow number is less than or equal to the second. */
export function lte(a: Resolvable<number>, b: Resolvable<number>): ExprValue<boolean> {
  return liftExpr([a, b], (left: number, right: number) => left <= right);
}

/** Checks whether the first workflow number is greater than the second. */
export function gt(a: Resolvable<number>, b: Resolvable<number>): ExprValue<boolean> {
  return liftExpr([a, b], (left: number, right: number) => left > right);
}

/** Checks whether the first workflow number is greater than or equal to the second. */
export function gte(a: Resolvable<number>, b: Resolvable<number>): ExprValue<boolean> {
  return liftExpr([a, b], (left: number, right: number) => left >= right);
}

/** Negates a workflow boolean. */
export function not(value: Resolvable<boolean>): ExprValue<boolean> {
  return liftExpr([value], (value: boolean) => !value);
}

/** Checks whether every workflow boolean is true. Dependencies are evaluated eagerly. */
export function and(...values: BooleanOperands): ExprValue<boolean> {
  return liftExpr([values], (values: readonly boolean[]) => values.every(value => value));
}

/** Checks whether any workflow boolean is true. Dependencies are evaluated eagerly. */
export function or(...values: BooleanOperands): ExprValue<boolean> {
  return liftExpr([values], (values: readonly boolean[]) => values.some(value => value));
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

function liftExpr<R>(dependencies: readonly unknown[], fn: (...dependencies: any[]) => R): ExprValue<R> {
  return callExpr<R>("lift", [...dependencies, fn.toString()]);
}

function templateParts(strings: TemplateStringsArray, values: Resolvable<any>[]): TemplatePartIR[] {
  const parts: TemplatePartIR[] = [];
  strings.forEach((text, index) => {
    parts.push({ kind: "text", value: text });
    if (index < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[index]) });
  });
  return parts;
}

function templateExpr(parts: TemplatePartIR[]): ExprValue<string> {
  return accessor<string>({ kind: "template", parts });
}

function dedentTemplateParts(parts: TemplatePartIR[]): TemplatePartIR[] {
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

function trimBoundaryBlankLines(parts: TemplatePartIR[]): TemplatePartIR[] {
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

function findCommonIndent(parts: TemplatePartIR[]): number {
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
