export { isExpr, type Expr, type OutputAccessor, type WorkflowValue } from "./internal/expr.js";
import { accessor, callExpr, isExpr, valueToExprIR, varExpr } from "./internal/expr.js";
import type { Expr, OutputAccessor, WorkflowValue } from "./internal/expr.js";
import type { ExprIR } from "./ir.js";

type Predicate<T> = (value: OutputAccessor<T>, index: OutputAccessor<number>) => WorkflowValue<boolean>;
type NullWhere<T> = Extract<T, null>;
type PrimitiveWhereOperators<T extends string | number | boolean> = {
  eq?: WorkflowValue<T>;
  ne?: WorkflowValue<T>;
};
type PrimitiveWhere<T extends string | number | boolean> = WorkflowValue<T> | PrimitiveWhereOperators<T>;
type NumberWhere = WorkflowValue<number> | (PrimitiveWhereOperators<number> & {
  lt?: WorkflowValue<number>;
  lte?: WorkflowValue<number>;
  gt?: WorkflowValue<number>;
  gte?: WorkflowValue<number>;
});
type StringWhere = WorkflowValue<string> | (PrimitiveWhereOperators<string> & {
  contains?: WorkflowValue<string>;
  startsWith?: WorkflowValue<string>;
  endsWith?: WorkflowValue<string>;
  matches?: WorkflowValue<string>;
  length?: NumberWhere;
});
type ArrayWhere<Item> = {
  eq?: WorkflowValue<readonly Item[]>;
  ne?: WorkflowValue<readonly Item[]>;
  contains?: WorkflowValue<Item>;
  length?: NumberWhere;
};
type RecordItem<T> = NonNullable<T> extends Record<string, infer Item> ? Item : never;
type ObjectAccessor<T> = NonNullable<T> extends object
  ? NonNullable<T> extends readonly unknown[] ? never : OutputAccessor<T>
  : never;
type AccessorKey<T> = Exclude<Extract<keyof NonNullable<T>, string>, keyof Expr<any>>;
type WhereOperatorKey = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "startsWith" | "endsWith" | "matches" | "length";
type WhereFieldKey<T> = Exclude<AccessorKey<T>, WhereOperatorKey>;
type ReservedWhereFieldKey<T> = Extract<Extract<keyof NonNullable<T>, string>, WhereOperatorKey | keyof Expr<any>>;
type ObjectWhere<T> = {
  readonly [K in WhereFieldKey<T>]?: Where<NonNullable<T>[K]>;
} & {
  readonly [K in ReservedWhereFieldKey<T>]?: never;
};
type Where<T> =
  [NonNullable<T>] extends [string]
    ? StringWhere | NullWhere<T>
    : [NonNullable<T>] extends [number]
      ? NumberWhere | NullWhere<T>
      : [NonNullable<T>] extends [boolean]
        ? PrimitiveWhere<boolean> | NullWhere<T>
        : [NonNullable<T>] extends [readonly (infer Item)[]]
          ? ArrayWhere<Item> | NullWhere<T>
          : [NonNullable<T>] extends [object]
          ? ObjectWhere<T> | NullWhere<T>
            : never;

export function not(value: WorkflowValue<boolean>): Expr<boolean> { return callExpr<boolean>("not", [value]); }
export function and(...values: WorkflowValue<boolean>[]): Expr<boolean> { return callExpr<boolean>("and", values); }
export function or(...values: WorkflowValue<boolean>[]): Expr<boolean> { return callExpr<boolean>("or", values); }
export function ifElse<C extends boolean, T, E>(condition: WorkflowValue<C>, thenValue: WorkflowValue<T>, elseValue: WorkflowValue<E>): Expr<T | E> { return callExpr<T | E>("ifElse", [condition, thenValue, elseValue]); }
export function eq<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> { return callExpr<boolean>("eq", [a, b]); }
export function ne<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> { return callExpr<boolean>("ne", [a, b]); }
export function lt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("lt", [a, b]); }
export function lte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("lte", [a, b]); }
export function gt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("gt", [a, b]); }
export function gte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("gte", [a, b]); }
export function coalesce<T>(value: WorkflowValue<T | null | undefined>, ...values: WorkflowValue<T | null | undefined>[]): Expr<NonNullable<T>> { return callExpr<NonNullable<T>>("coalesce", [value, ...values]); }
export function len(value: WorkflowValue<readonly unknown[] | string>): Expr<number> { return callExpr<number>("len", [value]); }
export function includes(_collection: WorkflowValue<string>, _value: WorkflowValue<string>): Expr<boolean>;
export function includes<T>(_collection: WorkflowValue<readonly T[]>, _value: WorkflowValue<T>): Expr<boolean>;
export function includes(collection?: unknown, value?: unknown): Expr<boolean> { return callExpr<boolean>("includes", [collection, value]); }
export function isEmpty(value: WorkflowValue<readonly unknown[] | string>): Expr<boolean> { return eq(len(value), 0); }
export function startsWith(value: WorkflowValue<string>, prefix: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("startsWith", [value, prefix]); }
export function endsWith(value: WorkflowValue<string>, suffix: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("endsWith", [value, suffix]); }
export function matches(value: WorkflowValue<string>, pattern: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("matches", [value, pattern]); }
export function get<T>(_target: WorkflowValue<readonly T[]>, _key: WorkflowValue<number>): OutputAccessor<T | undefined>;
export function get<T>(_target: string extends keyof NonNullable<T> ? WorkflowValue<T> : never, _key: WorkflowValue<string>): OutputAccessor<RecordItem<T> | undefined>;
export function get(target?: unknown, key?: unknown): OutputAccessor<unknown> {
  return callExpr<unknown>("get", [target, key]);
}
export function head<T>(array: WorkflowValue<readonly T[]>): OutputAccessor<T | undefined> { return get(array, 0); }
export function every<T>(_array: WorkflowValue<readonly T[]>, _predicate: Predicate<T>): Expr<boolean>;
export function every(_values: WorkflowValue<readonly boolean[]>): Expr<boolean>;
export function every<T>(array?: WorkflowValue<readonly T[]> | WorkflowValue<readonly boolean[]>, predicate?: Predicate<T>): Expr<boolean> {
  return predicate ? scopedCollection<boolean, T>("every", array as WorkflowValue<readonly T[]>, predicate) : callExpr<boolean>("every", [array]);
}
export function some<T>(_array: WorkflowValue<readonly T[]>, _predicate: Predicate<T>): Expr<boolean>;
export function some(_values: WorkflowValue<readonly boolean[]>): Expr<boolean>;
export function some<T>(array?: WorkflowValue<readonly T[]> | WorkflowValue<readonly boolean[]>, predicate?: Predicate<T>): Expr<boolean> {
  return predicate ? scopedCollection<boolean, T>("some", array as WorkflowValue<readonly T[]>, predicate) : callExpr<boolean>("some", [array]);
}
export function filter<T>(array: WorkflowValue<readonly T[]>, predicate: Predicate<T>): Expr<readonly T[]> {
  return scopedCollection<readonly T[], T>("filter", array, predicate);
}
export function map<T, R>(array: WorkflowValue<readonly T[]>, mapper: (value: OutputAccessor<T>, index: OutputAccessor<number>) => WorkflowValue<R>): Expr<readonly R[]> {
  return scopedCollection<readonly R[], T>("map", array, mapper);
}
export function max(values: WorkflowValue<readonly number[]>): Expr<number> { return callExpr<number>("max", [values]); }
export function min(values: WorkflowValue<readonly number[]>): Expr<number> { return callExpr<number>("min", [values]); }
export function where<T>(target: Expr<T>, filter: Where<T>): Expr<boolean>;
export function where<T extends string | number | boolean>(target: T, filter: Where<T>): Expr<boolean>;
export function where<T>(target: readonly WorkflowValue<T>[], filter: ArrayWhere<T>): Expr<boolean>;
export function where(target: unknown, filter: unknown): Expr<boolean> {
  return lowerWhere(target, filter);
}
export function pick<T, const K extends readonly AccessorKey<T>[]>(source: ObjectAccessor<T>, keys: K): { readonly [P in K[number]]: OutputAccessor<NonNullable<T>[P] | Extract<T, null | undefined>> } {
  const out: Record<string, OutputAccessor<unknown>> = {};
  const accessor = source as unknown as Record<string, OutputAccessor<unknown>>;
  for (const key of keys) {
    if (RESERVED_ACCESSOR_KEYS.has(key)) throw new Error(`pick(source, keys) cannot project reserved accessor key '${key}'.`);
    out[key] = accessor[key]!;
  }
  return out as { readonly [P in K[number]]: OutputAccessor<NonNullable<T>[P] | Extract<T, null | undefined>> };
}
export function template(strings: TemplateStringsArray, ...values: WorkflowValue[]): Expr<string> {
  const parts: Array<{ kind: "text"; value: string } | { kind: "expr"; expr: ExprIR }> = [];
  strings.forEach((text, index) => {
    parts.push({ kind: "text", value: text });
    if (index < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[index]) });
  });
  return accessor<string>({ kind: "template", template: { kind: "template", parts } });
}

function scopedCollection<R, T>(fn: string, array: WorkflowValue<readonly T[]>, callback: (value: OutputAccessor<T>, index: OutputAccessor<number>) => unknown): OutputAccessor<R> {
  return withBuildContext(context => {
    const itemId = context.nextId();
    const indexId = context.nextId();
    const body = valueToExprIR(callback(varExpr<T>(itemId), varExpr<number>(indexId)));
    return callExpr<R>(fn, [
      array,
      { kind: "lambda", params: [{ id: itemId }, { id: indexId }], body } satisfies ExprIR,
    ]);
  });
}

type BuildContext = {
  nextId(): string;
};

let activeBuildContext: BuildContext | undefined;

function withBuildContext<T>(run: (context: BuildContext) => T): T {
  if (activeBuildContext) return run(activeBuildContext);
  let next = 0;
  const context = { nextId: () => `v${next++}` };
  activeBuildContext = context;
  try {
    return run(context);
  } finally {
    activeBuildContext = undefined;
  }
}

function lowerWhere(target: unknown, filter: unknown): Expr<boolean> {
  if (isExpr(filter) || filter === null || typeof filter === "string" || typeof filter === "number" || typeof filter === "boolean") return eq(target as WorkflowValue<unknown>, filter as WorkflowValue<unknown>);
  if (!isPlainObject(filter)) return eq(target as WorkflowValue<unknown>, filter as WorkflowValue<unknown>);
  const entries = Object.entries(filter);
  if (entries.length === 0) throw new Error("where(target, filter) requires at least one filter entry.");
  if (isObjectTyped(target)) return lowerObjectWhere(target, filter);
  if (entries.every(([key]) => WHERE_OPERATOR_KEYS.has(key))) return lowerWhereOperators(target, filter);
  return lowerObjectWhere(target, filter);
}

function lowerObjectWhere(target: unknown, filter: unknown): Expr<boolean> {
  if (!isPlainObject(filter)) return eq(target as WorkflowValue<unknown>, filter as WorkflowValue<unknown>);
  const entries = Object.entries(filter);
  if (entries.length === 0) throw new Error("where(target, filter) requires at least one filter entry.");
  const clauses = entries.map(([key, value]) => {
    if (WHERE_OPERATOR_KEYS.has(key) || RESERVED_ACCESSOR_KEYS.has(key)) throw new Error(`where(target, filter) cannot use reserved filter key '${key}'.`);
    return lowerWhere((target as Record<string, unknown>)[key], value);
  });
  return clauses.length === 1 ? clauses[0]! : and(...clauses);
}

function lowerWhereOperators(target: unknown, filter: Record<string, unknown>): Expr<boolean> {
  const clauses = Object.entries(filter).map(([operator, value]) => {
    switch (operator) {
      case "eq": return eq(target as WorkflowValue<unknown>, value as WorkflowValue<unknown>);
      case "ne": return ne(target as WorkflowValue<unknown>, value as WorkflowValue<unknown>);
      case "lt": return lt(target as WorkflowValue<number>, value as WorkflowValue<number>);
      case "lte": return lte(target as WorkflowValue<number>, value as WorkflowValue<number>);
      case "gt": return gt(target as WorkflowValue<number>, value as WorkflowValue<number>);
      case "gte": return gte(target as WorkflowValue<number>, value as WorkflowValue<number>);
      case "contains": return includes(target as WorkflowValue<readonly unknown[]>, value as WorkflowValue<unknown>);
      case "startsWith": return startsWith(target as WorkflowValue<string>, value as WorkflowValue<string>);
      case "endsWith": return endsWith(target as WorkflowValue<string>, value as WorkflowValue<string>);
      case "matches": return matches(target as WorkflowValue<string>, value as WorkflowValue<string>);
      case "length": return lowerWhere(len(target as WorkflowValue<readonly unknown[] | string>), value);
      default: throw new Error(`Unsupported where operator: ${operator}.`);
    }
  });
  return clauses.length === 1 ? clauses[0]! : and(...clauses);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const WHERE_OPERATOR_KEYS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "matches", "length"]);
const RESERVED_ACCESSOR_KEYS = new Set(["__ir", "__type"]);

function isObjectTyped(value: unknown): boolean {
  if (!isExpr(value)) return false;
  return "type" in value.__ir && (value.__ir.type?.kind === "object" || value.__ir.type?.kind === "record");
}
