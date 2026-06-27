import { describe, expect, it } from "vitest";
import { all, max, refExpr, where } from "../src/index.js";

const booleanType = { kind: "boolean" };
const integerType = { kind: "integer" };
const numberType = { kind: "number" };
const ref = (path: string[]) => ({ kind: "ref", path });
const literal = (value: unknown) => ({ kind: "literal", value });

describe("expression lowering", () => {
  it("lowers nested where filters to canonical ExprIR calls", () => {
    const review = refExpr<{
      ready: boolean;
      riskCount: number;
      issues: string[];
      summary: string;
    }>(["nodes", "review", "output"]);

    expect(where(review, {
      ready: true,
      riskCount: { lte: 3 },
      issues: { length: 0 },
      summary: { contains: "ok" },
    }).ir).toEqual({
      kind: "call",
      fn: "and",
      type: booleanType,
      args: [
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
          fn: "contains",
          type: booleanType,
          args: [ref(["nodes", "review", "output", "summary"]), literal("ok")],
        },
      ],
    });
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
});
