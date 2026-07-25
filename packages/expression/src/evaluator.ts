import { isJsonValue, type ExprIR, type TemplateIR } from "./ir.js";
import { callbackSourceIssue } from "./internal/callback-source.js";
import { expressionCallbackLayout, expressionOperatorSpec } from "./internal/operators.js";

export type ExpressionEvaluatorAdapter = {
  resolveRef(path: string[]): unknown;
  formatTemplateValue?(value: unknown): string | undefined;
};

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionEvaluationError";
  }
}

class SerializedFunctionTypeError extends TypeError {}

export function loadSerializedFunction(source: string): (...args: unknown[]) => unknown {
  const value: unknown = Function(`"use strict";
const __name = (target, _name) => target;
return (${source});`)();
  if (typeof value !== "function") throw new SerializedFunctionTypeError("Serialized source did not evaluate to a function.");
  return value as (...args: unknown[]) => unknown;
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
    case "object": {
      const fields: Array<[string, unknown]> = [];
      for (const [key, value] of Object.entries(expr.fields)) {
        const evaluated = evaluate(value, adapter);
        if (evaluated !== MISSING) fields.push([key, evaluated]);
      }
      return Object.fromEntries(fields);
    }
    case "template":
      return renderTemplate(expr, adapter);
    case "call":
      return evaluateCall(expr.fn, expr.args, adapter);
  }
}

export function renderTemplate(template: TemplateIR, adapter: ExpressionEvaluatorAdapter): string {
  return template.parts.map(part => {
    if (part.kind === "text") return part.value;
    const value = evaluate(part.expr, adapter);
    assertTemplateValue(value);
    return adapter.formatTemplateValue?.(value) ?? formatTemplateValue(value);
  }).join("");
}

function evaluateCall(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter): unknown {
  const spec = expressionOperatorSpec(fn);
  if (!spec) throw new ExpressionEvaluationError(`Unsupported expression operator: ${fn}.`);
  requireArity(fn, args, spec.arity);
  const callback = expressionCallbackLayout(fn, args.length);
  if (callback) return evaluateCallback(fn, args, adapter, callback.dependencyArgs, callback.callbackSourceArg, callback.callbackParamCount);
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
    return loadSerializedFunction(source);
  } catch (error) {
    if (error instanceof SerializedFunctionTypeError) {
      throw new ExpressionEvaluationError(`${operator}(...) source did not evaluate to a function.`);
    }
    throw new ExpressionEvaluationError(`${operator}(...) source could not be loaded: ${causeMessage(error)}`);
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
    throw new ExpressionEvaluationError(`${operator}(...) callback threw: ${causeMessage(error)}`);
  }
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cloneCallbackInput(operator: string, value: unknown): unknown {
  try {
    assertCallbackInputCompatible(value, operator);
    return structuredClone(value);
  } catch (error) {
    if (error instanceof ExpressionEvaluationError) throw error;
    throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  }
}

function formatTemplateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new ExpressionEvaluationError("Template expression value is not JSON-serializable.");
  return rendered;
}

function assertTemplateValue(value: unknown): void {
  requirePresent("template", value);
  if (typeof value === "string" || typeof value === "boolean" || value === null) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  assertJsonCompatible(value, "template");
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
  return value === MISSING ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertJsonCompatible(value: unknown, operator: string): void {
  if (!isJsonValue(value)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
}

function assertCallbackInputCompatible(
  value: unknown,
  operator: string,
  visiting = new WeakSet<object>(),
  validated = new WeakSet<object>(),
): void {
  if (value === undefined) return;
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  }
  if (!value || typeof value !== "object") throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  if (validated.has(value)) return;
  if (visiting.has(value)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
        assertCallbackInputCompatible(value[index], operator, visiting, validated);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
      if (Object.getOwnPropertySymbols(value).length > 0) throw new ExpressionEvaluationError(`${operator}(...) expected JSON-compatible values.`);
      for (const item of Object.values(value)) assertCallbackInputCompatible(item, operator, visiting, validated);
    }
    validated.add(value);
  } finally {
    visiting.delete(value);
  }
}

function formatArity(arity: readonly number[]): string {
  return arity.length === 1 ? String(arity[0]) : arity.join(" or ");
}
