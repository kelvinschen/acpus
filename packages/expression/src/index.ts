export { isExpr, type Expr, type OutputAccessor, type WorkflowValue } from "./internal/expr.js";
import { accessor, callExpr, isExpr, valueToExprIR, varExpr } from "./internal/expr.js";
import { WHERE_OPERATOR_KEY_SET } from "./internal/operators.js";
import type { Expr, OutputAccessor, WorkflowValue } from "./internal/expr.js";
import type { WhereOperatorKey } from "./internal/operators.js";
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
type WhereFieldKey<T> = Exclude<AccessorKey<T>, WhereOperatorKey>;
type ReservedWhereFieldKey<T> = Extract<Extract<keyof NonNullable<T>, string>, WhereOperatorKey | keyof Expr<any>>;
type ObjectWhere<T> = {
  readonly [K in WhereFieldKey<T>]?: Where<NonNullable<T>[K]>;
} & {
  readonly [K in ReservedWhereFieldKey<T>]?: never;
};
type TemplatePart = { kind: "text"; value: string } | { kind: "expr"; expr: ExprIR };
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

/** Negates a workflow boolean value. */
export function not(value: WorkflowValue<boolean>): Expr<boolean> { return callExpr<boolean>("not", [value]); }
/** Combines workflow boolean values with logical AND. */
export function and(...values: WorkflowValue<boolean>[]): Expr<boolean> { return callExpr<boolean>("and", values); }
/** Combines workflow boolean values with logical OR. */
export function or(...values: WorkflowValue<boolean>[]): Expr<boolean> { return callExpr<boolean>("or", values); }
/** Selects one of two workflow values from a boolean expression. */
export function ifElse<C extends boolean, T, E>(condition: WorkflowValue<C>, thenValue: WorkflowValue<T>, elseValue: WorkflowValue<E>): Expr<T | E> { return callExpr<T | E>("ifElse", [condition, thenValue, elseValue]); }
/** Compares two workflow values for equality. */
export function eq<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> { return callExpr<boolean>("eq", [a, b]); }
/** Compares two workflow values for inequality. */
export function ne<T>(a: WorkflowValue<T>, b: WorkflowValue<T>): Expr<boolean> { return callExpr<boolean>("ne", [a, b]); }
/** Compares two workflow numbers with less-than. */
export function lt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("lt", [a, b]); }
/** Compares two workflow numbers with less-than-or-equal. */
export function lte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("lte", [a, b]); }
/** Compares two workflow numbers with greater-than. */
export function gt(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("gt", [a, b]); }
/** Compares two workflow numbers with greater-than-or-equal. */
export function gte(a: WorkflowValue<number>, b: WorkflowValue<number>): Expr<boolean> { return callExpr<boolean>("gte", [a, b]); }
/** Returns the first non-nullish workflow value. */
export function coalesce<T>(value: WorkflowValue<T | null | undefined>, ...values: WorkflowValue<T | null | undefined>[]): Expr<NonNullable<T>> { return callExpr<NonNullable<T>>("coalesce", [value, ...values]); }
/** Returns the length of a workflow string or array value. */
export function len(value: WorkflowValue<readonly unknown[] | string>): Expr<number> { return callExpr<number>("len", [value]); }
/** Checks whether a workflow string contains a substring. */
export function includes(_collection: WorkflowValue<string>, _value: WorkflowValue<string>): Expr<boolean>;
/** Checks whether a workflow array contains a value. */
export function includes<T>(_collection: WorkflowValue<readonly T[]>, _value: WorkflowValue<T>): Expr<boolean>;
export function includes(collection?: unknown, value?: unknown): Expr<boolean> { return callExpr<boolean>("includes", [collection, value]); }
/** Checks whether a workflow string or array value is empty. */
export function isEmpty(value: WorkflowValue<readonly unknown[] | string>): Expr<boolean> { return eq(len(value), 0); }
/** Checks whether a workflow string starts with a prefix. */
export function startsWith(value: WorkflowValue<string>, prefix: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("startsWith", [value, prefix]); }
/** Checks whether a workflow string ends with a suffix. */
export function endsWith(value: WorkflowValue<string>, suffix: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("endsWith", [value, suffix]); }
/** Checks whether a workflow string matches a pattern. */
export function matches(value: WorkflowValue<string>, pattern: WorkflowValue<string>): Expr<boolean> { return callExpr<boolean>("matches", [value, pattern]); }
/** Reads an item from a workflow array by numeric index. */
export function get<T>(_target: WorkflowValue<readonly T[]>, _key: WorkflowValue<number>): OutputAccessor<T | undefined>;
/** Reads a value from a workflow record by key. */
export function get<T>(_target: string extends keyof NonNullable<T> ? WorkflowValue<T> : never, _key: WorkflowValue<string>): OutputAccessor<RecordItem<T> | undefined>;
export function get(target?: unknown, key?: unknown): OutputAccessor<unknown> {
  return callExpr<unknown>("get", [target, key]);
}
/** Reads the first item from a workflow array. */
export function head<T>(array: WorkflowValue<readonly T[]>): OutputAccessor<T | undefined> { return get(array, 0); }
/** Checks whether every item in a workflow array matches a predicate. */
export function every<T>(_array: WorkflowValue<readonly T[]>, _predicate: Predicate<T>): Expr<boolean>;
/** Checks whether every workflow boolean in an array is true. */
export function every(_values: WorkflowValue<readonly boolean[]>): Expr<boolean>;
export function every<T>(array?: WorkflowValue<readonly T[]> | WorkflowValue<readonly boolean[]>, predicate?: Predicate<T>): Expr<boolean> {
  return predicate ? scopedCollection<boolean, T>("every", array as WorkflowValue<readonly T[]>, predicate) : callExpr<boolean>("every", [array]);
}
/** Checks whether any item in a workflow array matches a predicate. */
export function some<T>(_array: WorkflowValue<readonly T[]>, _predicate: Predicate<T>): Expr<boolean>;
/** Checks whether any workflow boolean in an array is true. */
export function some(_values: WorkflowValue<readonly boolean[]>): Expr<boolean>;
export function some<T>(array?: WorkflowValue<readonly T[]> | WorkflowValue<readonly boolean[]>, predicate?: Predicate<T>): Expr<boolean> {
  return predicate ? scopedCollection<boolean, T>("some", array as WorkflowValue<readonly T[]>, predicate) : callExpr<boolean>("some", [array]);
}
/** Filters a workflow array with a scoped predicate. */
export function filter<T>(array: WorkflowValue<readonly T[]>, predicate: Predicate<T>): Expr<readonly T[]> {
  return scopedCollection<readonly T[], T>("filter", array, predicate);
}
/** Maps a workflow array with a scoped mapper. */
export function map<T, R>(array: WorkflowValue<readonly T[]>, mapper: (value: OutputAccessor<T>, index: OutputAccessor<number>) => WorkflowValue<R>): Expr<readonly R[]> {
  return scopedCollection<readonly R[], T>("map", array, mapper);
}
/** Returns the maximum number from a workflow array. */
export function max(values: WorkflowValue<readonly number[]>): Expr<number> { return callExpr<number>("max", [values]); }
/** Returns the minimum number from a workflow array. */
export function min(values: WorkflowValue<readonly number[]>): Expr<number> { return callExpr<number>("min", [values]); }
/** Builds a field-wise predicate over an expression object. */
export function where<T>(target: Expr<T>, filter: Where<T>): Expr<boolean>;
/** Builds a predicate over a primitive workflow value. */
export function where<T extends string | number | boolean>(target: T, filter: Where<T>): Expr<boolean>;
/** Builds a predicate over a workflow array value. */
export function where<T>(target: readonly WorkflowValue<T>[], filter: ArrayWhere<T>): Expr<boolean>;
export function where(target: unknown, filter: unknown): Expr<boolean> {
  return lowerWhere(target, filter);
}
/** Projects selected fields from an object accessor. */
export function pick<T, const K extends readonly AccessorKey<T>[]>(source: ObjectAccessor<T>, keys: K): { readonly [P in K[number]]: OutputAccessor<NonNullable<T>[P] | Extract<T, null | undefined>> } {
  const out: Record<string, OutputAccessor<unknown>> = {};
  const accessor = source as unknown as Record<string, OutputAccessor<unknown>>;
  for (const key of keys) {
    if (RESERVED_ACCESSOR_KEYS.has(key)) throw new Error(`pick(source, keys) cannot project reserved accessor key '${key}'.`);
    out[key] = accessor[key]!;
  }
  return out as { readonly [P in K[number]]: OutputAccessor<NonNullable<T>[P] | Extract<T, null | undefined>> };
}
/**
 * Builds an exact string template expression and preserves authored whitespace.
 * Use `md` for multiline Markdown prompts that should be dedented.
 */
export function template(strings: TemplateStringsArray, ...values: WorkflowValue[]): Expr<string> {
  return templateExpr(templateParts(strings, values));
}

/**
 * Builds a multiline Markdown template for prompts and messages.
 * Unlike `template`, this helper removes surrounding blank lines and common indentation.
 */
export function md(strings: TemplateStringsArray, ...values: WorkflowValue[]): Expr<string> {
  return templateExpr(dedentTemplateParts(templateParts(strings, values)));
}

function templateParts(strings: TemplateStringsArray, values: WorkflowValue[]): TemplatePart[] {
  const parts: TemplatePart[] = [];
  strings.forEach((text, index) => {
    parts.push({ kind: "text", value: text });
    if (index < values.length) parts.push({ kind: "expr", expr: valueToExprIR(values[index]) });
  });
  return parts;
}

function templateExpr(parts: TemplatePart[]): Expr<string> {
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
  if (entries.every(([key]) => WHERE_OPERATOR_KEY_SET.has(key as WhereOperatorKey))) return lowerWhereOperators(target, filter);
  return lowerObjectWhere(target, filter);
}

function lowerObjectWhere(target: unknown, filter: unknown): Expr<boolean> {
  if (!isPlainObject(filter)) return eq(target as WorkflowValue<unknown>, filter as WorkflowValue<unknown>);
  const entries = Object.entries(filter);
  if (entries.length === 0) throw new Error("where(target, filter) requires at least one filter entry.");
  const clauses = entries.map(([key, value]) => {
    if (WHERE_OPERATOR_KEY_SET.has(key as WhereOperatorKey) || RESERVED_ACCESSOR_KEYS.has(key)) throw new Error(`where(target, filter) cannot use reserved filter key '${key}'.`);
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

const RESERVED_ACCESSOR_KEYS = new Set(["__ir", "__type"]);

function isObjectTyped(value: unknown): boolean {
  if (!isExpr(value)) return false;
  return "type" in value.__ir && (value.__ir.type?.kind === "object" || value.__ir.type?.kind === "record");
}
