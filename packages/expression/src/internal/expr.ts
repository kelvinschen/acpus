import * as Result from "effect/Result";
import type { ExprIR } from "../ir.js";

const EXPR = Symbol.for("acpus.expression");

export interface Expr<T> {
  readonly [EXPR]: true;
  readonly __type: T;
  readonly __ir: ExprIR;
}

type WorkflowPrimitive = string | number | boolean | null;
export type WorkflowData =
  | WorkflowPrimitive
  | readonly WorkflowData[]
  | { readonly [key: string]: WorkflowData };

type AnyResolvable =
  | Expr<any>
  | WorkflowPrimitive
  | readonly AnyResolvable[]
  | { readonly [key: string]: AnyResolvable };

type ResolvableLiteral<T> =
  T extends undefined
    ? never
    : T extends (...args: any[]) => any
      ? never
      : T extends WorkflowPrimitive
        ? T
        : T extends readonly (infer Item)[]
          ? readonly ResolvableValue<Item>[]
          : T extends object
            ? { readonly [K in keyof T]: ResolvableValue<T[K]> }
            : never;

type IsAny<T> = 0 extends (1 & T) ? true : false;
type ResolvableValue<T> = IsAny<T> extends true ? AnyResolvable : Expr<T> | ResolvableLiteral<T>;

/** A durable literal or expression that Acpus resolves from workflow scope at run time. */
export type Resolvable<T = WorkflowData | undefined> = ResolvableValue<T>;

type Primitive = string | number | boolean | null | undefined;
type Nullish<T> = Extract<T, null | undefined>;

export type ExprValue<T> = [NonNullable<T>] extends [Primitive]
  ? Expr<T>
  : [NonNullable<T>] extends [readonly (infer Item)[]]
    ? Expr<T> & { readonly [index: number]: ExprValue<Item | Nullish<T> | undefined> }
    : [NonNullable<T>] extends [object]
      ? Expr<T> & { readonly [K in Exclude<keyof NonNullable<T>, keyof Expr<any>>]-?: ExprValue<NonNullable<T>[K] | Nullish<T>> }
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

export type ExprLoweringError =
  | { type: "unsupported-expression-value"; path: string; valueType: string; message: string }
  | { type: "sparse-array-hole"; path: string; message: string }
  | { type: "non-plain-object"; path: string; message: string }
  | { type: "symbol-keys"; path: string; message: string }
  | { type: "cyclic-value"; path: string; message: string }
  | { type: "uninspectable-value"; path: string; message: string };

export function valueToExprIR(value: unknown): ExprIR {
  return Result.match(tryValueToExprIR(value), {
    onSuccess: ir => ir,
    onFailure: error => {
      throw new Error(error.message);
    },
  });
}

export function tryValueToExprIR(value: unknown, path = "$"): Result.Result<ExprIR, ExprLoweringError> {
  return lowerValueToExprIR(value, path, new WeakSet());
}

function lowerValueToExprIR(
  value: unknown,
  path: string,
  visiting: WeakSet<object>,
): Result.Result<ExprIR, ExprLoweringError> {
  try {
    return lowerInspectableValue(value, path, visiting);
  } catch {
    return Result.fail({
      type: "uninspectable-value",
      path,
      message: "Unsupported expression value: object could not be inspected.",
    });
  }
}

function lowerInspectableValue(
  value: unknown,
  path: string,
  visiting: WeakSet<object>,
): Result.Result<ExprIR, ExprLoweringError> {
  if (isExpr(value)) return Result.succeed(value.__ir);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return Result.succeed({ kind: "literal", value });
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Result.succeed({ kind: "literal", value }) : unsupportedExpressionValue(path, "non-finite number");
  }
  if (value === undefined) return unsupportedExpressionValue(path, "undefined");
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return unsupportedExpressionValue(path, typeof value);
  if (value && typeof value === "object") {
    if (visiting.has(value)) {
      return Result.fail({
        type: "cyclic-value",
        path,
        message: "Unsupported expression value: cyclic reference.",
      });
    }
    visiting.add(value);
    try {
      if (Array.isArray(value)) {
        const items: ExprIR[] = [];
        for (let index = 0; index < value.length; index++) {
          const itemPath = `${path}[${index}]`;
          if (!Object.prototype.hasOwnProperty.call(value, index)) return Result.fail({ type: "sparse-array-hole", path: itemPath, message: "Unsupported expression value: sparse array hole." });
          const item = lowerValueToExprIR(value[index], itemPath, visiting);
          if (Result.isFailure(item)) return item;
          items.push(item.success);
        }
        return Result.succeed({ kind: "array", items });
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return Result.fail({ type: "non-plain-object", path, message: "Unsupported expression value: non-plain object." });
      if (Object.getOwnPropertySymbols(value).length > 0) return Result.fail({ type: "symbol-keys", path, message: "Unsupported expression value: symbol keys." });
      const fields: Array<[string, ExprIR]> = [];
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const child = lowerValueToExprIR(item, `${path}.${key}`, visiting);
        if (Result.isFailure(child)) {
          if (child.failure.type === "unsupported-expression-value" && child.failure.valueType === "undefined" && child.failure.path === `${path}.${key}`) {
            return Result.fail({ ...child.failure, message: `Unsupported expression value at key '${key}': undefined.` });
          }
          return child;
        }
        fields.push([key, child.success]);
      }
      return Result.succeed({ kind: "object", fields: Object.fromEntries(fields) });
    } finally {
      visiting.delete(value);
    }
  }
  return unsupportedExpressionValue(path, String(value));
}

function unsupportedExpressionValue(path: string, valueType: string): Result.Result<ExprIR, ExprLoweringError> {
  return Result.fail({ type: "unsupported-expression-value", path, valueType, message: `Unsupported expression value: ${valueType}.` });
}

export function accessor<T>(ir: ExprIR): ExprValue<T> {
  const base = expr<T>(ir);
  return new Proxy(base as any, {
    get(target, prop, receiver) {
      if (prop === "__ir" || prop === "__type" || prop === EXPR || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const key = String(prop);
      if (target.__ir.kind === "ref") return accessor({ kind: "ref", path: [...target.__ir.path, key] });
      return accessor({ kind: "call", fn: "access", args: [target.__ir, { kind: "literal", value: key }] });
    },
  }) as ExprValue<T>;
}

export function refExpr<T>(path: string[]): ExprValue<T> {
  return accessor<T>({ kind: "ref", path });
}

export function callExpr<T>(fn: string, args: unknown[]): ExprValue<T> {
  return accessor<T>({ kind: "call", fn, args: args.map(valueToExprIR) });
}
