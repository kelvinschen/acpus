import type { ExprIR, TemplateIR } from "./ir.js";
import { callbackSourceIssue } from "./internal/callback-source.js";
import { expressionOperatorSpec } from "./internal/operators.js";

export type ExpressionEvaluatorAdapter = {
  resolveRef(path: string[]): unknown;
};

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionEvaluationError";
  }
}

const MISSING = Symbol("acpus.expression.missing");
type Missing = typeof MISSING;

export function evaluateExpr(expr: ExprIR, adapter: ExpressionEvaluatorAdapter): unknown {
  const value = evaluate(expr, adapter);
  return value === MISSING ? undefined : value;
}

function evaluate(expr: ExprIR, adapter: ExpressionEvaluatorAdapter): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return resolvePath(adapter.resolveRef(expr.path), []);
    case "array":
      return expr.items.map(item => requirePresent("array", evaluate(item, adapter)));
    case "object":
      return Object.fromEntries(Object.entries(expr.fields).map(([key, value]) => [key, requirePresent("object", evaluate(value, adapter))]));
    case "template":
      return renderTemplate(expr.template, adapter);
    case "call":
      return evaluateCall(expr.fn, expr.args, adapter);
  }
}

export function renderTemplate(template: TemplateIR, adapter: ExpressionEvaluatorAdapter): string {
  return template.parts.map(part => part.kind === "text" ? part.value : formatTemplateValue(evaluate(part.expr, adapter))).join("");
}

function evaluateCall(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter): unknown {
  const spec = expressionOperatorSpec(fn);
  if (!spec) throw new ExpressionEvaluationError(`Unsupported expression operator: ${fn}.`);
  requireArity(fn, args, spec.arity);
  if (spec.callback) return evaluateCallback(fn, args, adapter, spec.callback.dependencyArgs, spec.callback.callbackSourceArg, spec.callback.callbackParamCount);
  switch (fn) {
    case "access":
      return getValue(evaluate(args[0]!, adapter), requirePresent(fn, evaluate(args[1]!, adapter)));
    default:
      throw new ExpressionEvaluationError(`Unsupported expression operator: ${fn}.`);
  }
}

function evaluateCallback(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, dependencyIndexes: readonly number[], callbackIndex: number, callbackParamCount: number): unknown {
  const callback = loadCallback(callbackSource(fn, args[callbackIndex]!), fn, callbackParamCount);
  const values = dependencyIndexes.map(index => cloneCallbackInput(fn, evaluateCallbackInput(args[index]!, adapter)));
  if (fn === "lift" && !isRecord(values[0])) throw new ExpressionEvaluationError(`lift(...) expected dependency object, got ${typeOf(values[0])}.`);
  return runCallback(fn, callback, values);
}

function evaluateCallbackInput(expr: ExprIR, adapter: ExpressionEvaluatorAdapter): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return missingToUndefined(resolvePath(adapter.resolveRef(expr.path), []));
    case "array":
      return expr.items.map(item => evaluateCallbackInput(item, adapter));
    case "object":
      return Object.fromEntries(Object.entries(expr.fields).map(([key, value]) => [key, evaluateCallbackInput(value, adapter)]));
    case "template":
    case "call":
      return missingToUndefined(evaluate(expr, adapter));
  }
}

function callbackSource(fn: string, expr: ExprIR): string {
  if (expr.kind === "literal" && typeof expr.value === "string") return expr.value;
  throw new ExpressionEvaluationError(`${fn}(...) expected callback source string.`);
}

function loadCallback(source: string, operator: string, expectedParams: number): (...args: unknown[]) => unknown {
  const issue = callbackSourceIssue(source, expectedParams);
  if (issue) throw new ExpressionEvaluationError(`${operator}(...) ${issue}`);
  try {
    const fn = Function(`"use strict";\nreturn (${source});`)();
    if (typeof fn !== "function") throw new ExpressionEvaluationError(`${operator}(...) source did not evaluate to a function.`);
    return fn as (...args: unknown[]) => unknown;
  } catch (error) {
    if (error instanceof ExpressionEvaluationError) throw error;
    throw new ExpressionEvaluationError(`${operator}(...) source could not be loaded: ${(error as Error).message}`);
  }
}

function runCallback(operator: string, callback: (...args: unknown[]) => unknown, args: unknown[]): unknown {
  try {
    const output = callback(...args);
    if (isThenable(output)) throw new ExpressionEvaluationError(`${operator}(...) callback must return synchronously.`);
    assertJsonCompatible(output, operator);
    return output;
  } catch (error) {
    if (error instanceof ExpressionEvaluationError) throw error;
    throw new ExpressionEvaluationError(`${operator}(...) callback threw: ${(error as Error).message}`);
  }
}

function cloneCallbackInput(operator: string, value: unknown): unknown {
  assertCallbackInputCompatible(value, operator);
  return cloneJsonLikeWithUndefined(value);
}

function formatTemplateValue(value: unknown): string {
  requirePresent("template", value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  assertJsonCompatible(value, "template");
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new ExpressionEvaluationError("Template expression value is not JSON-serializable.");
  return rendered;
}

function resolvePath(root: unknown, path: string[]): unknown {
  let value = normalizeMissing(root);
  for (const segment of path) value = getValue(value, segment);
  return value;
}

function getValue(target: unknown, key: unknown): unknown {
  if (target === MISSING) return MISSING;
  if ((Array.isArray(target) || typeof target === "string") && (typeof key === "number" || typeof key === "string")) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== String(key)) return MISSING;
    return normalizeMissing(target[index as keyof typeof target]);
  }
  if (isRecord(target) && typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key)) return normalizeMissing(target[key]);
  return MISSING;
}

function requireArity(fn: string, args: unknown[], arity: readonly number[]): void {
  if (!arity.includes(args.length)) throw new ExpressionEvaluationError(`${fn}(...) expected ${formatArity(arity)} args, got ${args.length}.`);
}

function requirePresent(fn: string, value: unknown): Exclude<unknown, Missing> {
  if (value === MISSING) throw new ExpressionEvaluationError(`${fn}(...) received missing value.`);
  return value as Exclude<unknown, Missing>;
}

function isThenable(value: unknown): boolean {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function");
}

function normalizeMissing(value: unknown): unknown {
  return value === undefined ? MISSING : value;
}

function missingToUndefined(value: unknown): unknown {
  if (value === MISSING) return undefined;
  if (Array.isArray(value)) return value.map(missingToUndefined);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, missingToUndefined(item)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  return value === MISSING ? "missing" : Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function assertJsonCompatible(value: unknown, operator: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  }
  if (!value || typeof value !== "object") throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  if (seen.has(value)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
      assertJsonCompatible(value[index], operator, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  for (const item of Object.values(value)) {
    if (item === undefined) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
    assertJsonCompatible(item, operator, seen);
  }
  seen.delete(value);
}

function assertCallbackInputCompatible(value: unknown, operator: string, seen = new Set<object>()): void {
  if (value === undefined) return;
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  }
  if (!value || typeof value !== "object") throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  if (seen.has(value)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
      assertCallbackInputCompatible(value[index], operator, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  for (const item of Object.values(value)) assertCallbackInputCompatible(item, operator, seen);
  seen.delete(value);
}

function cloneJsonLikeWithUndefined(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(cloneJsonLikeWithUndefined);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonLikeWithUndefined(item)]));
  return value;
}

function formatArity(arity: readonly number[]): string {
  return arity.length === 1 ? String(arity[0]) : arity.join(" or ");
}
