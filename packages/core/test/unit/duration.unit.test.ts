import { describe, it, expect } from "vitest";
import { parseDurationMs } from "../../src/duration.js";

describe("parseDurationMs", () => {
  it("returns 0 for undefined input", () => {
    expect(parseDurationMs(undefined)).toBe(0);
  });

  it.each([
    ["500ms", 500],
    ["30s", 30000],
    ["5m", 300000],
    ["1h", 3600000],
    ["100", 100],
  ])("parses %s as %d milliseconds", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(["abc", "2d", "", "1.5s", "1H", "1 s"])(
    "returns 0 for invalid input %j by default",
    (input) => {
      expect(parseDurationMs(input)).toBe(0);
    }
  );

  it.each(["abc", "2d", ""])(
    "throws for invalid input %j in strict mode",
    (input) => {
      expect(() => parseDurationMs(input, { strict: true })).toThrow(
        `Invalid duration '${input}'. Use ms, s, m, or h.`
      );
    }
  );

  it("trims whitespace before parsing", () => {
    expect(parseDurationMs("  30s  ")).toBe(30000);
  });

  it("handles zero values", () => {
    expect(parseDurationMs("0s")).toBe(0);
    expect(parseDurationMs("0ms")).toBe(0);
  });

  it("handles large values", () => {
    expect(parseDurationMs("24h")).toBe(86400000);
  });

  it("rejects values beyond safe integer range", () => {
    const huge = `${"9".repeat(400)}h`;
    expect(parseDurationMs(huge)).toBe(0);
    expect(() => parseDurationMs(huge, { strict: true })).toThrow(
      `Invalid duration '${huge}'. Use ms, s, m, or h.`
    );
  });
});
