import type { JsonValue } from "@acpus/expression/ir";
import type { SchemaIR } from "@acpus/core/ir";

type RuntimeSchema = SchemaIR;

export function normalizeValue(schema: SchemaIR | undefined, value: JsonValue, label: string): JsonValue {
  if (!schema) return value;
  const issue = firstSchemaIssue(schema, value, "$");
  if (issue) throw new Error(`${label} does not match schema: ${issue}.`);
  return applyDefaults(schema, value) as JsonValue;
}

function firstSchemaIssue(schema: RuntimeSchema, value: JsonValue, path: string): string | undefined {
  if (value === null) return schema.nullable || schema.kind === "null" ? undefined : `${path} expected ${schema.kind}, got null`;

  switch (schema.kind) {
    case "unknown":
      return undefined;
    case "string":
    case "path":
      return typeof value === "string" ? undefined : `${path} expected string, got ${jsonType(value)}`;
    case "secret_ref":
      return validObject(value, { kind: "secret", name: "string" }, [], path);
    case "artifact":
      return validArtifact(value, schema, path);
    case "number":
      return typeof value === "number" ? undefined : `${path} expected number, got ${jsonType(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} expected boolean, got ${jsonType(value)}`;
    case "null":
      return value === null ? undefined : `${path} expected null, got ${jsonType(value)}`;
    case "literal":
      return Object.is(value, schema.value) ? undefined : `${path} expected literal ${JSON.stringify(schema.value)}`;
    case "enum":
      return schema.values.some(item => Object.is(item, value)) ? undefined : `${path} expected one of ${schema.values.map(item => JSON.stringify(item)).join(", ")}`;
    case "array":
      if (!Array.isArray(value)) return `${path} expected array, got ${jsonType(value)}`;
      for (const [index, item] of value.entries()) {
        const issue = firstSchemaIssue(schema.item, item, `${path}[${index}]`);
        if (issue) return issue;
      }
      return undefined;
    case "object": {
      if (!isJsonObject(value)) return `${path} expected object, got ${jsonType(value)}`;
      for (const key of schema.required) {
        if (!(key in value)) return `${path}.${key} is required`;
      }
      for (const [key, item] of Object.entries(value)) {
        const field = schema.fields[key];
        if (!field) {
          if (!schema.additionalProperties) return `${path}.${key} is not allowed`;
          continue;
        }
        const issue = firstSchemaIssue(field as RuntimeSchema, item, `${path}.${key}`);
        if (issue) return issue;
      }
      return undefined;
    }
    case "record":
      if (!isJsonObject(value)) return `${path} expected object, got ${jsonType(value)}`;
      for (const [key, item] of Object.entries(value)) {
        const valueIssue = firstSchemaIssue(schema.value as RuntimeSchema, item, `${path}.${key}`);
        if (valueIssue) return valueIssue;
      }
      return undefined;
    case "union":
      return schema.variants.some(variant => !firstSchemaIssue(variant as RuntimeSchema, value, path)) ? undefined : `${path} did not match any union variant`;
  }
}

function applyDefaults(schema: RuntimeSchema, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return schema.default;
  if (schema.kind === "object" && isJsonObject(value)) {
    const next: { [key: string]: JsonValue } = { ...value };
    for (const [key, field] of Object.entries(schema.fields)) {
      const normalized = applyDefaults(field as RuntimeSchema, next[key]);
      if (normalized !== undefined) next[key] = normalized;
    }
    return next;
  }
  if (schema.kind === "array" && Array.isArray(value)) return value.map(item => applyDefaults(schema.item as RuntimeSchema, item) ?? item);
  return value;
}

function validObject(value: JsonValue, required: Record<string, string>, optional: string[], path: string): string | undefined {
  if (!isJsonObject(value)) return `${path} expected object, got ${jsonType(value)}`;
  const allowed = new Set([...Object.keys(required), ...optional]);
  for (const [key, expected] of Object.entries(required)) {
    if (!(key in value)) return `${path}.${key} is required`;
    const item = value[key];
    if (item === undefined) return `${path}.${key} is required`;
    if (expected === "string" && typeof item !== "string") return `${path}.${key} expected string, got ${jsonType(item)}`;
    if (expected !== "string" && item !== expected) return `${path}.${key} expected ${JSON.stringify(expected)}`;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${path}.${key} is not allowed`;
    const item = value[key];
    if (optional.includes(key) && (item === undefined || typeof item !== "string")) return `${path}.${key} expected string, got ${item === undefined ? "undefined" : jsonType(item)}`;
  }
  return undefined;
}

function validArtifact(value: JsonValue, schema: Extract<RuntimeSchema, { kind: "artifact" }>, path: string): string | undefined {
  const issue = validObject(value, { kind: "artifact", uri: "string" }, ["mediaType"], path);
  if (issue) return issue;
  if (!schema.mediaType || !isJsonObject(value) || value.mediaType === undefined) return undefined;
  return value.mediaType === schema.mediaType ? undefined : `${path}.mediaType expected ${JSON.stringify(schema.mediaType)}`;
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonType(value: JsonValue): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
