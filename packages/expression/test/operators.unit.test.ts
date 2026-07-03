import { describe, expect, it } from "vitest";
import {
  and,
  coalesce,
  eq,
  endsWith,
  every,
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
  md,
  min,
  ne,
  not,
  or,
  some,
  startsWith,
  template,
} from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression operators", () => {
  it("lowers scalar helpers to canonical calls", () => {
    expect(and(true, not(false), or(false, true)).__ir).toEqual({
      kind: "call",
      fn: "and",
      args: [
        { kind: "literal", value: true },
        { kind: "call", fn: "not", args: [{ kind: "literal", value: false }] },
        { kind: "call", fn: "or", args: [{ kind: "literal", value: false }, { kind: "literal", value: true }] },
      ],
    });
    expect(ifElse(true, "yes", "no").__ir).toEqual({
      kind: "call",
      fn: "ifElse",
      args: [{ kind: "literal", value: true }, { kind: "literal", value: "yes" }, { kind: "literal", value: "no" }],
    });
  });

  it("lowers semantic sugar to canonical operators", () => {
    const tags = refExpr<readonly string[]>(["input", "tags"]);
    expect(head(tags).__ir).toEqual({ kind: "call", fn: "get", args: [tags.__ir, { kind: "literal", value: 0 }] });
    expect(isEmpty(tags).__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "call", fn: "len", args: [tags.__ir] },
        { kind: "literal", value: 0 },
      ],
    });
    expect(coalesce(refExpr<string | null>(["input", "name"]), "unknown").__ir).toEqual({
      kind: "call",
      fn: "coalesce",
      args: [{ kind: "ref", path: ["input", "name"] }, { kind: "literal", value: "unknown" }],
    });
  });

  it("lowers collection helpers with lambdas", () => {
    const items = refExpr<readonly { done: boolean; score: number }[]>(["input", "items"]);
    expect(every(items, item => item.done).__ir).toMatchObject({ kind: "call", fn: "every" });
    expect(some(items, item => item.done).__ir).toMatchObject({ kind: "call", fn: "some" });
    expect(filter(items, item => item.done).__ir).toMatchObject({ kind: "call", fn: "filter" });
    expect(map(items, item => item.score).__ir).toMatchObject({ kind: "call", fn: "map" });
  });

  it("keeps aggregators one-argument", () => {
    const scores = refExpr<readonly number[]>(["input", "scores"]);
    expect(max(scores).__ir).toEqual({ kind: "call", fn: "max", args: [scores.__ir] });
    expect(min(scores).__ir).toEqual({ kind: "call", fn: "min", args: [scores.__ir] });
  });

  it("lowers templates as expression nodes", () => {
    expect(template`count=${len(refExpr<readonly string[]>(["input", "items"]))}`.__ir).toEqual({
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

  it("dedents markdown templates while preserving expressions and Markdown structure", () => {
    expect(md`
      # Review

      Subject:
      ${refExpr<string>(["input", "subject"])}

      - keep item indentation
        - keep nested item indentation
    `.__ir).toEqual({
      kind: "template",
      template: {
        kind: "template",
        parts: [
          { kind: "text", value: "# Review\n\nSubject:\n" },
          { kind: "expr", expr: { kind: "ref", path: ["input", "subject"] } },
          { kind: "text", value: "\n\n- keep item indentation\n  - keep nested item indentation" },
        ],
      },
    });
  });

  it("lowers direct primitive helpers", () => {
    expect(eq(get(refExpr<readonly string[]>(["input", "tags"]), 0), "ready").__ir).toMatchObject({ kind: "call", fn: "eq" });
    expect(ne("draft", "ready").__ir).toMatchObject({ kind: "call", fn: "ne" });
    expect(lt(1, 2).__ir).toMatchObject({ kind: "call", fn: "lt" });
    expect(lte(1, 1).__ir).toMatchObject({ kind: "call", fn: "lte" });
    expect(gt(2, 1).__ir).toMatchObject({ kind: "call", fn: "gt" });
    expect(gte(2, 2).__ir).toMatchObject({ kind: "call", fn: "gte" });
    expect(includes("release/v1", "v1").__ir).toMatchObject({ kind: "call", fn: "includes" });
    expect(startsWith("release/v1", "release/").__ir).toMatchObject({ kind: "call", fn: "startsWith" });
    expect(endsWith("release/v1", "v1").__ir).toMatchObject({ kind: "call", fn: "endsWith" });
    expect(matches("release/v1", "^release/").__ir).toMatchObject({ kind: "call", fn: "matches" });
    expect(coalesce(null, "fallback").__ir).toMatchObject({ kind: "call", fn: "coalesce" });
  });
});
