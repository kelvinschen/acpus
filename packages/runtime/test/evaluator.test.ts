import { describe, it, expect } from "vitest";
import { ExpressionEvaluator } from "../src/evaluator.js";
import type { ExpressionContext } from "../src/types.js";

function baseCtx(overrides?: Partial<ExpressionContext>): ExpressionContext {
  return {
    input: { name: "test", count: 3 },
    steps: {},
    run_id: "run-001",
    ...overrides
  };
}

describe("ExpressionEvaluator", () => {
  const evaluator = new ExpressionEvaluator({ nowTimestamp: "2025-01-01T00:00:00Z" });

  describe("evaluateTemplate", () => {
    it("substitutes a simple input variable", () => {
      const result = evaluator.evaluateTemplate("${{ input.name }}", baseCtx());
      expect(result).toBe("test");
    });

    it("substitutes multiple expressions", () => {
      const result = evaluator.evaluateTemplate(
        "Hello ${{ input.name }}, count=${{ input.count }}",
        baseCtx()
      );
      expect(result).toBe("Hello test, count=3");
    });

    it("returns the original string when no expressions", () => {
      const result = evaluator.evaluateTemplate("plain text", baseCtx());
      expect(result).toBe("plain text");
    });
  });

  describe("evaluateExpression", () => {
    it("evaluates input access", () => {
      expect(evaluator.evaluateExpression("input.name", baseCtx())).toBe("test");
    });

    it("evaluates step references", () => {
      const ctx = baseCtx({ steps: { "step-a": { result: "done" } } });
      expect(evaluator.evaluateExpression('steps["step-a"].result', ctx)).toBe("done");
    });

    it("evaluates run_id", () => {
      expect(evaluator.evaluateExpression("run_id", baseCtx())).toBe("run-001");
    });

    it("evaluates loop context with loop_ctx rewriting", () => {
      const ctx = baseCtx({ loop: { iter: 5, last: "prev" } });
      // toCelParseSource rewrites loop. → loop_ctx.
      expect(Number(evaluator.evaluateExpression("loop.iter", ctx))).toBe(5);
    });

    it("evaluates fanout item context", () => {
      const ctx = baseCtx({ item: "file-a", item_id: "file-a", item_index: 0 });
      expect(evaluator.evaluateExpression("item", ctx)).toBe("file-a");
      expect(Number(evaluator.evaluateExpression("item_index", ctx))).toBe(0);
    });
  });

  describe("custom functions", () => {
    it("now() returns deterministic timestamp", () => {
      const result = evaluator.evaluateExpression("now()", baseCtx());
      expect(result).toBe("2025-01-01T00:00:00Z");
    });

    it("len() returns string length", () => {
      const result = evaluator.evaluateExpression('len("hello")', baseCtx());
      expect(Number(result)).toBe(5);
    });

    it("len() returns array length", () => {
      const ctx = baseCtx({ input: { items: [1, 2, 3] } });
      const result = evaluator.evaluateExpression("len(input.items)", ctx);
      expect(Number(result)).toBe(3);
    });

    it("startsWith() works", () => {
      expect(evaluator.evaluateExpression('startsWith("hello", "hel")', baseCtx())).toBe(true);
      expect(evaluator.evaluateExpression('startsWith("hello", "xyz")', baseCtx())).toBe(false);
    });

    it("matches() works with regex", () => {
      expect(evaluator.evaluateExpression('matches("hello", "hel.*")', baseCtx())).toBe(true);
    });

    it("coalesce() returns first non-null", () => {
      const result = evaluator.evaluateExpression("coalesce(null, null, 42)", baseCtx());
      expect(Number(result)).toBe(42);
    });
  });

  describe("evaluateOverExpression", () => {
    it("evaluates fanout over expression returning array", () => {
      const ctx = baseCtx({ input: { files: ["a.txt", "b.txt"] } });
      const result = evaluator.evaluateOverExpression("input.files", ctx);
      expect(result).toEqual(["a.txt", "b.txt"]);
    });

    it("throws when result is not an array", () => {
      expect(() =>
        evaluator.evaluateOverExpression("input.name", baseCtx())
      ).toThrow("must evaluate to an array");
    });
  });

  describe("error handling", () => {
    it("throws on undefined variable access", () => {
      expect(() =>
        evaluator.evaluateExpression("nonexistent_var", baseCtx())
      ).toThrow();
    });
  });
});
