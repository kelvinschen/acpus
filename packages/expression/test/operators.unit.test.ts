import { describe, expect, it } from "vitest";
import {
  all,
  and,
  any,
  coalesce,
  eq,
  endsWith,
  fallback,
  filter,
  get,
  gt,
  gte,
  head,
  ifElse,
  includes,
  isEmpty,
  len,
  lt,
  lte,
  map,
  matches,
  max,
  min,
  ne,
  not,
  or,
  startsWith,
  template,
} from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression operators", () => {
  it("lowers scalar helpers to canonical calls", () => {
    expect(and(true, not(false), or(false, true)).ir).toEqual({
      kind: "call",
      fn: "and",
      args: [
        { kind: "literal", value: true },
        { kind: "call", fn: "not", args: [{ kind: "literal", value: false }] },
        { kind: "call", fn: "or", args: [{ kind: "literal", value: false }, { kind: "literal", value: true }] },
      ],
    });
    expect(ifElse(true, "yes", "no").ir).toEqual({
      kind: "call",
      fn: "ifElse",
      args: [{ kind: "literal", value: true }, { kind: "literal", value: "yes" }, { kind: "literal", value: "no" }],
    });
  });

  it("lowers semantic sugar to canonical operators", () => {
    const tags = refExpr<readonly string[]>(["input", "tags"]);
    expect(head(tags).ir).toEqual({ kind: "call", fn: "get", args: [tags.ir, { kind: "literal", value: 0 }] });
    expect(isEmpty(tags).ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "call", fn: "len", args: [tags.ir] },
        { kind: "literal", value: 0 },
      ],
    });
    expect(fallback(refExpr<string | null>(["input", "name"]), "unknown").ir).toEqual({
      kind: "call",
      fn: "coalesce",
      args: [{ kind: "ref", path: ["input", "name"] }, { kind: "literal", value: "unknown" }],
    });
  });

  it("lowers collection helpers with lambdas", () => {
    const items = refExpr<readonly { done: boolean; score: number }[]>(["input", "items"]);
    expect(all(items, item => item.done).ir).toMatchObject({ kind: "call", fn: "all" });
    expect(any(items, item => item.done).ir).toMatchObject({ kind: "call", fn: "any" });
    expect(filter(items, item => item.done).ir).toMatchObject({ kind: "call", fn: "filter" });
    expect(map(items, item => item.score).ir).toMatchObject({ kind: "call", fn: "map" });
  });

  it("keeps aggregators one-argument", () => {
    const scores = refExpr<readonly number[]>(["input", "scores"]);
    expect(max(scores).ir).toEqual({ kind: "call", fn: "max", args: [scores.ir] });
    expect(min(scores).ir).toEqual({ kind: "call", fn: "min", args: [scores.ir] });
  });

  it("lowers templates as expression nodes", () => {
    expect(template`count=${len(refExpr<readonly string[]>(["input", "items"]))}`.ir).toEqual({
      kind: "template",
      template: {
        kind: "template",
        parts: [
          { kind: "text", value: "count=" },
          { kind: "expr", expr: { kind: "call", fn: "len", args: [{ kind: "ref", path: ["input", "items"] }] } },
          { kind: "text", value: "" },
        ],
      },
    });
  });

  it("lowers direct primitive helpers", () => {
    expect(eq(get(refExpr<readonly string[]>(["input", "tags"]), 0), "ready").ir).toMatchObject({ kind: "call", fn: "eq" });
    expect(ne("draft", "ready").ir).toMatchObject({ kind: "call", fn: "ne" });
    expect(lt(1, 2).ir).toMatchObject({ kind: "call", fn: "lt" });
    expect(lte(1, 1).ir).toMatchObject({ kind: "call", fn: "lte" });
    expect(gt(2, 1).ir).toMatchObject({ kind: "call", fn: "gt" });
    expect(gte(2, 2).ir).toMatchObject({ kind: "call", fn: "gte" });
    expect(includes("release/v1", "v1").ir).toMatchObject({ kind: "call", fn: "includes" });
    expect(startsWith("release/v1", "release/").ir).toMatchObject({ kind: "call", fn: "startsWith" });
    expect(endsWith("release/v1", "v1").ir).toMatchObject({ kind: "call", fn: "endsWith" });
    expect(matches("release/v1", "^release/").ir).toMatchObject({ kind: "call", fn: "matches" });
    expect(coalesce(null, "fallback").ir).toMatchObject({ kind: "call", fn: "coalesce" });
  });
});
