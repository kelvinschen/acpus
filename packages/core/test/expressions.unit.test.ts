import { describe, expect, it } from "vitest";
import { all, head, includes, isEmpty, max, nth, refExpr, where } from "../src/index.js";
import type { ExprIR } from "../src/index.js";

const booleanType = { kind: "boolean" };
const integerType = { kind: "integer" };
const numberType = { kind: "number" };
const ref = (path: string[]) => ({ kind: "ref", path });
const literal = (value: unknown) => ({ kind: "literal", value });
const expectCall = (expr: ExprIR, fn: string) => {
  expect(expr).toMatchObject({ kind: "call", fn });
  if (expr.kind !== "call") {
    throw new Error(`Expected ${fn} call expression`);
  }
  return expr;
};

describe("expression lowering", () => {
  it("lowers nested where filters to canonical ExprIR calls", () => {
    const review = refExpr<{
      ready: boolean;
      riskCount: number;
      issues: string[];
      summary: string;
    }>(["nodes", "review", "output"]);

    const expr = where(review, {
      ready: true,
      riskCount: { lte: 3 },
      issues: { length: 0 },
      summary: { contains: "ok" },
    }).ir;

    const call = expectCall(expr, "and");
    expect(call.args).toHaveLength(4);
    expect(call.args).toEqual(expect.arrayContaining([
        {
          kind: "call",
          fn: "eq",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "ready"]), literal(true)],
        },
        {
          kind: "call",
          fn: "lte",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "riskCount"]), literal(3)],
        },
        {
          kind: "call",
          fn: "eq",
          type: booleanType,
          args: [
            {
              kind: "call",
              fn: "len",
              type: integerType,
              args: [ref(["nodes", "review", "output", "issues"])],
            },
            literal(0),
          ],
        },
        {
          kind: "call",
          fn: "includes",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "summary"]), literal("ok")],
        },
    ]));
  });

  it("lowers where workflow-value filters to primitive calls", () => {
    const review = refExpr<{
      ready: boolean;
      branch: string;
      score: number;
      tag: string;
    }>(["nodes", "review", "output"]);
    const input = refExpr<{
      ready: boolean;
      branch: string;
      minScore: number;
      allowedTags: readonly string[];
      rejectedTags: readonly string[];
    }>(["workflow", "input"]);

    const expr = where(review, {
      ready: input.ready,
      branch: input.branch,
      score: { gte: input.minScore },
      tag: { in: input.allowedTags, notIn: input.rejectedTags },
    }).ir;

    const call = expectCall(expr, "and");
    expect(call.args).toEqual(expect.arrayContaining([
        {
          kind: "call",
          fn: "eq",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "ready"]), ref(["workflow", "input", "ready"])],
        },
        {
          kind: "call",
          fn: "eq",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "branch"]), ref(["workflow", "input", "branch"])],
        },
        {
          kind: "call",
          fn: "gte",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "score"]), ref(["workflow", "input", "minScore"])],
        },
        {
          kind: "call",
          fn: "and",
          type: booleanType,
          args: [
            {
              kind: "call",
              fn: "includes",
              type: booleanType,
              args: [ref(["workflow", "input", "allowedTags"]), ref(["nodes", "review", "output", "tag"])],
            },
            {
              kind: "call",
              fn: "not",
              type: booleanType,
              args: [
                {
                  kind: "call",
                  fn: "includes",
                  type: booleanType,
                  args: [ref(["workflow", "input", "rejectedTags"]), ref(["nodes", "review", "output", "tag"])],
                },
              ],
            },
          ],
        },
    ]));
  });

  it("lowers primitive where filters and Mongo aliases to the same primitives", () => {
    const risk = refExpr<number>(["nodes", "review", "output", "riskCount"]);
    const summary = refExpr<string>(["nodes", "review", "output", "summary"]);

    expect(where(risk, { $gte: 1, $lte: 3 }).ir).toEqual({
      kind: "call",
      fn: "and",
      type: booleanType,
      args: [
        {
          kind: "call",
          fn: "gte",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "riskCount"]), literal(1)],
        },
        {
          kind: "call",
          fn: "lte",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "riskCount"]), literal(3)],
        },
      ],
    });

    expect(where(summary, { $regex: "ready" }).ir).toEqual({
      kind: "call",
      fn: "matches",
      type: booleanType,
      args: [ref(["nodes", "review", "output", "summary"]), literal("ready")],
    });
  });

  it("lowers collection helpers with selector callbacks", () => {
    const reviews = [
      refExpr<{ ready: boolean; riskCount: number }>(["reviews", "0"]),
      refExpr<{ ready: boolean; riskCount: number }>(["reviews", "1"]),
    ];

    expect(all(reviews, review => review.ready).ir).toEqual({
      kind: "call",
      fn: "all",
      type: booleanType,
      args: [
        {
          kind: "array",
          items: [ref(["reviews", "0", "ready"]), ref(["reviews", "1", "ready"])],
        },
      ],
    });

    expect(max(reviews, review => review.riskCount).ir).toEqual({
      kind: "call",
      fn: "max",
      type: numberType,
      args: [
        {
          kind: "array",
          items: [ref(["reviews", "0", "riskCount"]), ref(["reviews", "1", "riskCount"])],
        },
      ],
    });
  });

  it("lowers ref-backed collection access helpers to index ref paths", () => {
    const reviews = refExpr<Array<{ ready: boolean; summary: string }>>(["nodes", "reviews", "output"]);

    expect(head(reviews).summary.ir).toEqual(ref(["nodes", "reviews", "output", "0", "summary"]));
    expect(nth(reviews, 2).ready.ir).toEqual(ref(["nodes", "reviews", "output", "2", "ready"]));
  });

  it("lowers lodash-style collection helpers", () => {
    const tags = refExpr<readonly string[]>(["workflow", "input", "tags"]);
    const summary = refExpr<string>(["nodes", "review", "output", "summary"]);

    expect(includes(tags, "ready").ir).toEqual({
      kind: "call",
      fn: "includes",
      type: booleanType,
      args: [ref(["workflow", "input", "tags"]), literal("ready")],
    });
    expect(includes(summary, "ready").ir).toEqual({
      kind: "call",
      fn: "includes",
      type: booleanType,
      args: [ref(["nodes", "review", "output", "summary"]), literal("ready")],
    });
    expect(isEmpty(tags).ir).toEqual({
      kind: "call",
      fn: "eq",
      type: booleanType,
      args: [
        {
          kind: "call",
          fn: "len",
          type: integerType,
          args: [ref(["workflow", "input", "tags"])],
        },
        literal(0),
      ],
    });
  });
});
