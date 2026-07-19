import { isPositiveInteger, tryParseDurationMs } from "@acpus/core/ir";
import type { ExprIR, JsonObject } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";
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

export function tryResolveString(expr: ExprIR, scope: EvaluationScope, field: string, options?: EvaluationOptions): Result<string, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field, options);
  if (resolved.isErr()) return err(resolved.error);
  return typeof resolved.value === "string"
    ? ok(resolved.value)
    : typeError(field, "string", resolved.value);
}

export function tryResolveDuration(expr: ExprIR, scope: EvaluationScope, field: string): Result<ResolvedDuration, ResolutionError> {
  return tryResolveString(expr, scope, field).andThen(value => {
    const milliseconds = tryParseDurationMs(value);
    return milliseconds.isOk()
      ? ok({ value, milliseconds: milliseconds.value })
      : err({
          type: "constraint",
          field,
          expected: "duration string like 500ms, 30s, 5m, 1h, or 1000",
          message: `${field} must resolve to a duration string like 500ms, 30s, 5m, 1h, or 1000.`,
        } satisfies ResolutionError);
  });
}

export function tryCreateDeadline(now: Date, milliseconds: number, field: string): Result<Date, ResolutionError> {
  return tryCreatePersistedDeadline(now, milliseconds).mapErr(() => ({
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
): Result<number, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field);
  if (resolved.isErr()) return err(resolved.error);
  if (typeof resolved.value !== "number") return typeError(field, "integer", resolved.value);
  const invalid = minimum === 1
    ? !isPositiveInteger(resolved.value)
    : !Number.isInteger(resolved.value) || resolved.value < minimum;
  if (invalid) {
    return err({
      type: "constraint",
      field,
      expected: `integer greater than or equal to ${minimum}`,
      message: `${field} must resolve to an integer greater than or equal to ${minimum}.`,
    });
  }
  return ok(resolved.value);
}

export function tryResolveConcurrencyLimit(
  expr: ExprIR,
  scope: EvaluationScope,
  field: string,
): Result<number | undefined, ResolutionError> {
  const resolved = tryEvaluate(expr, scope, field);
  if (resolved.isErr()) return err(resolved.error);
  if (resolved.value === undefined || resolved.value === 0) return ok(undefined);
  if (typeof resolved.value !== "number") return typeError(field, "integer", resolved.value);
  if (!isPositiveInteger(resolved.value)) {
    return err({
      type: "constraint",
      field,
      expected: "0 or a positive integer",
      message: `${field} must resolve to 0 or a positive integer.`,
    });
  }
  return ok(resolved.value);
}

export function resolutionErrorPayload(error: ResolutionError): JsonObject {
  return { reason: "expression_resolution_failed", ...error };
}

function tryEvaluate(expr: ExprIR, scope: EvaluationScope, field: string, options?: EvaluationOptions): Result<unknown, ResolutionError> {
  return tryEvaluateExpr(expr, scope, options).mapErr(failure => ({
      type: "evaluation",
      field,
      message: failure.message,
    }));
}

function typeError<T>(field: string, expected: string, value: unknown): Result<T, ResolutionError> {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return err({
    type: "type",
    field,
    expected,
    actual,
    message: `${field} must resolve to ${expected}; received ${actual}.`,
  });
}
