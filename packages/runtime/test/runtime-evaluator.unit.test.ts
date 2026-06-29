import { describe, expect, it } from "vitest";
import { refExpr, where } from "@acpus/core/expression";
import type { ExprIR, TemplateIR } from "@acpus/core/ir";
import { evaluateExpr, renderTemplate } from "../src/evaluation/evaluator.js";

const literal = (value: unknown): ExprIR => ({ kind: "literal", value });
const ref = (path: string[]): ExprIR => ({ kind: "ref", path });
const call = (fn: string, args: ExprIR[]): ExprIR => ({ kind: "call", fn, args });

describe("runtime expression evaluator", () => {
  it("resolves workflow, node, runtime, fanout, and loop refs", () => {
    const scope = {
      input: { packageName: "core", items: [{ id: "a" }] },
      nodes: { prepare: { output: { ok: true } } },
      runtime: { runId: "run_1" },
      fanout: { lane: { item: { id: "b" }, itemIndex: 3 } },
      loop: { retry: { iter: 2, previous: { summary: "again" }, result: { done: true } } },
    };

    expect(evaluateExpr(ref(["workflow", "input", "packageName"]), scope)).toBe("core");
    expect(evaluateExpr(ref(["input", "items", "0", "id"]), scope)).toBe("a");
    expect(evaluateExpr(ref(["nodes", "prepare", "output", "ok"]), scope)).toBe(true);
    expect(evaluateExpr(ref(["runtime", "runId"]), scope)).toBe("run_1");
    expect(evaluateExpr(ref(["fanout", "lane", "item", "id"]), scope)).toBe("b");
    expect(evaluateExpr(ref(["fanout", "lane", "itemIndex"]), scope)).toBe(3);
    expect(evaluateExpr(ref(["loop", "retry", "iter"]), scope)).toBe(2);
    expect(evaluateExpr(ref(["loop", "retry", "previous", "summary"]), scope)).toBe("again");
    expect(evaluateExpr(ref(["loop", "retry", "result", "done"]), scope)).toBe(true);
  });

  it("evaluates literals, arrays, objects, and current operator calls", () => {
    const expr: ExprIR = {
      kind: "object",
      fields: {
        pass: call("and", [
          call("gte", [ref(["input", "score"]), literal(80)]),
          call("includes", [ref(["input", "tags"]), literal("ready")]),
          call("not", [literal(false)]),
        ]),
        count: call("len", [ref(["input", "tags"])]),
        first: ref(["input", "tags", "0"]),
        fallback: call("coalesce", [literal(null), ref(["input", "missing"]), literal("default")]),
        high: call("max", [{ kind: "array", items: [literal(1), literal(5), literal(3)] }]),
      },
    };

    expect(evaluateExpr(expr, {
      input: { score: 91, tags: ["ready", "green"] },
    })).toEqual({
      pass: true,
      count: 2,
      first: "ready",
      fallback: "default",
      high: 5,
    });
  });

  it("evaluates string operators and aggregate boolean calls", () => {
    expect(evaluateExpr(call("and", [literal(true), literal(false)]), {})).toBe(false);
    expect(evaluateExpr(call("or", [literal(false), literal(true)]), {})).toBe(true);
    expect(evaluateExpr(call("eq", [literal(2), literal(2)]), {})).toBe(true);
    expect(evaluateExpr(call("ne", [literal(1), literal(2)]), {})).toBe(true);
    expect(evaluateExpr(call("lt", [literal(1), literal(2)]), {})).toBe(true);
    expect(evaluateExpr(call("lte", [literal(2), literal(2)]), {})).toBe(true);
    expect(evaluateExpr(call("gt", [literal(1), literal(2)]), {})).toBe(false);
    expect(evaluateExpr(call("includes", [literal("release/v1"), literal("v1")]), {})).toBe(true);
    expect(evaluateExpr(call("startsWith", [literal("release/v1"), literal("release/")]), {})).toBe(true);
    expect(evaluateExpr(call("endsWith", [literal("release/v1"), literal("v1")]), {})).toBe(true);
    expect(evaluateExpr(call("matches", [literal("release/v1"), literal("^release/")]), {})).toBe(true);
    expect(evaluateExpr(call("all", [{ kind: "array", items: [literal(true), literal(true)] }]), {})).toBe(true);
    expect(evaluateExpr(call("all", [{ kind: "array", items: [literal(true), literal(false)] }]), {})).toBe(false);
    expect(evaluateExpr(call("any", [{ kind: "array", items: [literal(false), literal(true)] }]), {})).toBe(true);
    expect(evaluateExpr(call("any", [{ kind: "array", items: [literal(false), literal(false)] }]), {})).toBe(false);
    expect(evaluateExpr(call("min", [{ kind: "array", items: [literal(4), literal(2)] }]), {})).toBe(2);
  });

  it("evaluates real where-lowered expression IR", () => {
    const review = refExpr<{
      issues: string[];
      tag: string;
      summary: string;
    }>(["nodes", "review", "output"]);
    const input = refExpr<{
      allowedTags: readonly string[];
      rejectedTags: readonly string[];
    }>(["workflow", "input"]);
    const expr = where(review, {
      issues: { length: 0 },
      tag: { in: input.allowedTags, notIn: input.rejectedTags },
      summary: { $regex: "ready" },
    });

    const baseScope = {
      input: {
        allowedTags: ["green", "ready"],
        rejectedTags: ["blocked"],
      },
    };
    expect(evaluateExpr(expr.ir, {
      ...baseScope,
      nodes: { review: { output: { issues: [], tag: "ready", summary: "ready to ship" } } },
    })).toBe(true);
    expect(evaluateExpr(expr.ir, {
      ...baseScope,
      nodes: { review: { output: { issues: [], tag: "blocked", summary: "ready to ship" } } },
    })).toBe(false);
  });

  it("renders object and array template expressions as JSON", () => {
    const template: TemplateIR = {
      kind: "template",
      parts: [
        { kind: "text", value: "payload=" },
        { kind: "expr", expr: ref(["input", "payload"]) },
        { kind: "text", value: " tags=" },
        { kind: "expr", expr: ref(["input", "tags"]) },
      ],
    };

    expect(renderTemplate(template, {
      input: {
        payload: { ok: true, count: 2 },
        tags: ["ready", "green"],
      },
    })).toBe('payload={\n  "count": 2,\n  "ok": true\n} tags=[\n  "ready",\n  "green"\n]');
    expect(evaluateExpr({ kind: "template", template }, {
      input: {
        payload: { ok: true, count: 2 },
        tags: ["ready", "green"],
      },
    })).toBe('payload={\n  "count": 2,\n  "ok": true\n} tags=[\n  "ready",\n  "green"\n]');

    expect(renderTemplate({
      kind: "template",
      parts: [
        { kind: "expr", expr: literal(undefined) },
        { kind: "text", value: "|" },
        { kind: "expr", expr: literal(null) },
        { kind: "text", value: "|" },
        { kind: "expr", expr: literal(3) },
        { kind: "text", value: "|" },
        { kind: "expr", expr: literal(false) },
        { kind: "text", value: "|" },
        { kind: "expr", expr: literal("ok") },
      ],
    }, {})).toBe("|null|3|false|ok");
  });

  it("fails loudly for unsupported calls and invalid operand types", () => {
    expect(() => evaluateExpr(call("unknown", []), {})).toThrow("Unsupported runtime expression call: unknown");
    expect(() => evaluateExpr(call("eq", [literal(1)]), {})).toThrow("eq(...) expected 2 args, got 1");
    expect(() => evaluateExpr(call("len", [literal({})]), {})).toThrow("len(...) expected string or array");
    expect(() => evaluateExpr(call("lt", [literal("1"), literal(2)]), {})).toThrow("lt(...) expected number");
    expect(() => evaluateExpr(call("and", [literal(true), literal(1)]), {})).toThrow("and(...) expected boolean");
    expect(() => evaluateExpr(call("includes", [literal("abc"), literal(1)]), {})).toThrow("includes(...) expected string");
    expect(() => evaluateExpr(call("startsWith", [literal("x"), literal(1)]), {})).toThrow("startsWith(...) expected string");
    expect(() => evaluateExpr(call("all", [literal({})]), {})).toThrow("all(...) expected array");
    expect(() => evaluateExpr(call("min", [{ kind: "array", items: [literal("x")] }]), {})).toThrow("min(...) expected number");
    expect(() => evaluateExpr(call("matches", [literal(1), literal("x")]), {})).toThrow("matches(...) expected string");
    expect(() => evaluateExpr(ref(["workflow", "name"]), {})).toThrow("Unsupported runtime ref root: workflow");
  });
});
