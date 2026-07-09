import { describe, expect, it } from "vitest";
import {
  add,
  and,
  coalesce,
  divide,
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
  join,
  len,
  lt,
  lte,
  map,
  matches,
  max,
  md,
  min,
  mod,
  multiply,
  ne,
  not,
  or,
  some,
  startsWith,
  subtract,
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
    expect(every(items, item => item.done).__ir).toEqual({
      kind: "call",
      fn: "every",
      args: [
        items.__ir,
        { kind: "lambda", params: [{ id: "v0" }, { id: "v1" }], body: { kind: "var", id: "v0", path: ["done"] } },
      ],
    });
    expect(some(items, item => item.done).__ir).toEqual({
      kind: "call",
      fn: "some",
      args: [
        items.__ir,
        { kind: "lambda", params: [{ id: "v0" }, { id: "v1" }], body: { kind: "var", id: "v0", path: ["done"] } },
      ],
    });
    expect(filter(items, item => item.done).__ir).toEqual({
      kind: "call",
      fn: "filter",
      args: [
        items.__ir,
        { kind: "lambda", params: [{ id: "v0" }, { id: "v1" }], body: { kind: "var", id: "v0", path: ["done"] } },
      ],
    });
    expect(map(items, item => item.score).__ir).toEqual({
      kind: "call",
      fn: "map",
      args: [
        items.__ir,
        { kind: "lambda", params: [{ id: "v0" }, { id: "v1" }], body: { kind: "var", id: "v0", path: ["score"] } },
      ],
    });
  });

  it("keeps aggregators one-argument", () => {
    const scores = refExpr<readonly number[]>(["input", "scores"]);
    expect(max(scores).__ir).toEqual({ kind: "call", fn: "max", args: [scores.__ir] });
    expect(min(scores).__ir).toEqual({ kind: "call", fn: "min", args: [scores.__ir] });
  });

  it("lowers arithmetic and string join helpers", () => {
    const index = refExpr<number>(["loop", "rounds", "index"]);
    const lines = refExpr<readonly string[]>(["input", "lines"]);
    expect(add(index, 1).__ir).toEqual({ kind: "call", fn: "add", args: [index.__ir, { kind: "literal", value: 1 }] });
    expect(subtract(index, 1).__ir).toEqual({ kind: "call", fn: "subtract", args: [index.__ir, { kind: "literal", value: 1 }] });
    expect(multiply(index, 2).__ir).toEqual({ kind: "call", fn: "multiply", args: [index.__ir, { kind: "literal", value: 2 }] });
    expect(divide(index, 2).__ir).toEqual({ kind: "call", fn: "divide", args: [index.__ir, { kind: "literal", value: 2 }] });
    expect(mod(index, 2).__ir).toEqual({ kind: "call", fn: "mod", args: [index.__ir, { kind: "literal", value: 2 }] });
    expect(join(lines, "\n").__ir).toEqual({ kind: "call", fn: "join", args: [lines.__ir, { kind: "literal", value: "\n" }] });
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
    expect(eq(get(refExpr<readonly string[]>(["input", "tags"]), 0), "ready").__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "call", fn: "get", args: [{ kind: "ref", path: ["input", "tags"] }, { kind: "literal", value: 0 }] },
        { kind: "literal", value: "ready" },
      ],
    });
    expect(ne("draft", "ready").__ir).toEqual({ kind: "call", fn: "ne", args: [{ kind: "literal", value: "draft" }, { kind: "literal", value: "ready" }] });
    expect(lt(1, 2).__ir).toEqual({ kind: "call", fn: "lt", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }] });
    expect(lte(1, 1).__ir).toEqual({ kind: "call", fn: "lte", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 1 }] });
    expect(gt(2, 1).__ir).toEqual({ kind: "call", fn: "gt", args: [{ kind: "literal", value: 2 }, { kind: "literal", value: 1 }] });
    expect(gte(2, 2).__ir).toEqual({ kind: "call", fn: "gte", args: [{ kind: "literal", value: 2 }, { kind: "literal", value: 2 }] });
    expect(includes("release/v1", "v1").__ir).toEqual({ kind: "call", fn: "includes", args: [{ kind: "literal", value: "release/v1" }, { kind: "literal", value: "v1" }] });
    expect(startsWith("release/v1", "release/").__ir).toEqual({ kind: "call", fn: "startsWith", args: [{ kind: "literal", value: "release/v1" }, { kind: "literal", value: "release/" }] });
    expect(endsWith("release/v1", "v1").__ir).toEqual({ kind: "call", fn: "endsWith", args: [{ kind: "literal", value: "release/v1" }, { kind: "literal", value: "v1" }] });
    expect(matches("release/v1", "^release/").__ir).toEqual({ kind: "call", fn: "matches", args: [{ kind: "literal", value: "release/v1" }, { kind: "literal", value: "^release/" }] });
    expect(coalesce(null, "fallback").__ir).toEqual({ kind: "call", fn: "coalesce", args: [{ kind: "literal", value: null }, { kind: "literal", value: "fallback" }] });
    expect(add(1, 2).__ir).toEqual({ kind: "call", fn: "add", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }] });
  });
});
