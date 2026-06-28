import { NODE_REF } from "../internal/symbols.js";
import type { TypeIR } from "../ir/types.js";
import { expr, type Expr } from "../expressions/expr.js";

export type Primitive = string | number | boolean | null | undefined;
type Nullish<T> = Extract<T, null | undefined>;

export type OutputAccessor<T> = [NonNullable<T>] extends [Primitive]
  ? Expr<T>
  : [NonNullable<T>] extends [readonly (infer _Item)[]]
    ? Expr<T> & { readonly [index: number]: OutputAccessor<_Item | Nullish<T>> }
    : [NonNullable<T>] extends [object]
      ? Expr<T> & {
          readonly [K in keyof NonNullable<T>]-?: OutputAccessor<NonNullable<T>[K] | Nullish<T>>;
        }
      : Expr<T>;

export type NodeRef<Out> = {
  readonly [NODE_REF]: true;
  readonly id: string;
  readonly output: OutputAccessor<Out>;
};

type ObjectOutputAccessor<T extends object> =
  T extends readonly unknown[] ? never : OutputAccessor<T>;

export function pick<
  T extends object,
  const K extends readonly Extract<keyof T, string>[],
>(
  source: ObjectOutputAccessor<T>,
  keys: K,
): { readonly [P in K[number]]: OutputAccessor<T[P]> } {
  const out: Record<string, unknown> = {};
  const accessor = source as any;
  for (const key of keys) out[key] = accessor[key];
  return out as { readonly [P in K[number]]: OutputAccessor<T[P]> };
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
