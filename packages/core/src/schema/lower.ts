import { isDeepStrictEqual } from "node:util";
import { isJsonValue } from "@acpus/expression/ir";
import * as Result from "effect/Result";
import type { JsonPrimitive, JsonValue, SchemaIR } from "../ir/types.js";
import type { Schema } from "./zod.js";

export type SchemaLoweringError =
  | { type: "invalid-literal"; path: string; valueType: string; message: string }
  | { type: "invalid-default"; path: string; valueType: string; message: string }
  | { type: "unsupported-schema"; path: string; schemaKind: string; message: string };

function defOf(schema: Schema<any>): any {
  return schema.def;
}

function typeOf(schema: Schema<any>): string {
  return schema.type;
}

export function toSchemaIR(schema: Schema<any>, path = "$schema"): SchemaIR {
  return Result.match(tryToSchemaIR(schema, path), {
    onSuccess: ir => ir,
    onFailure: error => {
      throw new Error(error.message);
    },
  });
}

function withSchemaMetadata(schema: Schema<any>, ir: SchemaIR): SchemaIR {
  const constraints = numericConstraintSummary(schema);
  if (schema.description !== undefined) {
    if (constraints === undefined) return { ...ir, description: schema.description };
    return { ...ir, description: schema.description.trim().length === 0 ? constraints : `${schema.description} Constraints: ${constraints}.` };
  }
  return constraints === undefined || ir.description !== undefined ? ir : { ...ir, description: constraints };
}

function numericConstraintSummary(schema: Schema<any>): string | undefined {
  let target = schema;
  while (["optional", "nullable", "default", "readonly", "nonoptional"].includes(typeOf(target))) {
    const inner = defOf(target).innerType;
    if (inner === undefined) return undefined;
    target = inner as Schema<any>;
  }
  if (typeOf(target) !== "number") return undefined;
  const def = defOf(target);
  const checks = [
    ...(def.check === undefined ? [] : [def]),
    ...(Array.isArray(def.checks) ? def.checks.map((check: any) => check._zod?.def ?? check.def ?? check) : []),
  ];
  let integer = false;
  let minimum: { value: number; exclusive: boolean } | undefined;
  let maximum: { value: number; exclusive: boolean } | undefined;
  const multiples = new Set<number>();

  for (const check of checks) {
    if (check.check === "number_format" && check.format === "safeint") integer = true;
    if (check.check === "greater_than" && Number.isFinite(check.value)) {
      const candidate = { value: check.value as number, exclusive: !check.inclusive };
      if (minimum === undefined || candidate.value > minimum.value || candidate.value === minimum.value && candidate.exclusive) minimum = candidate;
    }
    if (check.check === "less_than" && Number.isFinite(check.value)) {
      const candidate = { value: check.value as number, exclusive: !check.inclusive };
      if (maximum === undefined || candidate.value < maximum.value || candidate.value === maximum.value && candidate.exclusive) maximum = candidate;
    }
    if (check.check === "multiple_of" && Number.isFinite(check.value)) multiples.add(check.value as number);
  }

  const summary = [
    ...(integer ? ["integer"] : []),
    ...(minimum === undefined ? [] : [`${minimum.exclusive ? "exclusiveMinimum" : "minimum"}: ${minimum.value}`]),
    ...(maximum === undefined ? [] : [`${maximum.exclusive ? "exclusiveMaximum" : "maximum"}: ${maximum.value}`]),
    ...[...multiples].sort((left, right) => left - right).map(value => `multipleOf: ${value}`),
  ];
  return summary.length === 0 ? undefined : summary.join("; ");
}

export function tryToSchemaIR(schema: Schema<any>, path = "$schema"): Result.Result<SchemaIR, SchemaLoweringError> {
  return Result.map(lowerSchemaIR(schema, path), ir => withSchemaMetadata(schema, ir));
}

function lowerSchemaIR(schema: Schema<any>, path = "$schema"): Result.Result<SchemaIR, SchemaLoweringError> {
  const def = defOf(schema);
  const kind = typeOf(schema);
  switch (kind) {
    case "string": return Result.succeed({ kind: "string" });
    case "number": return Result.succeed({ kind: "number" });
    case "boolean": return Result.succeed({ kind: "boolean" });
    case "null": return Result.succeed({ kind: "null" });
    case "unknown":
    case "any": return Result.succeed({ kind: "unknown" });
    case "literal": {
      const values = Array.isArray(def.values) ? def.values : [def.value];
      if (values.length === 1) {
        const only = values[0];
        if (only === undefined) return Result.fail({ type: "invalid-literal", path, valueType: "undefined", message: `${path}: literal value is missing` });
        return Result.map(tryNormalizeLiteral(only, path), value => ({ kind: "literal", value }));
      }
      const normalized: JsonPrimitive[] = [];
      for (const value of values) {
        const literal = tryNormalizeLiteral(value, path);
        if (Result.isFailure(literal)) return Result.fail(literal.failure);
        normalized.push(literal.success);
      }
      return Result.succeed({ kind: "enum", values: normalized });
    }
    case "enum": {
      const entries = def.entries ?? {};
      const numericValues = Object.values(entries).filter(value => typeof value === "number");
      const values: JsonPrimitive[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (numericValues.indexOf(+key) !== -1) continue;
        const literal = tryNormalizeLiteral(value, path);
        if (Result.isFailure(literal)) return Result.fail(literal.failure);
        values.push(literal.success);
      }
      return Result.succeed({ kind: "enum", values });
    }
    case "array": return Result.map(tryToSchemaIR(def.element, `${path}[]`), item => ({ kind: "array", item }));
    case "tuple": {
      if (def.rest) return unsupported(path, kind, "Zod tuple rest items are not supported as an Acpus graph-boundary schema");
      const items = Array.isArray(def.items) ? def.items as Schema<any>[] : [];
      if (items.length === 0) return unsupported(path, kind, "Zod tuple must contain at least one item to lower as an Acpus array");
      const lowered: SchemaIR[] = [];
      for (const [index, item] of items.entries()) {
        const itemIR = tryToSchemaIR(item, `${path}[${index}]`);
        if (Result.isFailure(itemIR)) return itemIR;
        lowered.push(itemIR.success);
      }
      const item = lowered[0]!;
      if (lowered.some(candidate => !isDeepStrictEqual(candidate, item))) {
        return unsupported(path, kind, "Zod tuple items must lower to the same Acpus array item schema");
      }
      return Result.succeed({ kind: "array", item });
    }
    case "object": return objectToSchemaIR(schema, path);
    case "record": return Result.map(tryToSchemaIR(def.valueType, `${path}.<value>`), value => ({ kind: "record", value }));
    case "union": {
      const variants: SchemaIR[] = [];
      for (const [index, option] of (def.options ?? []).entries()) {
        const variant = tryToSchemaIR(option as Schema<any>, `${path}.union[${index}]`);
        if (Result.isFailure(variant)) return variant;
        variants.push(variant.success);
      }
      return Result.succeed({ kind: "union", variants });
    }
    case "optional": return Result.map(tryToSchemaIR(def.innerType, path), inner => ({ ...inner, optional: true }));
    case "nullable": return Result.map(tryToSchemaIR(def.innerType, path), inner => ({ ...inner, nullable: true }));
    case "default": {
      const inner = tryToSchemaIR(def.innerType, path);
      if (Result.isFailure(inner)) return inner;
      let raw: unknown;
      try {
        raw = def.defaultValue;
      } catch {
        return Result.fail({ type: "invalid-default", path, valueType: "function", message: `${path}: default value factory could not be evaluated` });
      }
      const next: SchemaIR = { ...inner.success, optional: true };
      if (raw === undefined) return Result.succeed(next);
      const json = normalizeJsonValue(raw);
      if (json === undefined) return Result.fail({ type: "invalid-default", path, valueType: typeof raw, message: `${path}: default value is not JSON-serializable` });
      next.default = json;
      return Result.succeed(next);
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

function objectToSchemaIR(schema: Schema<any>, path: string): Result.Result<SchemaIR, SchemaLoweringError> {
  const def = defOf(schema);
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  const fields: Record<string, SchemaIR> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape ?? {})) {
    const childIR = tryToSchemaIR(child as Schema<any>, `${path}.${key}`);
    if (Result.isFailure(childIR)) return childIR;
    setOwnProperty(fields, key, childIR.success);
    if (!childIR.success.optional && childIR.success.default === undefined) required.push(key);
  }
  const catchall = def.catchall;
  const catchallType = catchall ? typeOf(catchall as Schema<any>) : undefined;
  return Result.succeed({ kind: "object", fields, required, additionalProperties: Boolean(catchall && catchallType !== "never") });
}

function tryNormalizeLiteral(value: unknown, path: string): Result.Result<JsonPrimitive, SchemaLoweringError> {
  if (typeof value === "string" || typeof value === "boolean" || value === null) return Result.succeed(value);
  if (typeof value === "number" && Number.isFinite(value)) return Result.succeed(value);
  return invalidLiteral(path, typeof value, `${path}: literal/enum value ${String(value)} is not JSON-serializable`);
}

function invalidLiteral(path: string, valueType: string, message: string): Result.Result<JsonPrimitive, SchemaLoweringError> {
  return Result.fail({ type: "invalid-literal", path, valueType, message });
}

function unsupported(path: string, schemaKind: string, message: string): Result.Result<SchemaIR, SchemaLoweringError> {
  return Result.fail({ type: "unsupported-schema", path, schemaKind, message: `${path}: ${message}` });
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (!isJsonValue(value)) return undefined;
  try {
    const clone: unknown = structuredClone(value);
    return isJsonValue(clone) ? clone : undefined;
  } catch {
    return undefined;
  }
}

export function schemaToJsonSchema(schema: SchemaIR): JsonValue {
  let jsonSchema: Record<string, JsonValue>;
  switch (schema.kind) {
    case "unknown": jsonSchema = {}; break;
    case "string": jsonSchema = { type: "string" }; break;
    case "number": jsonSchema = { type: "number" }; break;
    case "boolean": jsonSchema = { type: "boolean" }; break;
    case "null": jsonSchema = { type: "null" }; break;
    case "literal": jsonSchema = { const: schema.value }; break;
    case "enum": jsonSchema = { enum: schema.values }; break;
    case "array": jsonSchema = { type: "array", items: schemaToJsonSchema(schema.item as SchemaIR) }; break;
    case "record": jsonSchema = { type: "object", additionalProperties: schemaToJsonSchema(schema.value as SchemaIR) }; break;
    case "union": jsonSchema = { anyOf: schema.variants.map(v => schemaToJsonSchema(v as SchemaIR)) }; break;
    case "object": {
      const properties: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(schema.fields)) setOwnProperty(properties, key, schemaToJsonSchema(value as SchemaIR));
      jsonSchema = { type: "object", properties, required: schema.required, additionalProperties: schema.additionalProperties };
      break;
    }
  }

  if (schema.nullable && schema.kind !== "null") jsonSchema = { anyOf: [jsonSchema, { type: "null" }] };
  if (schema.description !== undefined) jsonSchema.description = schema.description;
  if (schema.default !== undefined) jsonSchema.default = schema.default;
  return jsonSchema;
}

function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
