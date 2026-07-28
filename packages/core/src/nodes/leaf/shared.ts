import type { Expr, Resolvable } from "@acpus/expression";

export type EnvInput = Record<string, Resolvable<string>>;
export type StaticEnvInput = Record<string, string>;

type IsAny<T> = 0 extends (1 & T) ? true : false;

export type MaterializedTaskInput<Input> = IsAny<Input> extends true
  ? never
  : Input extends Expr<infer Value>
    ? MaterializedTaskInput<Value>
    : Input extends readonly unknown[]
      ? { -readonly [K in keyof Input]: MaterializedTaskInput<Input[K]> }
      : Input extends object
        ? { -readonly [K in keyof Input]: MaterializedTaskInput<Input[K]> }
        : Input;
