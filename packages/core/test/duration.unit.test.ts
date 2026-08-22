import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { tryParseDurationMs } from "../src/ir.js";

describe("duration parsing", () => {
  it.each([
    ["0", 0],
    ["0ms", 0],
    ["42", 42],
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["104249991d", 9_007_199_222_400_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("parses %s as %i milliseconds", (value, durationMs) => {
    expect(tryParseDurationMs(value)).toEqual(Result.succeed(durationMs));
  });

  it.each(["", "ms", "-1s", "+1s", "1.5s", "5 m", "1m30s", "1w"])(
    "rejects invalid syntax %j",
    value => {
      expect(tryParseDurationMs(value)).toEqual(Result.fail({ type: "invalid-duration-syntax", value }));
    },
  );

  it.each([
    "9007199254740992",
    "9007199254741s",
    "104249992d",
    `${"9".repeat(309)}h`,
  ])("rejects out-of-range duration %j", value => {
    expect(tryParseDurationMs(value)).toEqual(Result.fail({ type: "duration-out-of-range", value }));
  });
});
