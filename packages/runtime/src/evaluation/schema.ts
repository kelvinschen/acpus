import type { JsonValue } from "@acpus/expression/ir";
import type { SchemaIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";

type RuntimeSchema = SchemaIR;

export type SchemaNormalizationFailure = {
  type: "schema-mismatch";
  label: string;
  path: string;
  expected: string;
  actual?: string;
  message: string;
};

type SchemaIssue = Omit<SchemaNormalizationFailure, "type" | "label" | "message"> & { detail: string };

export function tryNormalizeValue(schema: SchemaIR | undefined, value: JsonValue, label: string): Result<JsonValue, SchemaNormalizationFailure> {
  if (!schema) return ok(value);
  const issue = firstSchemaIssue(schema, value, "$");
  if (issue) return err({
    type: "schema-mismatch",
    label,
    path: issue.path,
    expected: issue.expected,
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    message: `${label} does not match schema: ${issue.detail}.`,
  });
  return ok(applyDefaults(schema, value) as JsonValue);
}

function firstSchemaIssue(schema: RuntimeSchema, value: JsonValue, path: string): SchemaIssue | undefined {
  if (value === null && schema.nullable) return undefined;

  switch (schema.kind) {
    case "unknown":
      return undefined;
    case "string":
      return typeof value === "string" ? undefined : issue(path, "string", jsonType(value));
    case "number":
      return typeof value === "number" ? undefined : issue(path, "number", jsonType(value));
    case "boolean":
      return typeof value === "boolean" ? undefined : issue(path, "boolean", jsonType(value));
    case "null":
      return value === null ? undefined : issue(path, "null", jsonType(value));
    case "literal":
      return Object.is(value, schema.value) ? undefined : customIssue(path, `literal ${JSON.stringify(schema.value)}`);
    case "enum":
      return schema.values.some(item => Object.is(item, value))
        ? undefined
        : customIssue(path, `one of ${schema.values.map(item => JSON.stringify(item)).join(", ")}`);
    case "array":
      if (!Array.isArray(value)) return issue(path, "array", jsonType(value));
      for (const [index, item] of value.entries()) {
        const child = firstSchemaIssue(schema.item, item, `${path}[${index}]`);
        if (child) return child;
      }
      return undefined;
    case "object": {
      if (!isJsonObject(value)) return issue(path, "object", jsonType(value));
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) return customIssue(`${path}.${key}`, "required field", "missing", `${path}.${key} is required`);
      }
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(schema.fields, key)) {
          if (!schema.additionalProperties) return customIssue(`${path}.${key}`, "declared field", "additional property", `${path}.${key} is not allowed`);
          continue;
        }
        const child = firstSchemaIssue(schema.fields[key] as RuntimeSchema, item, `${path}.${key}`);
        if (child) return child;
      }
      return undefined;
    }
    case "record":
      if (!isJsonObject(value)) return issue(path, "object", jsonType(value));
      for (const [key, item] of Object.entries(value)) {
        const child = firstSchemaIssue(schema.value as RuntimeSchema, item, `${path}.${key}`);
        if (child) return child;
      }
      return undefined;
    case "union":
      return schema.variants.some(variant => !firstSchemaIssue(variant as RuntimeSchema, value, path))
        ? undefined
        : customIssue(path, "one union variant", jsonType(value), `${path} did not match any union variant`);
  }
}

function applyDefaults(schema: RuntimeSchema, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return schema.default;
  if (schema.kind === "object" && isJsonObject(value)) {
    const next = Object.fromEntries(Object.entries(value)) as { [key: string]: JsonValue };
    for (const [key, field] of Object.entries(schema.fields)) {
      const normalized = applyDefaults(field as RuntimeSchema, Object.hasOwn(next, key) ? next[key] : undefined);
      if (normalized !== undefined) {
        Object.defineProperty(next, key, { value: normalized, enumerable: true, configurable: true, writable: true });
      }
    }
    return next;
  }
  if (schema.kind === "array" && Array.isArray(value)) return value.map(item => applyDefaults(schema.item as RuntimeSchema, item) ?? item);
  return value;
}

function issue(path: string, expected: string, actual: string): SchemaIssue {
  return customIssue(path, expected, actual, `${path} expected ${expected}, got ${actual}`);
}

function customIssue(path: string, expected: string, actual?: string, detail = `${path} expected ${expected}`): SchemaIssue {
  return { path, expected, ...(actual === undefined ? {} : { actual }), detail };
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonType(value: JsonValue): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
