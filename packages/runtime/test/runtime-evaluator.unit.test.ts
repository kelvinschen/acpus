import { describe, expect, it } from "vitest";
import { lift } from "@acpus/expression";
import { refExpr, type ExprIR, type TemplateIR } from "@acpus/expression/ir";
import { evaluateExpr } from "../src/evaluation/evaluator.js";
import { tryCreateDeadline, tryResolveConcurrencyLimit, tryResolveDuration, tryResolveInteger, tryResolveString } from "../src/evaluation/resolvable.js";

const literal = (value: any): ExprIR => ({ kind: "literal", value });
const ref = (path: string[]): ExprIR => ({ kind: "ref", path });
const call = (fn: string, args: ExprIR[]): ExprIR => ({ kind: "call", fn, args });

describe("runtime expression evaluator", () => {
  it("classifies runtime value resolution failures", () => {
    expect(tryResolveString(literal(1), {}, "prompt")._unsafeUnwrapErr()).toMatchObject({
      type: "type",
      field: "prompt",
      expected: "string",
      actual: "number",
    });
    expect(tryResolveInteger(literal(0), {}, "count", 1)._unsafeUnwrapErr()).toMatchObject({
      type: "constraint",
      field: "count",
    });
    expect(tryResolveDuration(literal("soon"), {}, "timeout")._unsafeUnwrapErr()).toMatchObject({
      type: "constraint",
      field: "timeout",
    });
    expect(tryResolveInteger(call("lift", [literal(1), literal("value => { throw new Error('boom') }")]), {}, "count", 1)._unsafeUnwrapErr()).toMatchObject({
      type: "evaluation",
      field: "count",
      message: expect.stringContaining("boom"),
    });
    expect(() => tryResolveString(ref(["workflow", "name"]), {}, "prompt")).toThrow(
      "Unsupported expression ref root: workflow.",
    );
  });

  it("does not reclassify an unexpected evaluation-adapter failure", () => {
    const sentinel = { type: "artifact-store-failed" };
    const expression: TemplateIR = { kind: "template", parts: [{ kind: "expr", expr: literal("artifact") }] };
    let caught: unknown;

    try {
      tryResolveString(expression, {}, "prompt", { formatTemplateValue: () => { throw sentinel; } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
  });

  it("treats missing and zero concurrency limits as omitted", () => {
    expect(tryResolveConcurrencyLimit(ref(["input", "parallelism"]), { input: {} }, "maxConcurrency")._unsafeUnwrap()).toBeUndefined();
    expect(tryResolveConcurrencyLimit(literal(0), {}, "maxConcurrency")._unsafeUnwrap()).toBeUndefined();
    expect(tryResolveConcurrencyLimit(call("lift", [ref(["input", "parallelism"]), literal("value => value ?? 0")]), { input: {} }, "maxConcurrency")._unsafeUnwrap()).toBeUndefined();
    expect(tryResolveConcurrencyLimit(literal(2), {}, "maxConcurrency")._unsafeUnwrap()).toBe(2);
    expect(tryResolveConcurrencyLimit(literal(-1), {}, "maxConcurrency")._unsafeUnwrapErr()).toMatchObject({ type: "constraint" });
    expect(tryResolveConcurrencyLimit(literal(1.5), {}, "maxConcurrency")._unsafeUnwrapErr()).toMatchObject({ type: "constraint" });
    expect(tryResolveConcurrencyLimit(literal("many"), {}, "maxConcurrency")._unsafeUnwrapErr()).toMatchObject({ type: "type" });
  });

  it("rejects duration overflow and unrepresentable deadlines", () => {
    expect(tryResolveDuration(literal(String(Number.MAX_SAFE_INTEGER)), {}, "timeout")._unsafeUnwrap()).toEqual({
      value: String(Number.MAX_SAFE_INTEGER),
      milliseconds: Number.MAX_SAFE_INTEGER,
    });
    expect(tryResolveDuration(literal("9007199254740992ms"), {}, "timeout")._unsafeUnwrapErr()).toMatchObject({
      type: "constraint",
      field: "timeout",
    });

    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(tryCreateDeadline(now, 1_000, "timeout")._unsafeUnwrap()).toEqual(new Date("2026-01-01T00:00:01.000Z"));
    expect(tryCreateDeadline(new Date("9999-12-31T23:59:59.999Z"), 1, "timeout")._unsafeUnwrapErr()).toMatchObject({
      type: "constraint",
      field: "timeout",
    });
    expect(tryCreateDeadline(new Date(8_640_000_000_000_000), 1, "timeout")._unsafeUnwrapErr()).toMatchObject({
      type: "constraint",
      field: "timeout",
    });
  });

  it("resolves workflow, node, meta, fanout, and loop refs", () => {
    const scope = {
      input: { packageName: "core", items: [{ id: "a" }] },
      nodes: { prepare: { output: { ok: true } } },
      meta: { runId: "run_1" },
      fanout: { lane: { item: { id: "b" }, itemIndex: 3 } },
      loop: { retry: { index: 2, round: 3, state: { summary: "again" } } },
    };

    expect(evaluateExpr(ref(["workflow", "input", "packageName"]), scope)).toBe("core");
    expect(evaluateExpr(ref(["input", "items", "0", "id"]), scope)).toBe("a");
    expect(evaluateExpr(ref(["nodes", "prepare", "output", "ok"]), scope)).toBe(true);
    expect(evaluateExpr(ref(["meta", "runId"]), scope)).toBe("run_1");
    expect(evaluateExpr(ref(["fanout", "lane", "item", "id"]), scope)).toBe("b");
    expect(evaluateExpr(ref(["fanout", "lane", "itemIndex"]), scope)).toBe(3);
    expect(evaluateExpr(ref(["loop", "retry", "index"]), scope)).toBe(2);
    expect(evaluateExpr(ref(["loop", "retry", "round"]), scope)).toBe(3);
    expect(evaluateExpr(ref(["loop", "retry", "state", "summary"]), scope)).toBe("again");
  });

  it("does not expose array prototype or non-canonical array refs", () => {
    const scope = { input: { items: [{ id: "a" }] } };

    expect(evaluateExpr(ref(["input", "items", "length"]), scope)).toBeUndefined();
    expect(evaluateExpr(ref(["input", "items", "map"]), scope)).toBeUndefined();
    expect(evaluateExpr(ref(["input", "items", "01"]), scope)).toBeUndefined();
    expect(evaluateExpr(ref(["input", "items", "0", "id"]), scope)).toBe("a");
  });

  it("delegates expression objects and calls through the workflow adapter", () => {
    const expr: ExprIR = {
      kind: "object",
      fields: {
        first: ref(["input", "tags", "0"]),
        fallback: call("lift", [ref(["input", "tags"]), literal("tags => tags[2] ?? \"default\"")]),
      },
    };

    expect(evaluateExpr(expr, {
      input: { tags: ["ready", "green"] },
    })).toEqual({
      first: "ready",
      fallback: "default",
    });
  });

  it("evaluates real lift-lowered expression IR", () => {
    const review = refExpr<{
      issues: string[];
      tag: string;
      summary: string;
    }>(["nodes", "review", "output"]);
    const expr = lift(review, value => value.issues.length === 0 && /ready/.test(value.summary));

    expect(evaluateExpr(expr.__ir, {
      input: {},
      nodes: { review: { output: { issues: [], tag: "ready", summary: "ready to ship" } } },
    })).toBe(true);
    expect(evaluateExpr(expr.__ir, {
      input: {},
      nodes: { review: { output: { issues: ["blocked"], tag: "ready", summary: "ready to ship" } } },
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

    expect(evaluateExpr(template, {
      input: {
        payload: { ok: true, count: 2 },
        tags: ["ready", "green"],
      },
    })).toBe('payload={"ok":true,"count":2} tags=["ready","green"]');

    expect(() => evaluateExpr({
      kind: "template",
      parts: [{ kind: "expr", expr: ref(["input", "invalid"]) }],
    }, { input: { invalid: () => undefined } })).toThrow("template(...) expected JSON-compatible values.");
  });

  it("fails loudly for unsupported calls and invalid operand types", () => {
    expect(() => evaluateExpr(call("unknown", []), {})).toThrow("Unsupported expression operator: unknown.");
    expect(() => evaluateExpr(ref(["workflow", "name"]), {})).toThrow("Unsupported expression ref root: workflow");
  });
});
