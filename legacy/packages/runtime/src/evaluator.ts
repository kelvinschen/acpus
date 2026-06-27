import { createAcpusCelEnvironment, EXPRESSION_PATTERN, toCelParseSource } from "@acpus/core";
import type { Environment } from "@marcbachmann/cel-js";
import type { ExpressionContext } from "./types.js";

function celInt(value: number): bigint | number {
  return Number.isSafeInteger(value) ? BigInt(value) : value;
}

function bindLoop(loop: ExpressionContext["loop"]): Record<string, unknown> | undefined {
  if (!loop) return undefined;
  return { ...loop, iter: celInt(loop.iter), last: bindStepValue(loop.last) };
}

function bindSteps(steps: ExpressionContext["steps"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(steps).map(([id, value]) => [id, bindStepValue(value)]));
}

function bindStepValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bindStepValue);
  if (value instanceof Map) return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const bound = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, bindStepValue(child)]));
    if ("output" in record && typeof record.exit_code === "number" && Number.isSafeInteger(record.exit_code)) {
      bound.exit_code = BigInt(record.exit_code);
    }
    return bound;
  }
  return value;
}

/**
 * Wraps @marcbachmann/cel-js to evaluate ${{ expr }} templates and raw CEL
 * expressions with the same Acpus CEL environment used by compiler lint.
 */
export class ExpressionEvaluator {
  private readonly env: Environment;
  private readonly nowTimestamp: string;

  constructor(options?: { nowTimestamp?: string }) {
    this.nowTimestamp = options?.nowTimestamp ?? new Date().toISOString();
    this.env = createAcpusCelEnvironment({ unlistedVariablesAreDyn: true, nowTimestamp: this.nowTimestamp });
  }

  /**
   * The deterministic timestamp bound to now(). Exposed so callers can stamp
   * outputs against the workflow clock without reading wall-clock time.
   */
  getNow(): string {
    return this.nowTimestamp;
  }

  /**
   * Evaluate a ${{ expr }} template by finding all expression patterns,
   * evaluating each, and substituting the results.
   */
  evaluateTemplate(template: string, ctx: ExpressionContext): string {
    return template.replace(EXPRESSION_PATTERN, (_match, expr: string) => {
      const result = this.evaluateExpression(expr.trim(), ctx);
      return String(result);
    });
  }

  /**
   * Evaluate a raw CEL expression against the given context.
   */
  evaluateExpression(expr: string, ctx: ExpressionContext): unknown {
    const celSource = toCelParseSource(expr);
    const bindings = this.buildBindings(ctx);
    return this.env.evaluate(celSource, bindings);
  }

  /**
   * Evaluate a fanout `over` expression and validate the result is an array.
   */
  evaluateOverExpression(expr: string, ctx: ExpressionContext): unknown[] {
    const result = this.evaluateExpression(expr, ctx);
    if (!Array.isArray(result)) {
      throw new Error(`fanout.over expression must evaluate to an array, got ${typeof result}: ${expr}`);
    }
    return result;
  }

  /**
   * Build the CEL variable bindings from the expression context.
   * Transforms loop → loop_ctx to match the toCelParseSource rewriting.
   */
  private buildBindings(ctx: ExpressionContext): Record<string, unknown> {
    const bindings: Record<string, unknown> = {
      input: ctx.input,
      steps: bindSteps(ctx.steps),
      workflow: ctx.workflow,
      run_id: ctx.run_id
    };

    if (ctx.loop !== undefined) {
      // toCelParseSource rewrites loop. → loop_ctx.
      bindings.loop_ctx = bindLoop(ctx.loop);
    }

    if (ctx.item !== undefined) {
      bindings.item = ctx.item;
    }

    if (ctx.item_id !== undefined) {
      bindings.item_id = ctx.item_id;
    }

    if (ctx.item_index !== undefined) {
      bindings.item_index = celInt(ctx.item_index);
    }

    return bindings;
  }
}
