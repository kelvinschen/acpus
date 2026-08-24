import { isPositiveInteger, tryParseDurationMs } from "@acpus/core/ir";
import type { ExprIR, JsonObject } from "@acpus/expression/ir";
import * as Result from "effect/Result";
import { tryCreateDeadline as tryCreatePersistedDeadline } from "../deadline.js";
import { tryEvaluateExpr, type EvaluationOptions, type EvaluationScope } from "./evaluator.js";

export type ResolutionError =
  | { type: "evaluation"; field: string; message: string }
  | { type: "type"; field: string; expected: string; actual: string; message: string }
  | { type: "constraint"; field: string; expected: string; message: string };

export type ResolvedDuration = {
  value: string;
  milliseconds: number;
};

export function tryResolveString(expr: ExprIR, scope: EvaluationScope, field: string, options?: EvaluationOptions): Result.Result<string, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field, options);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  return typeof resolved.success === "string"
    ? Result.succeed(resolved.success)
    : typeError(field, "string", resolved.success);
}

export function tryResolveDuration(expr: ExprIR, scope: EvaluationScope, field: string): Result.Result<ResolvedDuration, ResolutionError> {
  return Result.flatMap(tryResolveString(expr, scope, field), value => {
    const milliseconds = tryParseDurationMs(value);
    return milliseconds._tag === "Success"
      ? Result.succeed({ value, milliseconds: milliseconds.success })
      : Result.fail({
          type: "constraint",
          field,
          expected: "duration string like 500ms, 30s, 5m, 1h, or 1000",
          message: `${field} must resolve to a duration string like 500ms, 30s, 5m, 1h, or 1000.`,
        } satisfies ResolutionError);
  });
}

export function tryCreateDeadline(now: Date, milliseconds: number, field: string): Result.Result<Date, ResolutionError> {
  return Result.mapError(tryCreatePersistedDeadline(now, milliseconds), () => ({
    type: "constraint",
    field,
    expected: "duration with a representable persisted deadline",
    message: `${field} must produce a deadline representable by the persisted ISO timestamp format.`,
  }));
}

export function tryResolveInteger(
  expr: ExprIR,
  scope: EvaluationScope,
  field: string,
  minimum: number,
): Result.Result<number, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  if (typeof resolved.success !== "number") return typeError(field, "integer", resolved.success);
  const invalid = minimum === 1
    ? !isPositiveInteger(resolved.success)
    : !Number.isInteger(resolved.success) || resolved.success < minimum;
  if (invalid) {
    return Result.fail({
      type: "constraint",
      field,
      expected: `integer greater than or equal to ${minimum}`,
      message: `${field} must resolve to an integer greater than or equal to ${minimum}.`,
    });
  }
  return Result.succeed(resolved.success);
}

export function tryResolveConcurrencyLimit(
  expr: ExprIR,
  scope: EvaluationScope,
  field: string,
): Result.Result<number | undefined, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  if (resolved.success === undefined || resolved.success === 0) return Result.succeed(undefined);
  if (typeof resolved.success !== "number") return typeError(field, "integer", resolved.success);
  if (!isPositiveInteger(resolved.success)) {
    return Result.fail({
      type: "constraint",
      field,
      expected: "0 or a positive integer",
      message: `${field} must resolve to 0 or a positive integer.`,
    });
  }
  return Result.succeed(resolved.success);
}

export function resolutionErrorPayload(error: ResolutionError): JsonObject {
  return { reason: "expression_resolution_failed", ...error };
}

function tryEvaluate(expr: ExprIR, scope: EvaluationScope, field: string, options?: EvaluationOptions): Result.Result<unknown, ResolutionError> {
  return Result.mapError(tryEvaluateExpr(expr, scope, options), failure => ({
      type: "evaluation",
      field,
      message: failure.message,
    }));
}

function typeError<T>(field: string, expected: string, value: unknown): Result.Result<T, ResolutionError> {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return Result.fail({
    type: "type",
    field,
    expected,
    actual,
    message: `${field} must resolve to ${expected}; received ${actual}.`,
  });
}
