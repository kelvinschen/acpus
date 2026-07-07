import type { ExprIR } from "@acpus/expression/ir";
import { evaluateExpr, type EvaluationScope } from "./evaluator.js";

export function evaluateLoopMaxIterations(expr: ExprIR, scope: EvaluationScope, nodeId: string): number {
  const value = evaluateExpr(expr, scope);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Loop node '${nodeId}' maxIterations must evaluate to a non-negative integer.`);
  }
  return value;
}
