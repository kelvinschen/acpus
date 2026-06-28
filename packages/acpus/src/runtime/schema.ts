import type { JsonValue, SchemaIR, TypeIR } from "@acpus/core";
import { stableStringify } from "./expr.js";

export type RuntimeValidationIssue = {
  path: string;
  message: string;
  expected?: string;
  received?: string;
};

export type RuntimeParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; issues: RuntimeValidationIssue[] };

type RuntimeSchema = (SchemaIR | TypeIR) & {
  optional?: boolean;
  nullable?: boolean;
  default?: JsonValue;
};

export function parseSchemaIR(schema: SchemaIR | undefined, value: unknown, label = "$value"): RuntimeParseResult {
  if (!schema) return { ok: true, value: normalizeJson(value) };
  const issues: RuntimeValidationIssue[] = [];
  const parsed = parseValue(schema, value, label, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: normalizeJson(parsed) };
}

export function validationMessage(issues: RuntimeValidationIssue[]): string {
  return issues.map(issue => `${issue.path}: ${issue.message}`).join("; ");
}

export function defaultValueForSchema(schema: SchemaIR | undefined): JsonValue {
  if (!schema) return null;
  if ((schema as RuntimeSchema).default !== undefined) return cloneJson((schema as RuntimeSchema).default as JsonValue);
  switch (schema.kind) {
    case "string":
    case "path": return "";
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "null": return null;
    case "literal": return normalizeJson(schema.value);
    case "enum": return schema.values.length > 0 ? normalizeJson(schema.values[0]) : null;
    case "array": return [];
    case "object": {
      const out: Record<string, JsonValue> = {};
      for (const key of schema.required) out[key] = defaultValueForSchema(schema.fields[key] as SchemaIR | undefined);
      return out;
    }
    case "record": return {};
    case "union": return schema.variants.length > 0 ? defaultValueForSchema(schema.variants[0] as SchemaIR) : null;
    case "artifact": return { kind: "artifact", uri: "acpus://stub/artifact", ...(schema.mediaType ? { mediaType: schema.mediaType } : {}) };
    case "secret_ref": return { kind: "secret", name: "" };
    case "unknown": return null;
    default: return null;
  }
}

function parseValue(schema: RuntimeSchema, value: unknown, path: string, issues: RuntimeValidationIssue[]): unknown {
  if (value === undefined) {
    if (schema.default !== undefined) return cloneJson(schema.default);
    if (schema.optional) return undefined;
    issue(issues, path, "is required", schema.kind, "undefined");
    return undefined;
  }
  if (value === null) {
    if (schema.nullable || schema.kind === "null" || schema.kind === "unknown") return null;
    issue(issues, path, "must not be null", schema.kind, "null");
    return undefined;
  }

  switch (schema.kind) {
    case "unknown": return normalizeJson(value);
    case "string":
    case "path": {
      if (typeof value !== "string") issue(issues, path, "must be a string", schema.kind, typeof value);
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) issue(issues, path, "must be an integer", "integer", typeof value);
      return value;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) issue(issues, path, "must be a number", "number", typeof value);
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") issue(issues, path, "must be a boolean", "boolean", typeof value);
      return value;
    }
    case "null": {
      issue(issues, path, "must be null", "null", typeof value);
      return undefined;
    }
    case "literal": {
      if (stableStringify(value) !== stableStringify(schema.value)) issue(issues, path, `must equal ${JSON.stringify(schema.value)}`, "literal", typeof value);
      return value;
    }
    case "enum": {
      if (!schema.values.some(candidate => stableStringify(candidate) === stableStringify(value))) issue(issues, path, `must be one of ${schema.values.map(item => JSON.stringify(item)).join(", ")}`, "enum", typeof value);
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issue(issues, path, "must be an array", "array", typeof value);
        return undefined;
      }
      return value.map((item, index) => parseValue(schema.item as RuntimeSchema, item, `${path}[${index}]`, issues));
    }
    case "object": return parseObject(schema, value, path, issues);
    case "record": return parseRecord(schema, value, path, issues);
    case "union": return parseUnion(schema, value, path, issues);
    case "artifact": {
      if (!isObject(value) || value.kind !== "artifact" || typeof value.uri !== "string") {
        issue(issues, path, "must be an artifact reference", "artifact", typeof value);
      } else if (schema.mediaType && typeof value.mediaType === "string" && value.mediaType !== schema.mediaType) {
        issue(issues, `${path}.mediaType`, `must be ${schema.mediaType}`, schema.mediaType, value.mediaType);
      }
      return value;
    }
    case "secret_ref": {
      if (!isObject(value) || value.kind !== "secret" || typeof value.name !== "string") issue(issues, path, "must be a secret reference", "secret_ref", typeof value);
      return value;
    }
    default: {
      issue(issues, path, `uses unsupported schema kind ${(schema as { kind?: unknown }).kind}`, "supported SchemaIR", typeof value);
      return value;
    }
  }
}

function parseObject(schema: Extract<TypeIR, { kind: "object" }>, value: unknown, path: string, issues: RuntimeValidationIssue[]): unknown {
  if (!isObject(value)) {
    issue(issues, path, "must be an object", "object", Array.isArray(value) ? "array" : typeof value);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  const required = new Set(schema.required);
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    const field = fieldSchema as RuntimeSchema;
    const hasKey = Object.prototype.hasOwnProperty.call(value, key);
    if (!hasKey) {
      if (field.default !== undefined) out[key] = cloneJson(field.default);
      else if (required.has(key) && !field.optional) issue(issues, `${path}.${key}`, "is required", field.kind, "undefined");
      continue;
    }
    const parsed = parseValue(field, value[key], `${path}.${key}`, issues);
    if (parsed !== undefined) out[key] = parsed;
  }
  if (!schema.additionalProperties) {
    for (const key of Object.keys(value)) {
      if (!(key in schema.fields)) issue(issues, `${path}.${key}`, "is not allowed", "known field", "extra field");
    }
  } else {
    for (const [key, item] of Object.entries(value)) if (!(key in schema.fields)) out[key] = item;
  }
  return out;
}

function parseRecord(schema: Extract<TypeIR, { kind: "record" }>, value: unknown, path: string, issues: RuntimeValidationIssue[]): unknown {
  if (!isObject(value)) {
    issue(issues, path, "must be an object", "record", Array.isArray(value) ? "array" : typeof value);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = parseValue(schema.value as RuntimeSchema, item, `${path}.${key}`, issues);
  return out;
}

function parseUnion(schema: Extract<TypeIR, { kind: "union" }>, value: unknown, path: string, issues: RuntimeValidationIssue[]): unknown {
  const collected: RuntimeValidationIssue[][] = [];
  for (const variant of schema.variants) {
    const variantIssues: RuntimeValidationIssue[] = [];
    const parsed = parseValue(variant as RuntimeSchema, value, path, variantIssues);
    if (variantIssues.length === 0) return parsed;
    collected.push(variantIssues);
  }
  issue(issues, path, `did not match any union variant (${collected.map(group => group[0]?.message ?? "invalid").join("; ")})`, "union", typeof value);
  return undefined;
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(issues: RuntimeValidationIssue[], path: string, message: string, expected?: string, received?: string): void {
  issues.push({ path, message, ...(expected ? { expected } : {}), ...(received ? { received } : {}) });
}
