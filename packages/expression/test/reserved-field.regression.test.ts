import { describe, expect, it } from "vitest";
import { refExpr } from "@acpus/expression/ir";

describe("expression reserved field regression", () => {
  it("allows user object fields named ir while keeping __ir reserved for inspection", () => {
    const user = refExpr<{ ir: string; name: string }>(["input", "user"]);

    expect(user.ir.__ir).toEqual({ kind: "ref", path: ["input", "user", "ir"] });
    expect(user.__ir).toEqual({ kind: "ref", path: ["input", "user"] });
  });
});
