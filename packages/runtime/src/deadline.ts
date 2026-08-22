import * as Result from "effect/Result";

type DeadlineRangeError = { type: "deadline-out-of-range" };
type PersistedDeadlineParseError = { type: "invalid-persisted-deadline"; value: string };

export function tryCreateDeadline(now: Date, milliseconds: number): Result.Result<Date, DeadlineRangeError> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return Result.fail({ type: "deadline-out-of-range" });
  const deadline = new Date(now.getTime() + milliseconds);
  const year = deadline.getUTCFullYear();
  return Number.isFinite(deadline.getTime()) && year >= 0 && year <= 9_999
    ? Result.succeed(deadline)
    : Result.fail({ type: "deadline-out-of-range" });
}

export function tryParsePersistedDeadline(value: string): Result.Result<Date, PersistedDeadlineParseError> {
  const deadline = new Date(value);
  const year = deadline.getUTCFullYear();
  return Number.isFinite(deadline.getTime())
    && year >= 0
    && year <= 9_999
    && deadline.toISOString() === value
    ? Result.succeed(deadline)
    : Result.fail({ type: "invalid-persisted-deadline", value });
}

export function requirePersistedDeadline(value: string, subject: string): string {
  if (Result.isFailure(tryParsePersistedDeadline(value))) {
    throw new Error(`${subject} has invalid persisted deadline ${JSON.stringify(value)}.`);
  }
  return value;
}
