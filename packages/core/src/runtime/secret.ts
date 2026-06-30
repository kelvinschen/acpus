import { valueToExprIR } from "@acpus/expression/ir";
import { SECRET } from "../internal/symbols.js";
import type { ExprIR, SecretRefIR } from "../ir/types.js";

export type SecretToken = {
  readonly [SECRET]: true;
  readonly ir: SecretRefIR;
};

export function secret(name: string): SecretToken {
  return { [SECRET]: true as const, ir: { kind: "secret", name } };
}

export function isSecret(value: unknown): value is SecretToken {
  return Boolean(value && typeof value === "object" && (value as any)[SECRET]);
}

export function secretOrExprToIR(value: unknown): ExprIR | SecretRefIR {
  return isSecret(value) ? value.ir : valueToExprIR(value);
}
