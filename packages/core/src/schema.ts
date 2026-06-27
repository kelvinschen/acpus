import * as zod from "zod";
import type { JsonPrimitive, JsonValue, SchemaIR, TypeIR } from "./ir.js";

export type Schema<T = unknown> = zod.ZodType<T>;
export type InferSchema<S> = S extends zod.ZodType ? zod.output<S> : never;

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ValidationIssue[] };

export type ValidationIssue = {
  path: string;
  message: string;
  expected?: string;
  received?: string;
};

export type ArtifactRef = {
  readonly kind: "artifact";
  readonly uri: string;
  readonly mediaType?: string;
};

export type SecretRef = {
  readonly kind: "secret";
  readonly name: string;
};

type AcpusZodExtensions = {
  integer(): zod.ZodType<number>;
  path(): zod.ZodType<string>;
  artifact(mediaType?: string): zod.ZodType<ArtifactRef>;
  secretRef(): zod.ZodType<SecretRef>;
};

function withAcpusMeta<T extends zod.ZodTypeAny>(schema: T, acpus: Record<string, unknown>): T {
  return schema.meta({ ...(zod.globalRegistry.get(schema) ?? {}), acpus }) as T;
}

export const z = {
  ...zod,
  integer(): zod.ZodType<number> {
    return withAcpusMeta(zod.number().int(), { kind: "integer" });
  },
  path(): zod.ZodType<string> {
    return withAcpusMeta(zod.string(), { kind: "path" }) as zod.ZodType<string>;
  },
  artifact(mediaType?: string): zod.ZodType<ArtifactRef> {
    const schema = zod.object({
      kind: zod.literal("artifact"),
      uri: zod.string(),
      mediaType: zod.string().optional(),
    }) as unknown as zod.ZodType<ArtifactRef>;
    return withAcpusMeta(schema as zod.ZodTypeAny, mediaType === undefined ? { kind: "artifact" } : { kind: "artifact", mediaType }) as zod.ZodType<ArtifactRef>;
  },
  secretRef(): zod.ZodType<SecretRef> {
    const schema = zod.object({ kind: zod.literal("secret"), name: zod.string() }) as unknown as zod.ZodType<SecretRef>;
    return withAcpusMeta(schema as zod.ZodTypeAny, { kind: "secret_ref" }) as zod.ZodType<SecretRef>;
  },
} as typeof zod & AcpusZodExtensions;

export const s = z;

export function isSchema(value: unknown): value is Schema<any> {
  return Boolean(value && typeof value === "object" && typeof (value as any).safeParse === "function" && ((value as any).def || (value as any)._def));
}

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
  if (acpus?.kind === "integer") return { kind: "integer" };

  const def = defOf(schema);
  switch (typeOf(schema)) {
    case "string": return { kind: "string" };
    case "number": return isIntegerNumberSchema(schema) ? { kind: "integer" } : { kind: "number" };
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
    case "record": return { kind: "record", key: toSchemaIR(def.keyType, `${path}.<key>`), value: toSchemaIR(def.valueType, `${path}.<value>`) };
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
  const fields: Record<string, TypeIR> = {};
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

function isIntegerNumberSchema(schema: Schema<any>): boolean {
  const meta = zod.globalRegistry.get(schema as zod.ZodTypeAny) as any;
  if (meta?.acpus?.kind === "integer") return true;
  const def = defOf(schema);
  return Array.isArray(def.checks) && def.checks.some((check: any) => check?.isInt === true || check?.format === "safeint" || check?.def?.format === "safeint" || check?._zod?.def?.format === "safeint");
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
    case "integer": return { type: "integer" };
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
