import { describe, expect, it } from "vitest";
import { pick } from "@acpus/expression";
import { refExpr, valueToExprIR } from "@acpus/expression/ir";

describe("expression reserved field regression", () => {
  it("allows user object fields named ir while keeping __ir reserved for inspection", () => {
    const user = refExpr<{ ir: string; name: string }>(["input", "user"]);

    expect(user.ir.__ir).toEqual({ kind: "ref", path: ["input", "user", "ir"] });
    expect(valueToExprIR(pick(user, ["ir"]))).toEqual({
      kind: "object",
      fields: {
        ir: { kind: "ref", path: ["input", "user", "ir"] },
      },
    });
  });
});
