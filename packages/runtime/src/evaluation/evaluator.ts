import { evaluateExpr as evaluateExpression } from "@acpus/expression/evaluator";
import type { ExprIR } from "@acpus/expression/ir";

export type EvaluationScope = {
  input?: unknown;
  nodes?: Record<string, { status?: string; output?: unknown }>;
  meta?: Record<string, unknown>;
  fanout?: Record<string, unknown>;
  loop?: Record<string, unknown>;
};

export function evaluateExpr(expr: ExprIR, scope: EvaluationScope): unknown {
  return evaluateExpression(expr, { resolveRef: path => resolvePath(scope, path) });
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
