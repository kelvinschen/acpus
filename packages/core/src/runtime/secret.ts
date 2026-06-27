import { valueToExprIR } from "../expressions/expr.js";
import { refExpr, type OutputAccessor } from "../graph/refs.js";
import { SECRET } from "../internal/symbols.js";
import type { ExprIR, SecretRefIR } from "../ir/types.js";

export const runtime = {
  runId: refExpr<string>(["runtime", "runId"]),
  nodeId: refExpr<string>(["runtime", "nodeId"]),
  workspaceDir: refExpr<string>(["runtime", "workspaceDir"]),
  outputDir: refExpr<string>(["runtime", "outputDir"]),
  now: refExpr<string>(["runtime", "now"]),
} satisfies Record<string, OutputAccessor<any>>;

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
