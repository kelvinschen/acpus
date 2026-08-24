import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { type ExprIR, type TemplateIR } from "@acpus/expression/ir";
import { evaluateExpr } from "../src/evaluation/evaluator.js";
import { tryCreateDeadline, tryResolveConcurrencyLimit, tryResolveDuration, tryResolveInteger, tryResolveString } from "../src/evaluation/resolvable.js";

const literal = (value: any): ExprIR => ({ kind: "literal", value });
const ref = (path: string[]): ExprIR => ({ kind: "ref", path });
const call = (fn: string, args: ExprIR[]): ExprIR => ({ kind: "call", fn, args });

describe("runtime expression evaluator", () => {
  it("classifies runtime value resolution failures", () => {
    expect(Result.getOrThrow(Result.flip(tryResolveString(literal(1), {}, "prompt")))).toMatchObject({
      type: "type",
      field: "prompt",
      expected: "string",
      actual: "number",
    });
    expect(Result.getOrThrow(Result.flip(tryResolveInteger(literal(0), {}, "count", 1)))).toMatchObject({
      type: "constraint",
      field: "count",
    });
    expect(Result.getOrThrow(Result.flip(tryResolveDuration(literal("soon"), {}, "timeout")))).toMatchObject({
      type: "constraint",
      field: "timeout",
    });
    expect(Result.getOrThrow(Result.flip(tryResolveInteger(call("lift", [literal(1), literal("value => { throw new Error('boom') }")]), {}, "count", 1)))).toMatchObject({
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
    expect(Result.getOrThrow(tryResolveConcurrencyLimit(ref(["input", "parallelism"]), { input: {} }, "maxConcurrency"))).toBeUndefined();
    expect(Result.getOrThrow(tryResolveConcurrencyLimit(literal(0), {}, "maxConcurrency"))).toBeUndefined();
    expect(Result.getOrThrow(tryResolveConcurrencyLimit(call("lift", [ref(["input", "parallelism"]), literal("value => value ?? 0")]), { input: {} }, "maxConcurrency"))).toBeUndefined();
    expect(Result.getOrThrow(tryResolveConcurrencyLimit(literal(2), {}, "maxConcurrency"))).toBe(2);
    expect(Result.getOrThrow(Result.flip(tryResolveConcurrencyLimit(literal(-1), {}, "maxConcurrency")))).toMatchObject({ type: "constraint" });
    expect(Result.getOrThrow(Result.flip(tryResolveConcurrencyLimit(literal(1.5), {}, "maxConcurrency")))).toMatchObject({ type: "constraint" });
    expect(Result.getOrThrow(Result.flip(tryResolveConcurrencyLimit(literal("many"), {}, "maxConcurrency")))).toMatchObject({ type: "type" });
  });

  it("rejects duration overflow and unrepresentable deadlines", () => {
    expect(Result.getOrThrow(tryResolveDuration(literal(String(Number.MAX_SAFE_INTEGER)), {}, "timeout"))).toEqual({
      value: String(Number.MAX_SAFE_INTEGER),
      milliseconds: Number.MAX_SAFE_INTEGER,
    });
    expect(Result.getOrThrow(Result.flip(tryResolveDuration(literal("9007199254740992ms"), {}, "timeout")))).toMatchObject({
      type: "constraint",
      field: "timeout",
    });

    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(Result.getOrThrow(tryCreateDeadline(now, 1_000, "timeout"))).toEqual(new Date("2026-01-01T00:00:01.000Z"));
    expect(Result.getOrThrow(Result.flip(tryCreateDeadline(new Date("9999-12-31T23:59:59.999Z"), 1, "timeout")))).toMatchObject({
      type: "constraint",
      field: "timeout",
    });
    expect(Result.getOrThrow(Result.flip(tryCreateDeadline(new Date(8_640_000_000_000_000), 1, "timeout")))).toMatchObject({
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

});
