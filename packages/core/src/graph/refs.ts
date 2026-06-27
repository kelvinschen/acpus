import { NODE_REF } from "../internal/symbols.js";
import type { TypeIR } from "../ir/types.js";
import { expr, type Expr } from "../expressions/expr.js";

export type Primitive = string | number | boolean | null | undefined;

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
