import { Environment } from "@marcbachmann/cel-js";
import { EXPRESSION_PATTERN, toCelParseSource } from "@acpus/core";
import type { ExpressionContext } from "./types.js";

/**
 * Wraps @marcbachmann/cel-js to evaluate ${{ expr }} templates and raw CEL
 * expressions. Registers custom functions (now, len, startsWith, matches,
 * coalesce) via Environment.registerFunction().
 */
export class ExpressionEvaluator {
  private readonly env: Environment;
  private readonly nowTimestamp: string;

  constructor(options?: { nowTimestamp?: string }) {
    this.nowTimestamp = options?.nowTimestamp ?? new Date().toISOString();
    this.env = new Environment({ unlistedVariablesAreDyn: true });

    // Register custom functions with type signatures
    this.env.registerFunction("now(): string", () => this.nowTimestamp);

    // len() overloads — string and list
    this.env.registerFunction("len(string): int", (str: string) => BigInt(str.length));
    this.env.registerFunction("len(list): int", (arr: unknown[]) => BigInt(arr.length));

    // startsWith
    this.env.registerFunction("startsWith(string, string): bool", (str: string, prefix: string) => str.startsWith(prefix));

    // matches
    this.env.registerFunction("matches(string, string): bool", (str: string, pattern: string) => {
      try {
        return new RegExp(pattern).test(str);
      } catch {
        return false;
      }
    });

    // coalesce overloads — 2 and 3 args
    this.env.registerFunction("coalesce(dyn, dyn): dyn", (a: unknown, b: unknown) => (a !== null && a !== undefined) ? a : b);
    this.env.registerFunction("coalesce(dyn, dyn, dyn): dyn", (a: unknown, b: unknown, c: unknown) => {
      if (a !== null && a !== undefined) return a;
      if (b !== null && b !== undefined) return b;
      return c;
    });
  }

  /**
   * The deterministic timestamp bound to now(). Exposed so the interpreter can
   * stamp control outputs (e.g. approval `at`) without reading wall-clock time.
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
      steps: ctx.steps,
      run_id: ctx.run_id
    };

    if (ctx.loop !== undefined) {
      // toCelParseSource rewrites loop. → loop_ctx.
      bindings.loop_ctx = ctx.loop;
    }

    if (ctx.item !== undefined) {
      bindings.item = ctx.item;
    }

    if (ctx.item_id !== undefined) {
      bindings.item_id = ctx.item_id;
    }

    if (ctx.item_index !== undefined) {
      bindings.item_index = ctx.item_index;
    }

    return bindings;
  }
}
