import * as zod from "zod";
import { err, ok, type Result } from "neverthrow";
import type { JsonPrimitive, JsonValue, SchemaIR } from "../ir/types.js";
import type { Schema } from "./zod.js";

export function toJSONSchema(schema: Schema<any>): JsonValue {
  return zod.toJSONSchema(schema as zod.ZodTypeAny) as JsonValue;
}

export function assertBoundarySchema(schema: Schema<any>, path = "$schema"): void {
  toSchemaIR(schema, path);
}

export type SchemaLoweringError =
  | { type: "invalid-literal"; path: string; valueType: string; message: string }
  | { type: "invalid-default"; path: string; valueType: string; message: string }
  | { type: "unsupported-schema"; path: string; schemaKind: string; message: string };

function defOf(schema: Schema<any>): any {
  return (schema as any).def ?? (schema as any)._def;
}

function typeOf(schema: Schema<any>): string {
  return String(defOf(schema)?.type ?? "unknown");
}

export function toSchemaIR(schema: Schema<any>, path = "$schema"): SchemaIR {
  return tryToSchemaIR(schema, path).match(
    ir => ir,
    error => {
      throw new Error(error.message);
    },
  );
}

function withSchemaMetadata(schema: Schema<any>, ir: SchemaIR): SchemaIR {
  const meta = zod.globalRegistry.get(schema as zod.ZodTypeAny) as any;
  return typeof meta?.description === "string" ? { ...ir, description: meta.description } : ir;
}

export function tryToSchemaIR(schema: Schema<any>, path = "$schema"): Result<SchemaIR, SchemaLoweringError> {
  return lowerSchemaIR(schema, path).map(ir => withSchemaMetadata(schema, ir));
}

function lowerSchemaIR(schema: Schema<any>, path = "$schema"): Result<SchemaIR, SchemaLoweringError> {
  const def = defOf(schema);
  const kind = typeOf(schema);
  switch (kind) {
    case "string": return ok({ kind: "string" });
    case "number": return ok({ kind: "number" });
    case "boolean": return ok({ kind: "boolean" });
    case "null": return ok({ kind: "null" });
    case "unknown":
    case "any": return ok({ kind: "unknown" });
    case "literal": {
      const values = Array.isArray(def.values) ? def.values : [def.value];
      if (values.length === 1) {
        const only = values[0];
        if (only === undefined) return err({ type: "invalid-literal", path, valueType: "undefined", message: `${path}: literal value is missing` });
        return tryNormalizeLiteral(only, path).map(value => ({ kind: "literal", value }));
      }
      const normalized: JsonPrimitive[] = [];
      for (const value of values) {
        const literal = tryNormalizeLiteral(value, path);
        if (literal.isErr()) return err(literal.error);
        normalized.push(literal.value);
      }
      return ok({ kind: "enum", values: normalized });
    }
    case "enum": {
      const values: JsonPrimitive[] = [];
      for (const value of Object.values(def.entries ?? {})) {
        const literal = tryNormalizeLiteral(value, path);
        if (literal.isErr()) return err(literal.error);
        values.push(literal.value);
      }
      return ok({ kind: "enum", values });
    }
    case "array": return tryToSchemaIR(def.element, `${path}[]`).map(item => ({ kind: "array", item }));
    case "object": return objectToSchemaIR(schema, path);
    case "record": return tryToSchemaIR(def.valueType, `${path}.<value>`).map(value => ({ kind: "record", value }));
    case "union": {
      const variants: SchemaIR[] = [];
      for (const [index, option] of (def.options ?? []).entries()) {
        const variant = tryToSchemaIR(option as Schema<any>, `${path}.union[${index}]`);
        if (variant.isErr()) return variant;
        variants.push(variant.value);
      }
      return ok({ kind: "union", variants });
    }
    case "optional": return tryToSchemaIR(def.innerType, path).map(inner => ({ ...inner, optional: true }));
    case "nullable": return tryToSchemaIR(def.innerType, path).map(inner => ({ ...inner, nullable: true }));
    case "default": {
      const inner = tryToSchemaIR(def.innerType, path);
      if (inner.isErr()) return inner;
      const raw = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      const next: SchemaIR = { ...inner.value, optional: true };
      if (raw === undefined) return ok(next);
      const json = normalizeJsonValue(raw);
      if (json === undefined) return err({ type: "invalid-default", path, valueType: typeof raw, message: `${path}: default value is not JSON-serializable` });
      next.default = json;
      return ok(next);
    }
    case "readonly":
    case "nonoptional": return tryToSchemaIR(def.innerType, path);
    case "pipe":
    case "transform":
    case "custom":
    case "function":
    case "promise":
    case "map":
    case "set":
    case "date":
    case "bigint":
    case "symbol":
    case "undefined":
    case "void":
    case "never": return unsupported(path, kind, `Zod '${kind}' is not supported as an Acpus graph-boundary schema`);
    default: return unsupported(path, kind, `unsupported Zod schema type '${kind}'`);
  }
}



function objectToSchemaIR(schema: Schema<any>, path: string): Result<SchemaIR, SchemaLoweringError> {
  const def = defOf(schema);
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  const fields: Record<string, SchemaIR> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape ?? {})) {
    const childIR = tryToSchemaIR(child as Schema<any>, `${path}.${key}`);
    if (childIR.isErr()) return childIR;
    fields[key] = childIR.value;
    if (!childIR.value.optional && childIR.value.default === undefined) required.push(key);
  }
  const catchall = def.catchall;
  const catchallType = catchall ? typeOf(catchall as Schema<any>) : undefined;
  return ok({ kind: "object", fields, required, additionalProperties: Boolean(catchall && catchallType !== "never") });
}

function tryNormalizeLiteral(value: unknown, path: string): Result<JsonPrimitive, SchemaLoweringError> {
  if (typeof value === "string" || typeof value === "boolean" || value === null) return ok(value);
  if (typeof value === "number" && Number.isFinite(value)) return ok(value);
  return invalidLiteral(path, typeof value, `${path}: literal/enum value ${String(value)} is not JSON-serializable`);
}

function invalidLiteral(path: string, valueType: string, message: string): Result<JsonPrimitive, SchemaLoweringError> {
  return err({ type: "invalid-literal", path, valueType, message });
}

function unsupported(path: string, schemaKind: string, message: string): Result<SchemaIR, SchemaLoweringError> {
  return err({ type: "unsupported-schema", path, schemaKind, message: `${path}: ${message}` });
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const next = normalizeJsonValue(item);
      if (next === undefined) return undefined;
      items.push(next);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const fields: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = normalizeJsonValue(item);
      if (next === undefined) return undefined;
      fields[key] = next;
    }
    return fields;
  }
  return undefined;
}

export function schemaToJsonSchema(schema: SchemaIR): JsonValue {
  switch (schema.kind) {
    case "unknown": return {};
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "null": return { type: "null" };
    case "literal": return { const: schema.value };
    case "enum": return { enum: schema.values };
    case "array": return { type: "array", items: schemaToJsonSchema(schema.item as SchemaIR) };
    case "record": return { type: "object", additionalProperties: schemaToJsonSchema(schema.value as SchemaIR) };
    case "union": return { anyOf: schema.variants.map(v => schemaToJsonSchema(v as SchemaIR)) };
    case "object": {
      const properties: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(schema.fields)) properties[key] = schemaToJsonSchema(value as SchemaIR);
      return { type: "object", properties, required: schema.required, additionalProperties: schema.additionalProperties };
    }
  }
}
