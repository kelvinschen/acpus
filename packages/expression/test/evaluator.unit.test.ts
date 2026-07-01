import { describe, expect, it } from "vitest";
import { evaluateExpr, ExpressionEvaluationError, renderTemplate } from "@acpus/expression/evaluator";
import { coalesce, every, filter, get, ifElse, map, max, min, some, template } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression evaluator", () => {
  const adapter = {
    resolveRef: (path: string[]) => path.join(".") === "input.items"
      ? [{ done: true, score: 2 }, { done: false, score: 5 }]
      : undefined,
  };

  it("evaluates literal expressions through the evaluator seam", () => {
    expect(evaluateExpr({ kind: "literal", value: true }, { resolveRef: () => undefined })).toBe(true);
  });

  it("formats template expression values", () => {
    expect(renderTemplate({
      kind: "template",
      parts: [
        { kind: "text", value: "value=" },
        { kind: "expr", expr: { kind: "object", fields: { ok: { kind: "literal", value: true } } } },
      ],
    }, { resolveRef: () => undefined })).toBe("value={\"ok\":true}");
  });

  it("has a structural equality seam", () => {
    expect(evaluateExpr({ kind: "call", fn: "eq", args: [{ kind: "literal", value: {} }, { kind: "literal", value: {} }] }, { resolveRef: () => undefined })).toBe(true);
  });

  it("evaluates short-circuiting and conditionals", () => {
    expect(evaluateExpr({ kind: "call", fn: "and", args: [{ kind: "literal", value: false }, { kind: "ref", path: ["missing"] }] }, adapter)).toBe(false);
    expect(evaluateExpr({ kind: "call", fn: "or", args: [{ kind: "literal", value: true }, { kind: "ref", path: ["missing"] }] }, adapter)).toBe(true);
    expect(evaluateExpr(ifElse(false, { bad: refExpr(["missing"]) }, "ok").__ir, adapter)).toBe("ok");
  });

  it("evaluates missing-safe get and nullish coalesce", () => {
    expect(evaluateExpr(get(refExpr<readonly string[]>(["input", "missing"]), 0).__ir, adapter)).toBeUndefined();
    expect(evaluateExpr(coalesce(refExpr<string | null>(["input", "missing"]), null, "fallback").__ir, adapter)).toBe("fallback");
    expect(() => evaluateExpr({ kind: "call", fn: "len", args: [{ kind: "ref", path: ["input", "missing"] }] }, adapter)).toThrow("len(...) received missing value.");
  });

  it("does not read inherited object properties through get", () => {
    const objectAdapter = { resolveRef: () => ({ own: "value" }) };
    const getKey = (key: string) => ({
      kind: "call" as const,
      fn: "get",
      args: [{ kind: "ref" as const, path: ["input", "object"] }, { kind: "literal" as const, value: key }],
    });
    const fallbackGet = (key: string) => ({
      kind: "call" as const,
      fn: "coalesce",
      args: [getKey(key), { kind: "literal" as const, value: "fallback" }],
    });

    expect(evaluateExpr(getKey("own"), objectAdapter)).toBe("value");
    expect(evaluateExpr(fallbackGet("toString"), objectAdapter)).toBe("fallback");
    expect(evaluateExpr(fallbackGet("constructor"), objectAdapter)).toBe("fallback");
    expect(evaluateExpr(fallbackGet("__proto__"), objectAdapter)).toBe("fallback");
  });

  it("evaluates scoped collection lambdas", () => {
    const items = refExpr<readonly { done: boolean; score: number }[]>(["input", "items"]);
    expect(evaluateExpr(map(items, item => item.score).__ir, adapter)).toEqual([2, 5]);
    expect(evaluateExpr(filter(items, item => item.done).__ir, adapter)).toEqual([{ done: true, score: 2 }]);
    expect(evaluateExpr(every(items, item => item.done).__ir, adapter)).toBe(false);
    expect(evaluateExpr(some(items, item => item.done).__ir, adapter)).toBe(true);
    expect(evaluateExpr(every([]).__ir, adapter)).toBe(true);
    expect(evaluateExpr(some([]).__ir, adapter)).toBe(false);
    expect(() => evaluateExpr({
      kind: "call",
      fn: "filter",
      args: [
        { kind: "ref", path: ["input", "items"] },
        { kind: "lambda", params: [{ id: "v0" }], body: { kind: "literal", value: "yes" } },
      ],
    }, adapter)).toThrow("filter(...) expected boolean, got string.");
  });

  it("preserves lambda scope inside templates and static array paths", () => {
    const rows = refExpr<readonly { name: string; tags: readonly string[] }[]>(["input", "rows"]);
    const rowAdapter = {
      resolveRef: () => [{ name: "A", tags: ["ready"] }],
    };
    expect(evaluateExpr(map(rows, row => template`${row.name}:${get(row.tags, 0)}`).__ir, rowAdapter)).toEqual(["A:ready"]);
  });

  it("fails loudly for unsupported inspected runtime values", () => {
    expect(() => renderTemplate({
      kind: "template",
      parts: [{ kind: "expr", expr: { kind: "literal", value: { x: undefined } as any } }],
    }, { resolveRef: () => undefined })).toThrow("template(...) expected JSON-compatible values.");
    expect(() => evaluateExpr({ kind: "call", fn: "eq", args: [{ kind: "literal", value: new Date(0) as any }, { kind: "literal", value: new Date(1) as any }] }, adapter)).toThrow("eq(...) expected JSON-compatible values.");
    expect(() => evaluateExpr({ kind: "call", fn: "matches", args: [{ kind: "literal", value: "x" }, { kind: "literal", value: "[" }] }, adapter)).toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpr({ kind: "call", fn: "coalesce", args: [] }, adapter)).toThrow("coalesce(...) expected at least 1 args, got 0.");
  });

  it("uses Math max/min semantics", () => {
    expect(evaluateExpr(max([]).__ir, adapter)).toBe(-Infinity);
    expect(evaluateExpr(min([]).__ir, adapter)).toBe(Infinity);
  });
});
