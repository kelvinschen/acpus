import { describe, expect, it } from "vitest";
import { evaluateExpr, ExpressionEvaluationError, renderTemplate } from "@acpus/expression/evaluator";
import { add, coalesce, divide, every, filter, get, ifElse, join, map, max, min, mod, multiply, some, subtract, template, transform } from "@acpus/expression";
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

  it("evaluates arithmetic helpers with JavaScript number semantics", () => {
    expect(evaluateExpr(add(2, 3).__ir, adapter)).toBe(5);
    expect(evaluateExpr(subtract(5, 3).__ir, adapter)).toBe(2);
    expect(evaluateExpr(multiply(4, 3).__ir, adapter)).toBe(12);
    expect(evaluateExpr(divide(8, 2).__ir, adapter)).toBe(4);
    expect(evaluateExpr(mod(7, 3).__ir, adapter)).toBe(1);
    expect(evaluateExpr(divide(1, 0).__ir, adapter)).toBe(Infinity);
    expect(Number.isNaN(evaluateExpr(mod(1, 0).__ir, adapter))).toBe(true);
    expect(evaluateExpr(multiply(Number.MAX_VALUE, Number.MAX_VALUE).__ir, adapter)).toBe(Infinity);
    expect(() => evaluateExpr(add(1 as any, "x" as any).__ir, adapter)).toThrow("add(...) expected number, got string.");
  });

  it("preserves lambda scope inside templates and static array paths", () => {
    const rows = refExpr<readonly { name: string; tags: readonly string[] }[]>(["input", "rows"]);
    const rowAdapter = {
      resolveRef: () => [{ name: "A", tags: ["ready"] }],
    };
    expect(evaluateExpr(map(rows, row => template`${row.name}:${get(row.tags, 0)}`).__ir, rowAdapter)).toEqual(["A:ready"]);
    expect(evaluateExpr(join(map(rows, row => template`- ${row.name}:${get(row.tags, 0)}`), "\n").__ir, rowAdapter)).toBe("- A:ready");
    expect(renderTemplate({
      kind: "template",
      parts: [
        { kind: "text", value: "rows=" },
        { kind: "expr", expr: map(rows, row => row.name).__ir },
      ],
    }, rowAdapter)).toBe("rows=[\"A\"]");
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

  it("evaluates runtime transforms over JSON values", () => {
    const count = refExpr<number>(["input", "count"]);
    const issue = refExpr<{ title: string; labels: readonly string[] }>(["input", "issue"]);
    const transformAdapter = {
      resolveRef: (path: string[]) => {
        if (path.join(".") === "input.count") return 2;
        if (path.join(".") === "input.issue") return { title: "  Ship  ", labels: ["urgent"] };
        return undefined;
      },
    };

    expect(evaluateExpr(transform(count, value => value + 1).__ir, transformAdapter)).toBe(3);
    expect(evaluateExpr(transform(issue, value => ({
      title: value.title.trim(),
      urgent: value.labels.includes("urgent"),
    })).__ir, transformAdapter)).toEqual({ title: "Ship", urgent: true });
    expect(evaluateExpr(transform(issue, value => value.labels.map(label => label.toUpperCase())).__ir, transformAdapter)).toEqual(["URGENT"]);
    expect(evaluateExpr(transform(issue, value => ({
      meta: {
        labels: value.labels.map(label => label.toUpperCase()),
      },
    })).__ir, transformAdapter)).toEqual({ meta: { labels: ["URGENT"] } });
  });

  it("rejects invalid transform callbacks and outputs", () => {
    const evaluateTransformSource = (source: string) => evaluateExpr({
      kind: "call",
      fn: "transform",
      args: [{ kind: "literal", value: 1 }, { kind: "literal", value: source }],
    }, adapter);

    expect(() => evaluateExpr({ kind: "call", fn: "transform", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: "1" }] }, adapter))
      .toThrow("transform(...) source did not evaluate to a function.");
    expect(() => evaluateExpr({ kind: "call", fn: "transform", args: [{ kind: "literal", value: 1 }, { kind: "ref", path: ["input", "source"] }] }, adapter))
      .toThrow("transform(...) expected callback source string.");
    expect(() => evaluateExpr(transform(1, () => Promise.resolve(1)).__ir, adapter))
      .toThrow("transform(...) callback must return synchronously.");
    for (const source of [
      "() => new Date(0)",
      "() => () => 1",
      "() => new (class View {})()",
      "() => new Map()",
      "() => new Set()",
      "() => Symbol('x')",
      "() => 1n",
      "() => ({ nested: { bad: Number.POSITIVE_INFINITY } })",
      "() => { const items = []; items[1] = 'x'; return items; }",
      "() => { const value = {}; value.self = value; return value; }",
      "() => ({ bad: undefined })",
    ]) {
      expect(() => evaluateTransformSource(source)).toThrow("transform(...) expected JSON-compatible values.");
    }
    expect(() => evaluateExpr(transform(1, () => {
      throw new Error("boom");
    }).__ir, adapter))
      .toThrow("transform(...) callback threw: boom");
    expect(() => evaluateExpr(transform(1, () => {
      throw new Error("boom");
    }).__ir, adapter))
      .toThrow(ExpressionEvaluationError);
    expect(() => evaluateExpr(transform(refExpr<number>(["input", "missing"]), value => value + 1).__ir, adapter))
      .toThrow("transform(...) received missing value.");
  });
});
