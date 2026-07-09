import { describe, expect, it } from "vitest";
import { fmap, lift, lift2, lift3 } from "@acpus/expression";
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
    const firstUser = fmap(refExpr<readonly { name: string }[]>(["input", "users"]), users => users[0]!);
    expect(firstUser.name.__ir).toEqual({
      kind: "call",
      fn: "access",
      args: [
        firstUser.__ir,
        { kind: "literal", value: "name" },
      ],
    });
  });

  it("lowers fmap and lift callbacks as source text", () => {
    const count = refExpr<number>(["input", "count"]);
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);
    const maxItems = refExpr<number>(["input", "maxItems"]);
    const fmapFn = (value: number) => value + 1;
    const lift2Fn = (readyValue: boolean, kindValue: string) => readyValue && kindValue === "release";
    const lift3Fn = (readyValue: boolean, kindValue: string, max: number) => readyValue && kindValue === "release" && max > 0;
    const liftFn = ({ readyValue, kindValue }: { readyValue: boolean; kindValue: string }) => readyValue && kindValue === "release";

    expect(fmap(count, fmapFn).__ir).toEqual({
      kind: "call",
      fn: "fmap",
      args: [count.__ir, { kind: "literal", value: fmapFn.toString() }],
    });
    expect(lift2(ready, kind, lift2Fn).__ir).toEqual({
      kind: "call",
      fn: "lift2",
      args: [ready.__ir, kind.__ir, { kind: "literal", value: lift2Fn.toString() }],
    });
    expect(lift3(ready, kind, maxItems, lift3Fn).__ir).toEqual({
      kind: "call",
      fn: "lift3",
      args: [ready.__ir, kind.__ir, maxItems.__ir, { kind: "literal", value: lift3Fn.toString() }],
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

  it("treats IR-shaped user data as workflow data in public helpers", () => {
    const payload = { kind: "literal", value: "payload" };
    const ir = fmap(payload, value => value).__ir;
    expect(ir).toMatchObject({
      kind: "call",
      fn: "fmap",
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
