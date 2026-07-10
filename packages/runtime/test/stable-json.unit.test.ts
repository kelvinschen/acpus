import { describe, expect, it, vi } from "vitest";
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

  it("delegates object-key ordering to localeCompare", () => {
    const compare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other) {
      const left = String(this);
      const right = String(other);
      return left === right ? 0 : left < right ? 1 : -1;
    });
    try {
      expect(stableJson({ alpha: 1, zeta: 2 })).toBe('{"zeta":2,"alpha":1}');
    } finally {
      compare.mockRestore();
    }
  });

  it("rejects roots that JSON.stringify cannot serialize", () => {
    expect(() => stableJson(undefined)).toThrow("Stable JSON root is not serializable.");
    expect(() => stableJson(() => undefined)).toThrow("Stable JSON root is not serializable.");
    expect(() => stableJson(Symbol("value"))).toThrow("Stable JSON root is not serializable.");
  });

  it("continues to reject BigInt and cyclic values", () => {
    expect(() => stableJson(1n)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJson(cyclic)).toThrow();
  });
});
