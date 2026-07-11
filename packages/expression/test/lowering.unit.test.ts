import { describe, expect, it } from "vitest";
import { and, eq, gt, gte, lift, lt, lte, ne, not, or } from "@acpus/expression";
import { refExpr, tryValueToExprIR, valueToExprIR } from "@acpus/expression/ir";
import { err } from "neverthrow";

describe("expression lowering", () => {
  it("lowers refs and literals through the package seam", () => {
    expect(refExpr<boolean>(["input", "ready"]).__ir).toEqual({ kind: "ref", path: ["input", "ready"] });
    expect(valueToExprIR({ ready: true })).toEqual({
      kind: "object",
      fields: { ready: { kind: "literal", value: true } },
    });
  });

  it("rejects unsupported literal values", () => {
    expect(() => valueToExprIR(undefined)).toThrow("Unsupported expression value: undefined.");
    expect(() => valueToExprIR([, true])).toThrow("Unsupported expression value: sparse array hole.");
    expect(() => valueToExprIR({ value: undefined })).toThrow("Unsupported expression value at key 'value': undefined.");
    expect(() => valueToExprIR(new Date())).toThrow("Unsupported expression value: non-plain object.");
  });

  it("returns tagged errors for unsupported authoring values", () => {
    expect(tryValueToExprIR(undefined)).toEqual(err({
      type: "unsupported-expression-value",
      path: "$",
      valueType: "undefined",
      message: "Unsupported expression value: undefined.",
    }));
    expect(tryValueToExprIR([, true])).toEqual(err({
      type: "sparse-array-hole",
      path: "$[0]",
      message: "Unsupported expression value: sparse array hole.",
    }));
    expect(tryValueToExprIR({ value: undefined })).toEqual(err({
      type: "unsupported-expression-value",
      path: "$.value",
      valueType: "undefined",
      message: "Unsupported expression value at key 'value': undefined.",
    }));
    expect(tryValueToExprIR(new Date())).toEqual(err({
      type: "non-plain-object",
      path: "$",
      message: "Unsupported expression value: non-plain object.",
    }));
    expect(tryValueToExprIR(Number.NaN)).toEqual(err({
      type: "unsupported-expression-value",
      path: "$",
      valueType: "non-finite number",
      message: "Unsupported expression value: non-finite number.",
    }));
  });

  it("flattens static access over refs", () => {
    const user = refExpr<{ profile: { name: string }; tags: readonly string[]; constructor: string }>(["input", "user"]);
    expect(user.profile.name.__ir).toEqual({ kind: "ref", path: ["input", "user", "profile", "name"] });
    expect(user.tags[0]!.__ir).toEqual({ kind: "ref", path: ["input", "user", "tags", "0"] });
    expect(user.constructor.__ir).toEqual({ kind: "ref", path: ["input", "user", "constructor"] });
  });

  it("lowers computed access on non-ref expressions to internal access", () => {
    const firstUser = lift(refExpr<readonly { name: string }[]>(["input", "users"]), users => users[0]!);
    expect(firstUser.name.__ir).toEqual({
      kind: "call",
      fn: "access",
      args: [
        firstUser.__ir,
        { kind: "literal", value: "name" },
      ],
    });
  });

  it("lowers unary, binary, ternary, and structured lift dependencies as source text", () => {
    const count = refExpr<number>(["input", "count"]);
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);
    const maxItems = refExpr<number>(["input", "maxItems"]);
    const unaryFn = (value: number) => value + 1;
    const binaryFn = (readyValue: boolean, kindValue: string) => readyValue && kindValue === "release";
    const ternaryFn = (readyValue: boolean, kindValue: string, max: number) => readyValue && kindValue === "release" && max > 0;
    const liftFn = ({ readyValue, kindValue }: { readyValue: boolean; kindValue: string }) => readyValue && kindValue === "release";

    expect(lift(count, unaryFn).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [count.__ir, { kind: "literal", value: unaryFn.toString() }],
    });
    expect(lift(ready, kind, binaryFn).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [ready.__ir, kind.__ir, { kind: "literal", value: binaryFn.toString() }],
    });
    expect(lift(ready, kind, maxItems, ternaryFn).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [ready.__ir, kind.__ir, maxItems.__ir, { kind: "literal", value: ternaryFn.toString() }],
    });
    expect(lift({ readyValue: ready, kindValue: kind }, liftFn).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [
        { kind: "object", fields: { readyValue: ready.__ir, kindValue: kind.__ir } },
        { kind: "literal", value: liftFn.toString() },
      ],
    });
  });

  it("lowers predicate helpers through lift", () => {
    const count = refExpr<number>(["input", "count"]);
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);

    for (const [predicate, left, right, operator] of [
      [eq(kind, "release"), kind.__ir, { kind: "literal", value: "release" }, "==="],
      [ne(kind, "draft"), kind.__ir, { kind: "literal", value: "draft" }, "!=="],
      [lt(count, 3), count.__ir, { kind: "literal", value: 3 }, "<"],
      [lte(count, 2), count.__ir, { kind: "literal", value: 2 }, "<="],
      [gt(count, 1), count.__ir, { kind: "literal", value: 1 }, ">"],
      [gte(count, 2), count.__ir, { kind: "literal", value: 2 }, ">="],
    ] as const) {
      expect(predicate.__ir).toEqual({
        kind: "call",
        fn: "lift",
        args: [left, right, { kind: "literal", value: expect.stringContaining(operator) }],
      });
    }

    expect(not(ready).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [ready.__ir, { kind: "literal", value: expect.stringContaining("!value") }],
    });
    expect(and(ready, true, false).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [
        {
          kind: "array",
          items: [ready.__ir, { kind: "literal", value: true }, { kind: "literal", value: false }],
        },
        { kind: "literal", value: expect.stringContaining(".every") },
      ],
    });
    expect(or(ready, false, true).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [
        {
          kind: "array",
          items: [ready.__ir, { kind: "literal", value: false }, { kind: "literal", value: true }],
        },
        { kind: "literal", value: expect.stringContaining(".some") },
      ],
    });
  });

  it("treats IR-shaped user data as workflow data in public helpers", () => {
    const payload = { kind: "literal", value: "payload" };
    const ir = lift(payload, value => value).__ir;
    expect(ir).toMatchObject({
      kind: "call",
      fn: "lift",
      args: [
        {
          kind: "object",
          fields: {
            kind: { kind: "literal", value: "literal" },
            value: { kind: "literal", value: "payload" },
          },
        },
        { kind: "literal", value: expect.any(String) },
      ],
    });
  });
});
