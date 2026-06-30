import type { ExprIR, JsonObject, TemplateIR } from "./ir.js";

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
type Env = Map<string, unknown>;

export function evaluateExpr(expr: ExprIR, adapter: ExpressionEvaluatorAdapter): unknown {
  const value = evaluate(expr, adapter, new Map());
  return value === MISSING ? undefined : value;
}

function evaluate(expr: ExprIR, adapter: ExpressionEvaluatorAdapter, env: Env): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return normalizeMissing(adapter.resolveRef(expr.path));
    case "var":
      return resolveVar(expr, env);
    case "array":
      return expr.items.map(item => requirePresent("array", evaluate(item, adapter, env)));
    case "object":
      return Object.fromEntries(Object.entries(expr.fields).map(([key, value]) => [key, requirePresent("object", evaluate(value, adapter, env))]));
    case "template":
      return renderTemplateWithEnv(expr.template, adapter, env);
    case "call":
      return evaluateCall(expr.fn, expr.args, adapter, env);
    case "lambda":
      throw new ExpressionEvaluationError(`Cannot evaluate ${expr.kind} expression directly.`);
  }
}

export function renderTemplate(template: TemplateIR, adapter: ExpressionEvaluatorAdapter): string {
  return renderTemplateWithEnv(template, adapter, new Map());
}

function renderTemplateWithEnv(template: TemplateIR, adapter: ExpressionEvaluatorAdapter, env: Env): string {
  return template.parts.map(part => part.kind === "text" ? part.value : formatTemplateValue(evaluate(part.expr, adapter, env))).join("");
}

function evaluateCall(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env): unknown {
  switch (fn) {
    case "not":
      requireArity(fn, args, 1);
      return !booleanArg(fn, evaluate(args[0]!, adapter, env));
    case "and":
      for (const arg of args) if (!booleanArg(fn, evaluate(arg, adapter, env))) return false;
      return true;
    case "or":
      for (const arg of args) if (booleanArg(fn, evaluate(arg, adapter, env))) return true;
      return false;
    case "ifElse":
      requireArity(fn, args, 3);
      return evaluate(booleanArg(fn, evaluate(args[0]!, adapter, env)) ? args[1]! : args[2]!, adapter, env);
    case "eq":
      requireArity(fn, args, 2);
      return structuralEqual(requirePresent(fn, evaluate(args[0]!, adapter, env)), requirePresent(fn, evaluate(args[1]!, adapter, env)));
    case "ne":
      requireArity(fn, args, 2);
      return !structuralEqual(requirePresent(fn, evaluate(args[0]!, adapter, env)), requirePresent(fn, evaluate(args[1]!, adapter, env)));
    case "lt": return compare(fn, args, adapter, env, (left, right) => left < right);
    case "lte": return compare(fn, args, adapter, env, (left, right) => left <= right);
    case "gt": return compare(fn, args, adapter, env, (left, right) => left > right);
    case "gte": return compare(fn, args, adapter, env, (left, right) => left >= right);
    case "len":
      requireArity(fn, args, 1);
      return lengthOf(evaluate(args[0]!, adapter, env));
    case "includes":
      requireArity(fn, args, 2);
      return includes(evaluate(args[0]!, adapter, env), requirePresent(fn, evaluate(args[1]!, adapter, env)));
    case "startsWith":
      requireArity(fn, args, 2);
      return stringArg(fn, evaluate(args[0]!, adapter, env)).startsWith(stringArg(fn, evaluate(args[1]!, adapter, env)));
    case "endsWith":
      requireArity(fn, args, 2);
      return stringArg(fn, evaluate(args[0]!, adapter, env)).endsWith(stringArg(fn, evaluate(args[1]!, adapter, env)));
    case "matches":
      requireArity(fn, args, 2);
      return matches(stringArg(fn, evaluate(args[0]!, adapter, env)), stringArg(fn, evaluate(args[1]!, adapter, env)));
    case "coalesce":
      if (args.length === 0) throw new ExpressionEvaluationError("coalesce(...) expected at least 1 args, got 0.");
      for (const arg of args) {
        const value = evaluate(arg, adapter, env);
        if (value !== MISSING && value !== null) return value;
      }
      return MISSING;
    case "get":
      requireArity(fn, args, 2);
      return getValue(evaluate(args[0]!, adapter, env), requirePresent(fn, evaluate(args[1]!, adapter, env)));
    case "map":
      return evaluateMap(fn, args, adapter, env);
    case "filter":
      return evaluateFilter(fn, args, adapter, env);
    case "all":
      return args.length === 1 ? arrayArg(fn, evaluate(args[0]!, adapter, env)).every(value => booleanArg(fn, value)) : evaluateQuantifier(fn, args, adapter, env, false);
    case "any":
      return args.length === 1 ? arrayArg(fn, evaluate(args[0]!, adapter, env)).some(value => booleanArg(fn, value)) : evaluateQuantifier(fn, args, adapter, env, true);
    case "max":
      requireArity(fn, args, 1);
      return Math.max(...arrayArg(fn, evaluate(args[0]!, adapter, env)).map(value => numberArg(fn, value)));
    case "min":
      requireArity(fn, args, 1);
      return Math.min(...arrayArg(fn, evaluate(args[0]!, adapter, env)).map(value => numberArg(fn, value)));
    default:
      throw new ExpressionEvaluationError(`Unsupported expression operator: ${fn}.`);
  }
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

function structuralEqual(left: unknown, right: unknown): boolean {
  assertJsonCompatible(left, "eq");
  assertJsonCompatible(right, "eq");
  if (sameValueZero(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => structuralEqual(item, right[index]));
  }
  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightObject, key) && structuralEqual(leftObject[key], rightObject[key]));
}

function sameValueZero(left: unknown, right: unknown): boolean {
  return left === right || (typeof left === "number" && typeof right === "number" && Number.isNaN(left) && Number.isNaN(right));
}

function resolveVar(expr: Extract<ExprIR, { kind: "var" }>, env: Env): unknown {
  if (!env.has(expr.id)) throw new ExpressionEvaluationError(`Unbound expression variable: ${expr.id}.`);
  return resolvePath(env.get(expr.id), expr.path);
}

function resolvePath(root: unknown, path: string[]): unknown {
  let value = normalizeMissing(root);
  for (const segment of path) value = getValue(value, segment);
  return value;
}

function getValue(target: unknown, key: unknown): unknown {
  if (target === MISSING) return MISSING;
  if (Array.isArray(target) && (typeof key === "number" || typeof key === "string")) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== String(key)) return MISSING;
    return normalizeMissing(target[index]);
  }
  if (isRecord(target) && typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key)) return normalizeMissing(target[key]);
  if (target === null) return MISSING;
  return MISSING;
}

function evaluateMap(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env): unknown[] {
  const [array, lambda] = collectionArgs(fn, args, adapter, env);
  return array.map((value, index) => requirePresent(fn, evaluateLambda(lambda, [value, index], adapter, env)));
}

function evaluateFilter(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env): unknown[] {
  const [array, lambda] = collectionArgs(fn, args, adapter, env);
  return array.filter((value, index) => booleanArg(fn, evaluateLambda(lambda, [value, index], adapter, env)));
}

function evaluateQuantifier(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env, some: boolean): boolean {
  const [array, lambda] = collectionArgs(fn, args, adapter, env);
  return some
    ? array.some((value, index) => booleanArg(fn, evaluateLambda(lambda, [value, index], adapter, env)))
    : array.every((value, index) => booleanArg(fn, evaluateLambda(lambda, [value, index], adapter, env)));
}

function collectionArgs(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env): [unknown[], Extract<ExprIR, { kind: "lambda" }>] {
  requireArity(fn, args, 2);
  const lambda = args[1]!;
  if (lambda.kind !== "lambda") throw new ExpressionEvaluationError(`${fn}(...) expected lambda callback.`);
  return [arrayArg(fn, evaluate(args[0]!, adapter, env)), lambda];
}

function evaluateLambda(lambda: Extract<ExprIR, { kind: "lambda" }>, values: unknown[], adapter: ExpressionEvaluatorAdapter, env: Env): unknown {
  const next = new Map(env);
  lambda.params.forEach((param, index) => next.set(param.id, values[index]));
  return evaluate(lambda.body, adapter, next);
}

function compare(fn: string, args: ExprIR[], adapter: ExpressionEvaluatorAdapter, env: Env, compareValues: (left: number, right: number) => boolean): boolean {
  requireArity(fn, args, 2);
  return compareValues(numberArg(fn, evaluate(args[0]!, adapter, env)), numberArg(fn, evaluate(args[1]!, adapter, env)));
}

function includes(collection: unknown, value: unknown): boolean {
  const present = requirePresent("includes", collection);
  if (typeof present === "string") return present.includes(stringArg("includes", value));
  if (Array.isArray(present)) return present.some(item => structuralEqual(item, value));
  throw new ExpressionEvaluationError(`includes(...) expected string or array, got ${typeOf(present)}.`);
}

function matches(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch (cause) {
    throw new ExpressionEvaluationError(`matches(...) received invalid regular expression: ${(cause as Error).message}`);
  }
}

function lengthOf(value: unknown): number {
  const present = requirePresent("len", value);
  if (typeof present === "string" || Array.isArray(present)) return present.length;
  throw new ExpressionEvaluationError(`len(...) expected string or array, got ${typeOf(present)}.`);
}

function booleanArg(fn: string, value: unknown): boolean {
  const present = requirePresent(fn, value);
  if (typeof present === "boolean") return present;
  throw new ExpressionEvaluationError(`${fn}(...) expected boolean, got ${typeOf(present)}.`);
}

function numberArg(fn: string, value: unknown): number {
  const present = requirePresent(fn, value);
  if (typeof present === "number") return present;
  throw new ExpressionEvaluationError(`${fn}(...) expected number, got ${typeOf(present)}.`);
}

function stringArg(fn: string, value: unknown): string {
  const present = requirePresent(fn, value);
  if (typeof present === "string") return present;
  throw new ExpressionEvaluationError(`${fn}(...) expected string, got ${typeOf(present)}.`);
}

function arrayArg(fn: string, value: unknown): unknown[] {
  const present = requirePresent(fn, value);
  if (Array.isArray(present)) return present;
  throw new ExpressionEvaluationError(`${fn}(...) expected array, got ${typeOf(present)}.`);
}

function requireArity(fn: string, args: unknown[], count: number): void {
  if (args.length !== count) throw new ExpressionEvaluationError(`${fn}(...) expected ${count} args, got ${args.length}.`);
}

function requirePresent(fn: string, value: unknown): Exclude<unknown, Missing> {
  if (value === MISSING) throw new ExpressionEvaluationError(`${fn}(...) received missing value.`);
  return value as Exclude<unknown, Missing>;
}

function normalizeMissing(value: unknown): unknown {
  return value === undefined ? MISSING : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  return value === MISSING ? "missing" : Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function assertJsonCompatible(value: unknown, operator: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
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
