import type { Expr } from "../../expressions/expr.js";

export type StepInput = Record<string, unknown>;

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
