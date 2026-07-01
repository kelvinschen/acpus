import { describe, expect, it } from "vitest";
import { len, map, where } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("where v2", () => {
  it("lowers field-wise object filters", () => {
    const item = refExpr<{ status: string; score: number }>(["input", "item"]);
    expect(where(item, { status: "done", score: { gte: 80 } }).__ir).toEqual({
      kind: "call",
      fn: "and",
      args: [
        { kind: "call", fn: "eq", args: [{ kind: "ref", path: ["input", "item", "status"] }, { kind: "literal", value: "done" }] },
        { kind: "call", fn: "gte", args: [{ kind: "ref", path: ["input", "item", "score"] }, { kind: "literal", value: 80 }] },
      ],
    });
  });

  it("reserves operator keys for object filters when type metadata says object", () => {
    const item = refExpr<{ eq: string }>(["input", "item"], {
      kind: "object",
      fields: { eq: { kind: "string" } },
      required: ["eq"],
      additionalProperties: false,
    });
    expect(() => (where as any)(item, { eq: "x" })).toThrow("where(target, filter) cannot use reserved filter key 'eq'.");
  });

  it("allows field filters named ir and keeps __ir reserved", () => {
    const item = refExpr<{ ir: string; __ir: string }>(["input", "item"]);

    expect(where(item, { ir: "ok" }).__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "ref", path: ["input", "item", "ir"] },
        { kind: "literal", value: "ok" },
      ],
    });
    expect(() => (where as any)(item, { __ir: "internal" })).toThrow("where(target, filter) cannot use reserved filter key '__ir'.");
  });

  it("lowers primitive eq filters", () => {
    const status = refExpr<string>(["input", "status"]);
    expect(where(status, { eq: "done" }).__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "ref", path: ["input", "status"] },
        { kind: "literal", value: "done" },
      ],
    });
  });

  it("lowers nullable equality filters", () => {
    const user = refExpr<{ deletedAt: string | null }>(["input", "user"]);
    expect(where(user, { deletedAt: null }).__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "ref", path: ["input", "user", "deletedAt"] },
        { kind: "literal", value: null },
      ],
    });
    expect(where(refExpr<string | null>(["input", "name"]), null).__ir).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "ref", path: ["input", "name"] },
        { kind: "literal", value: null },
      ],
    });
  });

  it("lowers primitive and length filters", () => {
    const tags = refExpr<readonly string[]>(["input", "tags"]);
    expect(where(tags, { length: { gt: 0 }, contains: "ready" }).__ir).toEqual({
      kind: "call",
      fn: "and",
      args: [
        { kind: "call", fn: "gt", args: [{ kind: "call", fn: "len", args: [tags.__ir] }, { kind: "literal", value: 0 }] },
        { kind: "call", fn: "includes", args: [tags.__ir, { kind: "literal", value: "ready" }] },
      ],
    });
  });

  it("lowers array equality operator filters", () => {
    const tags = refExpr<readonly string[]>(["input", "tags"]);
    expect(where(tags, { eq: ["ready"], ne: ["blocked"] }).__ir).toEqual({
      kind: "call",
      fn: "and",
      args: [
        { kind: "call", fn: "eq", args: [tags.__ir, { kind: "array", items: [{ kind: "literal", value: "ready" }] }] },
        { kind: "call", fn: "ne", args: [tags.__ir, { kind: "array", items: [{ kind: "literal", value: "blocked" }] }] },
      ],
    });
  });

  it("rejects empty filters", () => {
    const item = refExpr<{ done: boolean }>(["input", "item"]);
    expect(() => where(item, {})).toThrow("where(target, filter) requires at least one filter entry.");
  });

  it("lowers computed and lambda primitive filters", () => {
    const tags = refExpr<readonly string[]>(["input", "tags"]);
    expect(where(len(tags), { gt: 0 }).__ir).toEqual({
      kind: "call",
      fn: "gt",
      args: [{ kind: "call", fn: "len", args: [tags.__ir] }, { kind: "literal", value: 0 }],
    });

    const items = refExpr<readonly { name: string }[]>(["input", "items"]);
    expect(map(items, item => where(item.name, { contains: "x" })).__ir).toMatchObject({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        {
          kind: "lambda",
          body: {
            kind: "call",
            fn: "includes",
            args: [
              { kind: "var", id: "v0", path: ["name"] },
              { kind: "literal", value: "x" },
            ],
          },
        },
      ],
    });
  });
});
