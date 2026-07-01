import { EXPR } from "./symbols.js";
import type { ExprIR, TypeIR } from "../ir.js";

export interface Expr<T> {
  readonly [EXPR]: true;
  readonly __type: T;
  readonly __ir: ExprIR;
}

export type WorkflowPrimitive = string | number | boolean | null;
export type AnyWorkflowValue =
  | Expr<any>
  | WorkflowPrimitive
  | readonly AnyWorkflowValue[]
  | { readonly [key: string]: AnyWorkflowValue };

type WorkflowLiteralValue<T> =
  T extends undefined
    ? never
    : T extends WorkflowPrimitive
      ? T
      : T extends readonly (infer Item)[]
        ? readonly WorkflowValue<Item>[]
        : T extends object
          ? { readonly [K in keyof T]: WorkflowValue<T[K]> }
          : never;

type IsAny<T> = 0 extends (1 & T) ? true : false;

export type WorkflowValue<T = any> = IsAny<T> extends true
  ? AnyWorkflowValue
  : Expr<T> | WorkflowLiteralValue<T>;

type Primitive = string | number | boolean | null | undefined;
type Nullish<T> = Extract<T, null | undefined>;

export type OutputAccessor<T> = [NonNullable<T>] extends [Primitive]
  ? Expr<T>
  : [NonNullable<T>] extends [readonly (infer Item)[]]
    ? Expr<T> & { readonly [index: number]: OutputAccessor<Item | Nullish<T>> }
    : [NonNullable<T>] extends [object]
      ? Expr<T> & { readonly [K in Exclude<keyof NonNullable<T>, keyof Expr<any>>]-?: OutputAccessor<NonNullable<T>[K] | Nullish<T>> }
      : Expr<T>;

class ExprImpl<T> implements Expr<T> {
  readonly [EXPR] = true as const;
  declare readonly __type: T;
  constructor(readonly __ir: ExprIR) {}
}

export function isExpr(value: unknown): value is Expr<any> {
  return Boolean(value && typeof value === "object" && (value as any)[EXPR]);
}

export function expr<T>(ir: ExprIR): Expr<T> {
  return new ExprImpl<T>(ir);
}

export function valueToExprIR(value: unknown): ExprIR {
  if (isExpr(value)) return value.__ir;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (value === undefined) throw new Error("Unsupported expression value: undefined.");
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") throw new Error(`Unsupported expression value: ${typeof value}.`);
  if (Array.isArray(value)) {
    const items: ExprIR[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("Unsupported expression value: sparse array hole.");
      items.push(valueToExprIR(value[index]));
    }
    return { kind: "array", items };
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Unsupported expression value: non-plain object.");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Unsupported expression value: symbol keys.");
    const fields: Record<string, ExprIR> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`Unsupported expression value at key '${key}': undefined.`);
      fields[key] = valueToExprIR(item);
    }
    return { kind: "object", fields };
  }
  throw new Error(`Unsupported expression value: ${String(value)}.`);
}

export function accessor<T>(ir: ExprIR): OutputAccessor<T> {
  const base = expr<T>(ir);
  return new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "__ir" || prop === "__type" || prop === EXPR || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const key = String(prop);
      if (target.__ir.kind === "ref") return accessor({ kind: "ref", path: [...target.__ir.path, key] });
      if (target.__ir.kind === "var") return accessor({ kind: "var", id: target.__ir.id, path: [...target.__ir.path, key] });
      return accessor({ kind: "call", fn: "get", args: [target.__ir, { kind: "literal", value: key }] });
    },
  }) as OutputAccessor<T>;
}

export function refExpr<T>(path: string[], type?: TypeIR): OutputAccessor<T> {
  return accessor<T>(type === undefined ? { kind: "ref", path } : { kind: "ref", path, type });
}

export function varExpr<T>(id: string, path: string[] = [], type?: TypeIR): OutputAccessor<T> {
  return accessor<T>(type === undefined ? { kind: "var", id, path } : { kind: "var", id, path, type });
}

export function callExpr<T>(fn: string, args: unknown[], type?: TypeIR): OutputAccessor<T> {
  const irArgs = args.map(valueToCallArgIR);
  const ir = type === undefined ? { kind: "call" as const, fn, args: irArgs } : { kind: "call" as const, fn, args: irArgs, type };
  return accessor<T>(ir);
}

function valueToCallArgIR(value: unknown): ExprIR {
  return isExprIR(value) ? value : valueToExprIR(value);
}

function isExprIR(value: unknown): value is ExprIR {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "literal"
    || kind === "ref"
    || kind === "var"
    || kind === "call"
    || kind === "array"
    || kind === "object"
    || kind === "template"
    || kind === "lambda";
}
