import { evaluateExpr as evaluateExpression, ExpressionEvaluationError } from "@acpus/expression/evaluator";
import type { ExprIR } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";

export type EvaluationOptions = {
  formatTemplateValue?(value: unknown): string | undefined;
};

export type EvaluationScope = {
  input?: unknown;
  nodes?: Record<string, { status?: string; output?: unknown }>;
  meta?: Record<string, unknown>;
  fanout?: Record<string, unknown>;
  loop?: Record<string, unknown>;
};

export type ExpressionEvaluationFailure = {
  type: "expression-evaluation";
  message: string;
};

export function evaluateExpr(expr: ExprIR, scope: EvaluationScope, options?: EvaluationOptions): unknown {
  return evaluateExpression(expr, {
    resolveRef: path => resolvePath(scope, path),
    ...(options?.formatTemplateValue ? { formatTemplateValue: options.formatTemplateValue } : {}),
  });
}

export function tryEvaluateExpr(expr: ExprIR, scope: EvaluationScope, options?: EvaluationOptions): Result<unknown, ExpressionEvaluationFailure> {
  try {
    return ok(evaluateExpr(expr, scope, options));
  } catch (error) {
    if (!(error instanceof ExpressionEvaluationError)) throw error;
    return err({ type: "expression-evaluation", message: error.message });
  }
}

function resolvePath(scope: EvaluationScope, path: string[]): unknown {
  const normalized = path[0] === "workflow" && path[1] === "input" ? ["input", ...path.slice(2)] : path;
  if (!["input", "nodes", "meta", "fanout", "loop"].includes(normalized[0] ?? "")) {
    throw new Error(`Unsupported expression ref root: ${path[0] ?? "(empty)"}.`);
  }
  let value: unknown = scope;
  for (const segment of normalized) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      if (!isCanonicalArrayIndex(segment)) return undefined;
      value = value[Number(segment)];
      continue;
    }
    if (typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function isCanonicalArrayIndex(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}
