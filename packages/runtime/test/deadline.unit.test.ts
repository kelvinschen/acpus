import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { requirePersistedDeadline, tryCreateDeadline, tryParsePersistedDeadline } from "../src/deadline.js";

describe("persisted deadlines", () => {
  it("creates canonical four-digit-year ISO dates", () => {
    expect(tryCreateDeadline(new Date("2026-01-01T00:00:00.000Z"), 1_000))
      .toEqual(ok(new Date("2026-01-01T00:00:01.000Z")));
  });

  it.each([
    [new Date("9999-12-31T23:59:59.999Z"), 1],
    [new Date(8_640_000_000_000_000), 1],
    [new Date("2026-01-01T00:00:00.000Z"), -1],
    [new Date("2026-01-01T00:00:00.000Z"), 0.5],
  ])("rejects unsupported persisted deadline inputs", (now, milliseconds) => {
    expect(tryCreateDeadline(now, milliseconds)).toEqual(err({ type: "deadline-out-of-range" }));
  });

  it("parses only canonical four-digit-year ISO timestamps", () => {
    const value = "2026-01-01T00:00:00.000Z";
    expect(tryParsePersistedDeadline(value)).toEqual(ok(new Date(value)));
    for (const invalid of [
      "2026-01-01T00:00:00Z",
      "+010000-01-01T00:00:00.000Z",
      "not-a-deadline",
    ]) {
      expect(tryParsePersistedDeadline(invalid)).toEqual(err({ type: "invalid-persisted-deadline", value: invalid }));
    }
  });

  it("requires canonical persisted values without changing them", () => {
    const value = "2026-01-01T00:00:00.000Z";
    expect(requirePersistedDeadline(value, "Attempt 'a1'")).toBe(value);
    expect(() => requirePersistedDeadline("not-a-deadline", "Attempt 'a1'"))
      .toThrow("Attempt 'a1' has invalid persisted deadline \"not-a-deadline\".");
  });
});
