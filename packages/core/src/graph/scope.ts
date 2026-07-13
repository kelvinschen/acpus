import type { Expr } from "@acpus/expression";
import { outputToIR } from "./lowering.js";
import type { NodeRef } from "./refs.js";
import type { NodeIR, ScopeIR } from "../ir/types.js";

type OutputPosition = "top" | "object" | "array";
type IsAny<T> = 0 extends (1 & T) ? true : false;

type DurableRuntimeValue<T, Position extends OutputPosition> =
  unknown extends T ? never
    : T extends undefined ? Position extends "object" ? undefined : never
      : T extends string | number | boolean | null ? T
        : T extends (...args: any[]) => any ? never
          : T extends abstract new (...args: any[]) => any ? never
            : T extends readonly (infer Item)[] ? readonly DurableRuntimeValue<Item, "array">[]
              : T extends object ? { readonly [K in keyof T]: DurableRuntimeValue<T[K], "object"> }
                : never;

type DurableOutput<T, Position extends OutputPosition> =
  unknown extends T ? never
    : T extends NodeRef<any> ? never
      : T extends Expr<infer Value>
        ? [Value] extends [DurableRuntimeValue<Value, Position>] ? T : never
        : T extends undefined ? never
          : T extends string | number | boolean | null ? T
            : T extends (...args: any[]) => any ? never
              : T extends abstract new (...args: any[]) => any ? never
                : T extends readonly (infer Item)[] ? readonly DurableOutput<Item, "array">[]
                  : T extends object ? { readonly [K in keyof T]: DurableOutput<T[K], "object"> }
                    : never;

type OutputCheck<T, Position extends OutputPosition> =
  [T] extends [DurableOutput<T, Position>] ? unknown : never;

type DurableTaskOutput<T, Position extends OutputPosition> =
  unknown extends T ? never
    : T extends Expr<any> | NodeRef<any> ? never
      : T extends undefined ? Position extends "array" ? never : undefined
        : T extends string | number | boolean | null ? T
          : T extends (...args: any[]) => any ? never
            : T extends abstract new (...args: any[]) => any ? never
              : T extends readonly (infer Item)[] ? readonly DurableTaskOutput<Item, "array">[]
                : T extends object ? { readonly [K in keyof T]: DurableTaskOutput<T[K], "object"> }
                  : never;

export type GraphOutputCheck<T> = IsAny<T> extends true ? never : OutputCheck<T, "top">;
export type TaskOutputCheck<T> =
  [T] extends [DurableTaskOutput<T, "top">] ? unknown : never;

type ScopeBuildState = {
  readonly nodes: NodeIR[];
};

export function buildImplicitScope<Extra extends object>(
  child: ScopeBuildState,
  fn: (ctx: Extra) => unknown,
  extra: Extra,
): ScopeIR {
  return { nodes: child.nodes, output: outputToIR(fn(extra)) };
}
