import { describe, expect, it } from "vitest";
import { stableJson } from "../src/stable-json.js";

describe("stable JSON", () => {
  it("produces identical no-LF bytes for nested objects regardless of insertion order", () => {
    const left = { zeta: true, alpha: { delta: 4, beta: 2 } };
    const right = { alpha: { beta: 2, delta: 4 }, zeta: true };

    expect(stableJson(left)).toBe('{"alpha":{"beta":2,"delta":4},"zeta":true}');
    expect(stableJson(right)).toBe(stableJson(left));
    expect(stableJson(left).endsWith("\n")).toBe(false);
  });

  it("preserves array order and JSON number-like key ordering", () => {
    expect(stableJson([
      { zeta: 1, alpha: 2 },
      [3, 2, 1],
    ])).toBe('[{"alpha":2,"zeta":1},[3,2,1]]');
    expect(stableJson({ 10: "ten", 2: "two", 1: "one", zeta: true, alpha: true }))
      .toBe('{"1":"one","2":"two","10":"ten","alpha":true,"zeta":true}');
  });

});
