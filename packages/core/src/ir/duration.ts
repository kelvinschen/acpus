import { err, ok, type Result } from "neverthrow";

export type DurationParseError =
  | { type: "invalid-duration-syntax"; value: string }
  | { type: "duration-out-of-range"; value: string };

const durationMultipliers = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

export function tryParseDurationMs(value: string): Result<number, DurationParseError> {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) return err({ type: "invalid-duration-syntax", value });

  const unit = (match[2] ?? "ms") as keyof typeof durationMultipliers;
  const durationMs = Number(match[1]) * durationMultipliers[unit];
  if (!Number.isSafeInteger(durationMs)) {
    return err({ type: "duration-out-of-range", value });
  }
  return ok(durationMs);
}
