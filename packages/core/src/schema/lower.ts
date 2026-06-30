import * as zod from "zod";
import type { JsonPrimitive, JsonValue, SchemaIR } from "../ir/types.js";
import type { Schema } from "./zod.js";

export function toJSONSchema(schema: Schema<any>): JsonValue {
  return zod.toJSONSchema(schema as zod.ZodTypeAny) as JsonValue;
}

export function assertBoundarySchema(schema: Schema<any>, path = "$schema"): void {
  toSchemaIR(schema, path);
}

function defOf(schema: Schema<any>): any {
  return (schema as any).def ?? (schema as any)._def;
}

function typeOf(schema: Schema<any>): string {
  return String(defOf(schema)?.type ?? "unknown");
}

export function toSchemaIR(schema: Schema<any>, path = "$schema"): SchemaIR {
  const meta = zod.globalRegistry.get(schema as zod.ZodTypeAny) as any;
  const acpus = meta?.acpus as { kind?: string; mediaType?: string } | undefined;
  if (acpus?.kind === "path") return { kind: "path" };
  if (acpus?.kind === "artifact") return acpus.mediaType === undefined ? { kind: "artifact" } : { kind: "artifact", mediaType: acpus.mediaType };
  if (acpus?.kind === "secret_ref") return { kind: "secret_ref" };
  if (acpus?.kind === "integer") return { kind: "number" };

  const def = defOf(schema);
  switch (typeOf(schema)) {
    case "string": return { kind: "string" };
    case "number": return { kind: "number" };
    case "boolean": return { kind: "boolean" };
    case "null": return { kind: "null" };
    case "unknown":
    case "any": return { kind: "unknown" };
    case "literal": {
      const values = Array.isArray(def.values) ? def.values : [def.value];
      if (values.length === 1) {
        const only = values[0];
        if (only === undefined) throw new Error(`${path}: literal value is missing`);
        return { kind: "literal", value: normalizeLiteral(only, path) };
      }
      return { kind: "enum", values: values.map((v: unknown) => normalizeLiteral(v, path)) };
    }
    case "enum": return { kind: "enum", values: Object.values(def.entries ?? {}).map((v: unknown) => normalizeLiteral(v, path)) };
    case "array": return { kind: "array", item: toSchemaIR(def.element, `${path}[]`) };
    case "object": return objectToSchemaIR(schema, path);
    case "record": return { kind: "record", value: toSchemaIR(def.valueType, `${path}.<value>`) };
    case "union": return { kind: "union", variants: (def.options ?? []).map((option: Schema<any>, index: number) => toSchemaIR(option, `${path}.union[${index}]`)) };
    case "optional": return { ...toSchemaIR(def.innerType, path), optional: true };
    case "nullable": return { ...toSchemaIR(def.innerType, path), nullable: true };
    case "default": {
      const inner = toSchemaIR(def.innerType, path);
      const raw = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      const next: SchemaIR = { ...inner, optional: true };
      if (raw !== undefined) next.default = raw as JsonValue;
      return next;
    }
    case "readonly":
    case "nonoptional": return toSchemaIR(def.innerType, path);
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
    case "never": return unsupported(path, `Zod '${typeOf(schema)}' is not supported as an Acpus graph-boundary schema`);
    default: return unsupported(path, `unsupported Zod schema type '${typeOf(schema)}'`);
  }
}

function objectToSchemaIR(schema: Schema<any>, path: string): SchemaIR {
  const def = defOf(schema);
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  const fields: Record<string, SchemaIR> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape ?? {})) {
    const childIR = toSchemaIR(child as Schema<any>, `${path}.${key}`);
    fields[key] = childIR;
    if (!childIR.optional && childIR.default === undefined) required.push(key);
  }
  const catchall = def.catchall;
  const catchallType = catchall ? typeOf(catchall as Schema<any>) : undefined;
  return { kind: "object", fields, required, additionalProperties: Boolean(catchall && catchallType !== "never") };
}

function normalizeLiteral(value: unknown, path: string): JsonPrimitive {
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  throw new Error(`${path}: literal/enum value ${String(value)} is not JSON-serializable`);
}

function unsupported(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

export function schemaToJsonSchema(schema: SchemaIR): JsonValue {
  switch (schema.kind) {
    case "unknown": return {};
    case "string":
    case "path": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "null": return { type: "null" };
    case "secret_ref": return { type: "object", properties: { kind: { const: "secret" }, name: { type: "string" } }, required: ["kind", "name"], additionalProperties: false };
    case "literal": return { const: schema.value };
    case "enum": return { enum: schema.values };
    case "array": return { type: "array", items: schemaToJsonSchema(schema.item as SchemaIR) };
    case "record": return { type: "object", additionalProperties: schemaToJsonSchema(schema.value as SchemaIR) };
    case "union": return { anyOf: schema.variants.map(v => schemaToJsonSchema(v as SchemaIR)) };
    case "artifact": return { type: "object", properties: { kind: { const: "artifact" }, uri: { type: "string" }, mediaType: { type: "string" } }, required: ["kind", "uri"], additionalProperties: false };
    case "object": {
      const properties: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(schema.fields)) properties[key] = schemaToJsonSchema(value as SchemaIR);
      return { type: "object", properties, required: schema.required, additionalProperties: schema.additionalProperties };
    }
  }
}
