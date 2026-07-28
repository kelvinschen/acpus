import type { Expr } from "@acpus/expression";
import { durableValueToIR } from "./lowering.js";
import type { NodeRef } from "./refs.js";
import type { NodeIR, ScopeIR } from "../ir/types.js";

type DurablePosition = "top" | "object" | "array";
type IsAny<T> = 0 extends (1 & T) ? true : false;

type DurableRuntimeValue<T, Position extends DurablePosition> =
  unknown extends T ? never
    : T extends Expr<any> | NodeRef<any> ? never
      : T extends undefined ? Position extends "object" ? undefined : never
        : T extends string | number | boolean | null ? T
          : T extends (...args: any[]) => any ? never
              : T extends abstract new (...args: any[]) => any ? never
                : T extends readonly (infer Item)[] ? readonly DurableRuntimeValue<Item, "array">[]
                : T extends object
                  ? [Extract<keyof T, symbol>] extends [never]
                    ? [keyof T] extends [never]
                      ? string extends T ? T : never
                      : {
                          readonly [K in keyof T]: DurableRuntimeValue<
                            {} extends Pick<T, K> ? Exclude<T[K], undefined> : T[K],
                            "top"
                          >
                        }
                    : never
                  : never;

type DurableAuthoredValue<T, Position extends DurablePosition> =
  unknown extends T ? never
    : T extends NodeRef<any> ? never
      : T extends Expr<infer Value>
        ? [Value] extends [DurableRuntimeValue<Value, Position>] ? T : never
        : T extends undefined ? never
          : T extends string | number | boolean | null ? T
              : T extends (...args: any[]) => any ? never
              : T extends abstract new (...args: any[]) => any ? never
                : T extends readonly (infer Item)[] ? readonly DurableAuthoredValue<Item, "array">[]
                  : T extends object
                    ? [Extract<keyof T, symbol>] extends [never]
                      ? [keyof T] extends [never]
                        ? string extends T ? T : never
                        : { readonly [K in keyof T]: DurableAuthoredValue<T[K], "object"> }
                      : never
                    : never;

export type DurableAuthoredValueCheck<T> = IsAny<T> extends true
  ? never
  : [T] extends [DurableAuthoredValue<T, "top">] ? unknown : never;

type DurableTaskOutput<T, Position extends DurablePosition> =
  unknown extends T ? never
    : T extends Expr<any> | NodeRef<any> ? never
      : T extends undefined ? Position extends "array" ? never : undefined
        : T extends string | number | boolean | null ? T
          : T extends (...args: any[]) => any ? never
            : T extends abstract new (...args: any[]) => any ? never
              : T extends readonly (infer Item)[] ? readonly DurableTaskOutput<Item, "array">[]
                : T extends object
                  ? [Extract<keyof T, symbol>] extends [never]
                    ? [keyof T] extends [never]
                      ? string extends T ? T : never
                      : { readonly [K in keyof T]: DurableTaskOutput<T[K], "object"> }
                    : never
                  : never;

export type GraphOutputCheck<T> = DurableAuthoredValueCheck<T>;
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
  return { nodes: child.nodes, output: durableValueToIR(fn(extra)) };
}
