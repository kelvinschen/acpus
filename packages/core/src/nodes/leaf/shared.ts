import type { Expr, Resolvable } from "@acpus/expression";

export type StepInput = Record<string, Resolvable<any>>;
export type EnvInput = Record<string, Resolvable<string>>;
export type StaticEnvInput = Record<string, string>;

export type GraphInput<Input extends StepInput> = {
  readonly [K in keyof Input]: Input[K];
};

export type RuntimeInput<Input> = Input extends Expr<infer Value>
  ? Value
  : Input extends readonly (infer Item)[]
    ? RuntimeInput<Item>[]
    : Input extends object
      ? { [K in keyof Input]: RuntimeInput<Input[K]> }
      : Input;
