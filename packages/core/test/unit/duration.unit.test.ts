import { describe, it, expect } from "vitest";
import { parseDurationMs } from "../../src/duration.js";

describe("parseDurationMs", () => {
  it("returns 0 for undefined input", () => {
    expect(parseDurationMs(undefined)).toBe(0);
  });

  it("parses milliseconds", () => {
    expect(parseDurationMs("500ms")).toBe(500);
  });

  it("parses seconds", () => {
    expect(parseDurationMs("30s")).toBe(30000);
  });

  it("parses minutes", () => {
    expect(parseDurationMs("5m")).toBe(300000);
  });

  it("parses hours", () => {
    expect(parseDurationMs("1h")).toBe(3600000);
  });

  it("parses a bare number as milliseconds", () => {
    expect(parseDurationMs("100")).toBe(100);
  });

  it("returns 0 for invalid input by default", () => {
    expect(parseDurationMs("abc")).toBe(0);
  });

  it("returns 0 for unsupported unit by default", () => {
    expect(parseDurationMs("2d")).toBe(0);
  });

  it("throws for invalid input in strict mode", () => {
    expect(() => parseDurationMs("abc", { strict: true })).toThrow(
      "Invalid duration 'abc'. Use ms, s, m, or h."
    );
  });

  it("throws for unsupported unit in strict mode", () => {
    expect(() => parseDurationMs("2d", { strict: true })).toThrow(
      "Invalid duration '2d'. Use ms, s, m, or h."
    );
  });

  it("trims whitespace before parsing", () => {
    expect(parseDurationMs("  30s  ")).toBe(30000);
  });

  it("returns 0 for empty string", () => {
    expect(parseDurationMs("")).toBe(0);
  });

  it("throws for empty string in strict mode", () => {
    expect(() => parseDurationMs("", { strict: true })).toThrow();
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

  it("rejects decimal, uppercase, and spaced units", () => {
    expect(parseDurationMs("1.5s")).toBe(0);
    expect(parseDurationMs("1H")).toBe(0);
    expect(parseDurationMs("1 s")).toBe(0);
  });
});
