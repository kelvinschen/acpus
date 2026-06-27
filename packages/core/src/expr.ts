import { EXPR, NODE_REF } from "./internal.js";
import type { ExprIR, TypeIR } from "./ir.js";

export type Primitive = string | number | boolean | null | undefined;

export interface Expr<T> {
  readonly [EXPR]: true;
  readonly __type?: T;
  readonly ir: ExprIR;
}

export type WorkflowValue<T = any> = Expr<T> | T | WorkflowValue<any>[] | { [key: string]: WorkflowValue<any> };

export type OutputAccessor<T> = T extends Primitive
  ? Expr<NonNullable<T>>
  : T extends Array<infer _Item>
    ? Expr<T>
    : Expr<T> & { readonly [K in keyof T]: OutputAccessor<T[K]> };

export type NodeRef<Out> = {
  readonly [NODE_REF]: true;
  readonly id: string;
  readonly output: OutputAccessor<Out>;
};

class ExprImpl<T> implements Expr<T> {
  readonly [EXPR] = true as const;
  readonly __type?: T;
  constructor(readonly ir: ExprIR) {}
}

export function isExpr(value: unknown): value is Expr<any> {
  return Boolean(value && typeof value === "object" && (value as any)[EXPR]);
}

export function expr<T>(ir: ExprIR): Expr<T> {
  return new ExprImpl<T>(ir);
}

export function refExpr<T>(path: string[], type?: TypeIR): OutputAccessor<T> {
  const base = expr<T>(type === undefined ? { kind: "ref", path } : { kind: "ref", path, type });
  return new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      return refExpr([...path, String(prop)]);
    },
  }) as OutputAccessor<T>;
}

export function makeNodeRef<Out>(id: string): NodeRef<Out> {
  return {
    [NODE_REF]: true as const,
    id,
    output: refExpr<Out>(["nodes", id, "output"]),
  };
}

export function valueToExprIR(value: unknown): ExprIR {
  if (isExpr(value)) return value.ir;
  if (Array.isArray(value)) return { kind: "array", items: value.map(valueToExprIR) };
  if (value && typeof value === "object") {
    const fields: Record<string, ExprIR> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) fields[key] = valueToExprIR(item);
    return { kind: "object", fields };
  }
  return { kind: "literal", value };
}

function call<T>(fn: string, args: unknown[], type?: TypeIR): Expr<T> {
  return expr<T>(type === undefined ? { kind: "call", fn, args: args.map(valueToExprIR) } : { kind: "call", fn, args: args.map(valueToExprIR), type });
}

export function literal<T extends string | number | boolean | null>(value: T): Expr<T> {
  return expr<T>({ kind: "literal", value });
}

export function not(value: WorkflowValue<boolean>): Expr<boolean> {
  return call<boolean>("not", [value], { kind: "boolean" });
}

export function and(...values: WorkflowValue<boolean>[]): Expr<boolean> {
  return call<boolean>("and", values, { kind: "boolean" });
}

export function or(...values: WorkflowValue<boolean>[]): Expr<boolean> {
  return call<boolean>("or", values, { kind: "boolean" });
}

export function eq<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> {
  return call<boolean>("eq", [a, b], { kind: "boolean" });
}

export function ne<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> {
  return call<boolean>("ne", [a, b], { kind: "boolean" });
}

export function lt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> {
  return call<boolean>("lt", [a, b], { kind: "boolean" });
}

export function lte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> {
  return call<boolean>("lte", [a, b], { kind: "boolean" });
}

export function gt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> {
  return call<boolean>("gt", [a, b], { kind: "boolean" });
}

export function gte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> {
  return call<boolean>("gte", [a, b], { kind: "boolean" });
}

export function len<T>(value: WorkflowValue<T[] | string>): Expr<number> {
  return call<number>("len", [value], { kind: "integer" });
}

export function contains<T>(container: WorkflowValue<T[] | string>, item: WorkflowValue<T | string>): Expr<boolean> {
  return call<boolean>("contains", [container, item], { kind: "boolean" });
}

export function startsWith(value: WorkflowValue<string>, prefix: WorkflowValue<string>): Expr<boolean> {
  return call<boolean>("startsWith", [value, prefix], { kind: "boolean" });
}

export function endsWith(value: WorkflowValue<string>, suffix: WorkflowValue<string>): Expr<boolean> {
  return call<boolean>("endsWith", [value, suffix], { kind: "boolean" });
}

export function matches(value: WorkflowValue<string>, pattern: WorkflowValue<string>): Expr<boolean> {
  return call<boolean>("matches", [value, pattern], { kind: "boolean" });
}

export function coalesce<T>(...values: WorkflowValue<T | null | undefined>[]): Expr<T> {
  return call<T>("coalesce", values);
}

export function json(value: unknown): Expr<string> {
  return call<string>("json", [value], { kind: "string" });
}

export function textValue(value: unknown): Expr<string> {
  return call<string>("text", [value], { kind: "string" });
}

export function all(values: Array<WorkflowValue<boolean>>): Expr<boolean>;
export function all<T>(values: readonly T[], predicate: (value: T, index: number) => WorkflowValue<boolean>): Expr<boolean>;
export function all<T>(values: readonly T[] | Array<WorkflowValue<boolean>>, predicate?: (value: T, index: number) => WorkflowValue<boolean>): Expr<boolean> {
  const items = predicate ? (values as readonly T[]).map((value, index) => predicate(value, index)) : values;
  return call<boolean>("all", [items], { kind: "boolean" });
}

export function any(values: Array<WorkflowValue<boolean>>): Expr<boolean>;
export function any<T>(values: readonly T[], predicate: (value: T, index: number) => WorkflowValue<boolean>): Expr<boolean>;
export function any<T>(values: readonly T[] | Array<WorkflowValue<boolean>>, predicate?: (value: T, index: number) => WorkflowValue<boolean>): Expr<boolean> {
  const items = predicate ? (values as readonly T[]).map((value, index) => predicate(value, index)) : values;
  return call<boolean>("any", [items], { kind: "boolean" });
}

export function max(values: Array<WorkflowValue<number>>): Expr<number>;
export function max<T>(values: readonly T[], selector: (value: T, index: number) => WorkflowValue<number>): Expr<number>;
export function max<T>(values: readonly T[] | Array<WorkflowValue<number>>, selector?: (value: T, index: number) => WorkflowValue<number>): Expr<number> {
  const items = selector ? (values as readonly T[]).map((value, index) => selector(value, index)) : values;
  return call<number>("max", [items], { kind: "number" });
}

export function min(values: Array<WorkflowValue<number>>): Expr<number>;
export function min<T>(values: readonly T[], selector: (value: T, index: number) => WorkflowValue<number>): Expr<number>;
export function min<T>(values: readonly T[] | Array<WorkflowValue<number>>, selector?: (value: T, index: number) => WorkflowValue<number>): Expr<number> {
  const items = selector ? (values as readonly T[]).map((value, index) => selector(value, index)) : values;
  return call<number>("min", [items], { kind: "number" });
}

export type NumberWhere = number | {
  eq?: number;
  ne?: number;
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  in?: readonly number[];
  notIn?: readonly number[];
};

export type StringWhere = string | {
  eq?: string;
  ne?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  matches?: string;
  in?: readonly string[];
  notIn?: readonly string[];
};

export type BooleanWhere = boolean | { eq?: boolean; ne?: boolean };

export type ArrayWhere<Item> = {
  isEmpty?: boolean;
  length?: NumberWhere;
  contains?: Item;
};

export type Where<T> = T extends string
  ? StringWhere
  : T extends number
    ? NumberWhere
    : T extends boolean
      ? BooleanWhere
      : T extends Array<infer Item>
        ? ArrayWhere<Item>
        : T extends object
          ? ObjectWhere<T>
          : never;

export type ObjectWhere<T> = {
  [K in keyof T]?: Where<T[K]>;
} & {
  AND?: ObjectWhere<T>[];
  OR?: ObjectWhere<T>[];
  NOT?: ObjectWhere<T>;
};

export function where<T>(target: OutputAccessor<T>, filter: Where<T>): Expr<boolean>;
export function where<T>(target: Expr<T>, filter: Where<T>): Expr<boolean>;
export function where(target: any, filter: any): Expr<boolean>;
export function where(target: any, filter: any): Expr<boolean> {
  return lowerWhere(target, filter);
}

function lowerWhere(target: any, filter: any): Expr<boolean> {
  if (typeof filter === "boolean" || typeof filter === "string" || typeof filter === "number" || filter === null) return eq(target, filter as any);
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return eq(target, filter);

  const clauses: WorkflowValue<boolean>[] = [];
  const entries = Object.entries(filter) as Array<[string, any]>;
  for (const [key, value] of entries) {
    if (key === "AND") clauses.push(and(...value.map((v: any) => lowerWhere(target, v))));
    else if (key === "OR") clauses.push(or(...value.map((v: any) => lowerWhere(target, v))));
    else if (key === "NOT") clauses.push(not(lowerWhere(target, value)));
    else if (isOperatorObject(value)) clauses.push(lowerOperator(target[key], value));
    else clauses.push(lowerWhere(target[key], value));
  }
  if (clauses.length === 0) return literal(true);
  return clauses.length === 1 ? clauses[0] as Expr<boolean> : and(...clauses);
}

function isOperatorObject(value: any): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).some(k => OPERATOR_KEYS.has(k));
}

const OPERATOR_KEYS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "contains", "startsWith", "endsWith", "matches", "length", "isEmpty"]);

function lowerOperator(target: any, spec: Record<string, any>): Expr<boolean> {
  const clauses: WorkflowValue<boolean>[] = [];
  for (const [op, value] of Object.entries(spec)) {
    switch (op) {
      case "eq": clauses.push(eq(target, value)); break;
      case "ne": clauses.push(ne(target, value)); break;
      case "lt": clauses.push(lt(target, value)); break;
      case "lte": clauses.push(lte(target, value)); break;
      case "gt": clauses.push(gt(target, value)); break;
      case "gte": clauses.push(gte(target, value)); break;
      case "in": clauses.push(call<boolean>("in", [target, value], { kind: "boolean" })); break;
      case "notIn": clauses.push(not(call<boolean>("in", [target, value], { kind: "boolean" }))); break;
      case "contains": clauses.push(contains(target, value)); break;
      case "startsWith": clauses.push(startsWith(target, value)); break;
      case "endsWith": clauses.push(endsWith(target, value)); break;
      case "matches": clauses.push(matches(target, value)); break;
      case "length": clauses.push(lowerWhere(len(target), value)); break;
      case "isEmpty": clauses.push(value ? eq(len(target), 0) : gt(len(target), 0)); break;
      default: throw new Error(`Unsupported where operator: ${op}`);
    }
  }
  return clauses.length === 0 ? literal(true) : clauses.length === 1 ? clauses[0] as Expr<boolean> : and(...clauses);
}

export const exprOps = {
  literal,
  not,
  and,
  or,
  eq,
  ne,
  lt,
  lte,
  gt,
  gte,
  len,
  contains,
  startsWith,
  endsWith,
  matches,
  coalesce,
  json,
  text: textValue,
  all,
  any,
  max,
  min,
  where,
};
