import { call, expr, type Expr, type WorkflowValue } from "./expr.js";

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
