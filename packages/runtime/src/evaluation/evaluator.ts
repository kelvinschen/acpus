import type { ExprIR, TemplateIR } from "@acpus/core/ir";

export type EvaluationScope = {
  input?: unknown;
  nodes?: Record<string, { status?: string; output?: unknown }>;
  runtime?: Record<string, unknown>;
  fanout?: Record<string, unknown>;
  loop?: Record<string, unknown>;
};

export function evaluateExpr(expr: ExprIR, scope: EvaluationScope): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return resolvePath(scope, expr.path);
    case "array":
      return expr.items.map(item => evaluateExpr(item, scope));
    case "object":
      return Object.fromEntries(Object.entries(expr.fields).map(([key, value]) => [key, evaluateExpr(value, scope)]));
    case "template":
      return renderTemplate(expr.template, scope);
    case "call":
      return evaluateCall(expr.fn, expr.args, scope);
  }
}

export function renderTemplate(template: TemplateIR, scope: EvaluationScope): string {
  return template.parts.map(part => part.kind === "text" ? part.value : formatTemplateValue(evaluateExpr(part.expr, scope))).join("");
}

function resolvePath(scope: EvaluationScope, path: string[]): unknown {
  const normalized = path[0] === "workflow" && path[1] === "input" ? ["input", ...path.slice(2)] : path;
  if (!["input", "nodes", "runtime", "fanout", "loop"].includes(normalized[0] ?? "")) {
    throw new Error(`Unsupported runtime ref root: ${path[0] ?? "(empty)"}.`);
  }
  let value: unknown = scope;
  for (const segment of normalized) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && /^\d+$/.test(segment)) {
      value = value[Number(segment)];
      continue;
    }
    if (typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function evaluateCall(fn: string, args: ExprIR[], scope: EvaluationScope): unknown {
  switch (fn) {
    case "not":
      requireArity(fn, args, 1);
      return !booleanArg(fn, evaluateExpr(args[0]!, scope));
    case "and": {
      const values = args.map(arg => booleanArg(fn, evaluateExpr(arg, scope)));
      return values.every(value => value);
    }
    case "or": {
      const values = args.map(arg => booleanArg(fn, evaluateExpr(arg, scope)));
      return values.some(value => value);
    }
    case "eq":
      requireArity(fn, args, 2);
      return Object.is(evaluateExpr(args[0]!, scope), evaluateExpr(args[1]!, scope));
    case "ne":
      requireArity(fn, args, 2);
      return !Object.is(evaluateExpr(args[0]!, scope), evaluateExpr(args[1]!, scope));
    case "lt":
      requireArity(fn, args, 2);
      return numberArg(fn, evaluateExpr(args[0]!, scope)) < numberArg(fn, evaluateExpr(args[1]!, scope));
    case "lte":
      requireArity(fn, args, 2);
      return numberArg(fn, evaluateExpr(args[0]!, scope)) <= numberArg(fn, evaluateExpr(args[1]!, scope));
    case "gt":
      requireArity(fn, args, 2);
      return numberArg(fn, evaluateExpr(args[0]!, scope)) > numberArg(fn, evaluateExpr(args[1]!, scope));
    case "gte":
      requireArity(fn, args, 2);
      return numberArg(fn, evaluateExpr(args[0]!, scope)) >= numberArg(fn, evaluateExpr(args[1]!, scope));
    case "len":
      requireArity(fn, args, 1);
      return lengthOf(evaluateExpr(args[0]!, scope));
    case "includes":
      requireArity(fn, args, 2);
      return includes(evaluateExpr(args[0]!, scope), evaluateExpr(args[1]!, scope));
    case "startsWith":
      requireArity(fn, args, 2);
      return stringArg(fn, evaluateExpr(args[0]!, scope)).startsWith(stringArg(fn, evaluateExpr(args[1]!, scope)));
    case "endsWith":
      requireArity(fn, args, 2);
      return stringArg(fn, evaluateExpr(args[0]!, scope)).endsWith(stringArg(fn, evaluateExpr(args[1]!, scope)));
    case "matches":
      requireArity(fn, args, 2);
      return new RegExp(stringArg(fn, evaluateExpr(args[1]!, scope))).test(stringArg(fn, evaluateExpr(args[0]!, scope)));
    case "coalesce":
      for (const arg of args) {
        const value = evaluateExpr(arg, scope);
        if (value !== null && value !== undefined) return value;
      }
      return undefined;
    case "all":
      requireArity(fn, args, 1);
      return arrayArg(fn, evaluateExpr(args[0]!, scope)).every(value => booleanArg(fn, value));
    case "any":
      requireArity(fn, args, 1);
      return arrayArg(fn, evaluateExpr(args[0]!, scope)).some(value => booleanArg(fn, value));
    case "max":
      requireArity(fn, args, 1);
      return Math.max(...arrayArg(fn, evaluateExpr(args[0]!, scope)).map(value => numberArg(fn, value)));
    case "min":
      requireArity(fn, args, 1);
      return Math.min(...arrayArg(fn, evaluateExpr(args[0]!, scope)).map(value => numberArg(fn, value)));
    default:
      throw new Error(`Unsupported runtime expression call: ${fn}`);
  }
}

function requireArity(fn: string, args: unknown[], count: number): void {
  if (args.length !== count) throw new Error(`${fn}(...) expected ${count} args, got ${args.length}.`);
}

function booleanArg(fn: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${fn}(...) expected boolean, got ${typeOf(value)}.`);
}

function lengthOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  throw new Error(`len(...) expected string or array, got ${typeOf(value)}.`);
}

function includes(collection: unknown, value: unknown): boolean {
  if (typeof collection === "string") return collection.includes(stringArg("includes", value));
  if (Array.isArray(collection)) return collection.some(item => Object.is(item, value));
  throw new Error(`includes(...) expected string or array, got ${typeOf(collection)}.`);
}

function arrayArg(fn: string, value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${fn}(...) expected array, got ${typeOf(value)}.`);
}

function numberArg(fn: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${fn}(...) expected number, got ${typeOf(value)}.`);
}

function stringArg(fn: string, value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error(`${fn}(...) expected string, got ${typeOf(value)}.`);
}

function formatTemplateValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return stableJson(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function typeOf(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
