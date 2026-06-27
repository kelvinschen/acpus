import { Ajv } from "ajv";

/**
 * Module-level Ajv singleton for input validation.
 * `useDefaults: true` auto-fills missing optional properties with their
 * declared `default` values (mutating the input object in-place).
 * `strict: false` matches the compiler's Ajv configuration.
 */
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

export interface InputValidationError {
  /** JSON pointer path, e.g. "/region" or "/tags/0" */
  path: string;
  /** Ajv keyword that triggered the error, e.g. "required", "type" */
  keyword: string;
  /** Human-readable error message */
  message: string;
  /** Expected type or value (when applicable) */
  expected?: string;
  /** Actual type or value (when applicable) */
  actual?: string;
}

export class InputValidationFailure extends Error {
  constructor(public readonly errors: InputValidationError[]) {
    const summary = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    super(`Input validation failed: ${summary}`);
    this.name = "InputValidationFailure";
  }
}

/**
 * Validate `input` against a compiled JSON Schema (from the IR's `input` field).
 * When the schema declares defaults for missing optional properties, Ajv
 * fills them in by mutating `input` in-place. On validation failure, throws
 * {@link InputValidationFailure} with structured error details.
 *
 * An empty schema (`{}` or no `properties`) is treated as "no validation
 * required" — the input passes through unchanged.
 */
export function validateInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>
): Record<string, unknown> {
  // No schema or empty schema → nothing to validate.
  if (
    !schema ||
    Object.keys(schema).length === 0 ||
    (!schema.properties && !schema.required && !schema.$schema)
  ) {
    return input;
  }

  const validate = ajv.compile(schema);
  const valid = validate(input);

  if (valid) {
    return input; // Ajv has already filled defaults in-place.
  }

  const errors: InputValidationError[] = (validate.errors ?? []).map((err) => {
    const mapped: InputValidationError = {
      path: err.instancePath || "/",
      keyword: err.keyword,
      message: err.message ?? "validation error",
    };

    if (err.keyword === "type" && err.params) {
      mapped.expected = (err.params as { type?: string }).type;
      mapped.actual = typeof (input as Record<string, unknown>)[err.instancePath.slice(1).split("/")[0] ?? ""];
    }

    if (err.keyword === "required" && err.params) {
      mapped.expected = (err.params as { missingProperty?: string }).missingProperty;
    }

    return mapped;
  });

  throw new InputValidationFailure(errors);
}
