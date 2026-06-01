import { describe, expect, it } from "vitest";
import { applyTransforms } from "../../src/transformers/builtins.js";

describe("transformers", () => {
  it("compacts long text", () => {
    const value = applyTransforms("abcdef", [{ fn: "compact", args: { maxChars: 3 } }]);
    expect(String(value)).toContain("abc");
    expect(String(value)).toContain("truncated");
  });

  it("filters findings by severity", () => {
    const value = applyTransforms([
      { severity: "P0", summary: "blocker" },
      { severity: "P3", summary: "nit" }
    ], [{ fn: "filterSeverity", args: { levels: ["P0", "P1"] } }]);
    expect(value).toEqual([{ severity: "P0", summary: "blocker" }]);
  });

  it("applies explicit default", () => {
    expect(applyTransforms(undefined, [{ fn: "default", args: { value: "fallback" } }])).toBe("fallback");
  });

  it("tails text by line count", () => {
    expect(applyTransforms("a\nb\nc", [{ fn: "tail", args: { maxLines: 2 } }])).toBe("b\nc");
  });
});
