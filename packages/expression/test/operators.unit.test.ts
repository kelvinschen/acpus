import { describe, expect, it } from "vitest";
import { lift, md, template } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression operators", () => {
  it("lowers templates as expression nodes", () => {
    const length = (items: readonly string[]) => items.length;
    expect(template`count=${lift(refExpr<readonly string[]>(["input", "items"]), length)}`.__ir).toEqual({
      kind: "template",
      parts: [
        { kind: "text", value: "count=" },
        {
          kind: "expr",
          expr: {
            kind: "call",
            fn: "lift",
            args: [
              { kind: "ref", path: ["input", "items"] },
              { kind: "literal", value: length.toString() },
            ],
          },
        },
        { kind: "text", value: "" },
      ],
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
      parts: [
        { kind: "text", value: "# Review\n\nSubject:\n" },
        { kind: "expr", expr: { kind: "ref", path: ["input", "subject"] } },
        { kind: "text", value: "\n\n- keep item indentation\n  - keep nested item indentation" },
      ],
    });
  });
});
