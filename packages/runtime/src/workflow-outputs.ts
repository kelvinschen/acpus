import type { AcpusIr } from "@acpus/core";
import { ExpressionEvaluator } from "./evaluator.js";
import type { ExpressionContext, NodeExecutionState } from "./types.js";
import { buildWorkflowExpressionContext } from "./workflow-context.js";

export function buildCompletedStepContext(
  ir: AcpusIr,
  input: Record<string, unknown>,
  runId: string,
  nodes: NodeExecutionState[]
): ExpressionContext {
  const ctx: ExpressionContext = { input, steps: {}, workflow: buildWorkflowExpressionContext(ir), run_id: runId };
  const root = nodes.find((node) => node.nodeKey === "workflow" && node.state === "completed");
  const rootOutput = root?.output;
  if (isRecord(rootOutput) && isRecord(rootOutput.output)) {
    ctx.steps = rootOutput.output;
  }
  return ctx;
}

export function evaluateWorkflowOutputs(
  ir: AcpusIr,
  ctx: ExpressionContext,
  evaluator: ExpressionEvaluator
): Record<string, unknown> {
  return evaluateOutputObject(ir.outputs, ctx, evaluator);
}

export function evaluateOutputObject(
  values: Record<string, unknown>,
  ctx: ExpressionContext,
  evaluator: ExpressionEvaluator,
  path: string[] = []
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const nextPath = [...path, key];
    try {
      output[key] = normalizeOutputValue(evaluateTemplatedValue(value, ctx, evaluator, nextPath));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Workflow output '")) throw error;
      throw new Error(`Workflow output '${nextPath.join(".")}' failed to evaluate: ${errorMessage(error)}`);
    }
  }
  return output;
}

export function evaluateTemplatedValue(
  value: unknown,
  ctx: ExpressionContext,
  evaluator: ExpressionEvaluator,
  path: string[] = []
): unknown {
  if (typeof value === "string") {
    const single = value.match(/^\s*\$\{\{(.+)\}\}\s*$/s);
    if (single) return evaluator.evaluateExpression(single[1]!.trim(), ctx);
    return evaluator.evaluateTemplate(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => evaluateTemplatedValue(item, ctx, evaluator, [...path, String(index)]));
  }
  if (isRecord(value)) {
    return evaluateOutputObject(value, ctx, evaluator, path);
  }
  return value;
}

export function normalizeOutputValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map((item) => normalizeOutputValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeOutputValue(child)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
