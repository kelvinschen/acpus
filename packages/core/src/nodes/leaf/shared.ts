import type { Expr, Resolvable } from "@acpus/expression";
import type { SecretToken } from "../../runtime/secret.js";

export type StepInput = Record<string, Resolvable<any>>;
export type EnvInput = Record<string, Resolvable<string> | SecretToken>;
export type StaticEnvInput = Record<string, string | SecretToken>;

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
