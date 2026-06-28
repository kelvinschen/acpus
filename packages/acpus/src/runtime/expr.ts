import type { ExprIR, JsonValue, TemplateIR } from "@acpus/core";

export type EvalNodeMap = Record<string, { output: unknown }>;

export type EvalRuntimeContext = {
  input: unknown;
  nodes: EvalNodeMap;
  runtime: {
    runId: string;
    nodeId?: string;
    workspaceDir: string;
    outputDir: string;
  };
  fanout: Record<string, { item: unknown; itemIndex: number }>;
  loop: Record<string, { iter: number; previous?: unknown; result?: unknown }>;
};

export function evalExpr(expr: ExprIR, context: EvalRuntimeContext): unknown {
  switch (expr.kind) {
    case "literal": return expr.value;
    case "ref": return getPath(context, expr.path);
    case "array": return expr.items.map(item => evalExpr(item, context));
    case "object": return Object.fromEntries(Object.entries(expr.fields).map(([key, value]) => [key, evalExpr(value, context)]));
    case "template": return renderTemplate(expr.template, context);
    case "call": return evalCall(expr.fn, expr.args.map(arg => evalExpr(arg, context)));
    default: return assertNever(expr);
  }
}

export function evalObjectExprs(values: Record<string, ExprIR>, context: EvalRuntimeContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, evalExpr(value, context)]));
}

export function renderTemplate(template: TemplateIR, context: EvalRuntimeContext): string {
  return template.parts.map(part => {
    if (part.kind === "text") return part.value;
    return formatTemplateValue(evalExpr(part.expr, context));
  }).join("");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function toJsonValue(value: unknown): JsonValue {
  return sortJson(value) as JsonValue;
}

function evalCall(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case "not": return !truthy(args[0]);
    case "and": return args.every(truthy);
    case "or": return args.some(truthy);
    case "eq": return deepEqual(args[0], args[1]);
    case "ne": return !deepEqual(args[0], args[1]);
    case "lt": return number(args[0], fn) < number(args[1], fn);
    case "lte": return number(args[0], fn) <= number(args[1], fn);
    case "gt": return number(args[0], fn) > number(args[1], fn);
    case "gte": return number(args[0], fn) >= number(args[1], fn);
    case "len": return lengthOf(args[0]);
    case "includes": return includes(args[0], args[1]);
    case "startsWith": return String(args[0] ?? "").startsWith(String(args[1] ?? ""));
    case "endsWith": return String(args[0] ?? "").endsWith(String(args[1] ?? ""));
    case "matches": return new RegExp(String(args[1] ?? "")).test(String(args[0] ?? ""));
    case "coalesce": return args.find(value => value !== null && value !== undefined);
    case "all": return arrayArg(args[0], fn).every(truthy);
    case "any": return arrayArg(args[0], fn).some(truthy);
    case "max": return Math.max(...arrayArg(args[0], fn).map(value => number(value, fn)));
    case "min": return Math.min(...arrayArg(args[0], fn).map(value => number(value, fn)));
    default: throw new Error(`Unsupported ExprIR call '${fn}'.`);
  }
}

function getPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function lengthOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function includes(collection: unknown, item: unknown): boolean {
  if (typeof collection === "string") return collection.includes(String(item ?? ""));
  if (Array.isArray(collection)) return collection.some(value => deepEqual(value, item));
  return false;
}

function arrayArg(value: unknown, fn: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${fn}(...) expected an array argument.`);
  return value;
}

function number(value: unknown, fn: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`${fn}(...) expected numeric arguments.`);
  return value;
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function formatTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isArtifactRef(value)) return value.uri;
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function isArtifactRef(value: unknown): value is { kind: "artifact"; uri: string } {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "artifact" && typeof (value as { uri?: unknown }).uri === "string");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported expression node: ${JSON.stringify(value)}`);
}
