import * as zod from "zod";
import type { Schema } from "./zod.js";

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ValidationIssue[] };

export type ValidationIssue = {
  path: string;
  message: string;
  expected?: string;
  received?: string;
};

export function parseSchema<T>(schema: Schema<T>, value: unknown): T {
  return zod.parse(schema as zod.ZodTypeAny, value) as T;
}

export function safeParseSchema<T>(schema: Schema<T>, value: unknown): ParseResult<T> {
  const result = zod.safeParse(schema as zod.ZodTypeAny, value);
  if (result.success) return { success: true, data: result.data as T };
  return {
    success: false,
    issues: result.error.issues.map(issue => ({
      path: issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`,
      message: issue.message,
      expected: issue.code,
      received: typeof value,
    })),
  };
}

export function validateValue<T>(schema: Schema<T>, value: unknown): ParseResult<T> {
  return safeParseSchema(schema, value);
}
