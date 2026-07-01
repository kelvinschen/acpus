import { describe, expect, it } from "vitest";
import { get, map, pick } from "@acpus/expression";
import { refExpr, tryValueToExprIR, valueToExprIR } from "@acpus/expression/ir";
import { err } from "neverthrow";

describe("expression lowering", () => {
  it("lowers advanced refs and literals through the package seam", () => {
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

  it("lowers dynamic and computed access to get", () => {
    const users = refExpr<readonly { name: string }[]>(["input", "users"]);
    const firstUser = get(users, 0);
    expect(firstUser.__ir).toEqual({
      kind: "call",
      fn: "get",
      args: [
        { kind: "ref", path: ["input", "users"] },
        { kind: "literal", value: 0 },
      ],
    });
    expect(firstUser.name.__ir).toEqual({
      kind: "call",
      fn: "get",
      args: [
        firstUser.__ir,
        { kind: "literal", value: "name" },
      ],
    });
  });

  it("lowers static pick projections", () => {
    const user = refExpr<{ name: string; score: number; done: boolean }>(["input", "user"]);
    expect(valueToExprIR(pick(user, ["name", "done"]))).toEqual({
      kind: "object",
      fields: {
        name: { kind: "ref", path: ["input", "user", "name"] },
        done: { kind: "ref", path: ["input", "user", "done"] },
      },
    });
  });

  it("rejects reserved pick keys at runtime", () => {
    const user = refExpr<{ __ir: string }>(["input", "user"]) as any;
    expect(() => (pick as any)(user, ["__ir"])).toThrow("pick(source, keys) cannot project reserved accessor key '__ir'.");
  });

  it("allocates deterministic lambda binding ids", () => {
    const items = refExpr<readonly { done: boolean }[]>(["input", "items"]);
    expect(map(items, item => item.done).__ir).toEqual({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        {
          kind: "lambda",
          params: [{ id: "v0" }, { id: "v1" }],
          body: { kind: "var", id: "v0", path: ["done"] },
        },
      ],
    });
  });

  it("allocates unique nested lambda binding ids", () => {
    const groups = refExpr<readonly { items: readonly { done: boolean }[] }[]>(["input", "groups"]);
    expect(map(groups, group => map(group.items, item => item.done)).__ir).toEqual({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "groups"] },
        {
          kind: "lambda",
          params: [{ id: "v0" }, { id: "v1" }],
          body: {
            kind: "call",
            fn: "map",
            args: [
              { kind: "var", id: "v0", path: ["items"] },
              {
                kind: "lambda",
                params: [{ id: "v2" }, { id: "v3" }],
                body: { kind: "var", id: "v2", path: ["done"] },
              },
            ],
          },
        },
      ],
    });
  });
});
