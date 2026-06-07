/**
 * Acpus recursive schema DSL compiler.
 *
 * User-facing YAML examples:
 *
 *   ok: boolean
 *   summary?: string
 *   issues:
 *     - description: string
 *       severity?: string
 *   metadata:
 *     title: string
 *
 * The compiler emits JSON Schema for IR/runtime validation. The user-facing
 * DSL is intentionally smaller than JSON Schema and rejects unsupported
 * object-form schema keys rather than silently ignoring them.
 */

import {
  isRecord,
  normalizeType,
  parseDefaultValue,
  parseKey,
  VALID_TYPES,
} from "./helpers.js";

export interface SchemaDslError {
  field: string;
  message: string;
}

export interface CompileSchemaDslResult {
  schema: Record<string, unknown>;
  errors: SchemaDslError[];
}

export interface CompileSchemaDslOptions {
  /** When true, emitted object schemas include additionalProperties: false. Default: true. */
  strictObjectKeys?: boolean;
}

interface ParsedField {
  property: Record<string, unknown>;
  isRequired: boolean;
  errors: SchemaDslError[];
}

const OBJECT_FORM_KEYS = new Set(["type", "required", "default", "description"]);
const UNSUPPORTED_SCHEMA_KEY_HINTS = new Set(["items", "properties", "elements"]);

/**
 * Compile an Acpus recursive schema DSL map into JSON Schema.
 */
export function compileSchemaDsl(schemaDsl: Record<string, unknown>, options?: CompileSchemaDslOptions): CompileSchemaDslResult {
  const strict = options?.strictObjectKeys ?? true;
  return compileSchemaMap(schemaDsl, "", strict);
}

function compileSchemaMap(map: Record<string, unknown>, path: string, strict: boolean): CompileSchemaDslResult {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const errors: SchemaDslError[] = [];

  for (const [rawKey, value] of Object.entries(map)) {
    const { name, optional } = parseKey(rawKey);
    if (name.length === 0) {
      errors.push({ field: path, message: `Schema DSL field name from key '${rawKey}' must be non-empty.` });
      continue;
    }

    const fieldPath = path ? `${path}.${name}` : name;
    const result = parseFieldValue(name, value, optional, fieldPath, strict);
    errors.push(...result.errors);

    // Only include the field in properties when it has no errors.
    // Sibling valid fields are preserved; the caller checks errors to
    // decide whether to use the schema.
    if (result.errors.length === 0) {
      properties[name] = result.property;
      if (result.isRequired) {
        required.push(name);
      }
    }
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (strict) {
    schema.additionalProperties = false;
  }
  if (required.length > 0) {
    schema.required = required;
  }

  return { schema, errors };
}

function parseFieldValue(
  name: string,
  value: unknown,
  keyOptional: boolean,
  path: string,
  strict: boolean
): ParsedField {
  if (typeof value === "string") {
    return parseStringShorthand(name, value, keyOptional, path, strict);
  }

  if (Array.isArray(value)) {
    return parseArrayShorthand(name, value, keyOptional, path, strict);
  }

  if (isRecord(value)) {
    if ("type" in value) {
      return parseObjectForm(name, value, keyOptional, path, strict);
    }
    return parseNestedObject(name, value, keyOptional, path, strict);
  }

  return {
    property: {},
    isRequired: false,
    errors: [{ field: path, message: `schema DSL field '${name}' must be a type string, a nested object map, an array schema, or an object form with type.` }],
  };
}

function parseStringShorthand(
  name: string,
  value: string,
  keyOptional: boolean,
  path: string,
  strict: boolean
): ParsedField {
  const eqIndex = value.indexOf("=");
  let typePart: string;
  let defaultValue: unknown = undefined;
  let hasDefault = false;

  if (eqIndex !== -1) {
    typePart = value.slice(0, eqIndex).trim();
    const rawDefault = value.slice(eqIndex + 1).trim();
    hasDefault = true;
    defaultValue = parseDefaultValue(rawDefault);
  } else {
    typePart = value.trim();
  }

  const normalized = normalizeType(typePart);
  if (!normalized) {
    return invalidType(name, typePart, path);
  }

  const property: Record<string, unknown> = { type: normalized };
  if (normalized === "object" && strict) {
    property.additionalProperties = false;
  }
  if (hasDefault) {
    property.default = defaultValue;
  }

  return {
    property,
    isRequired: !keyOptional && !hasDefault,
    errors: [],
  };
}

function parseArrayShorthand(
  name: string,
  value: unknown[],
  keyOptional: boolean,
  path: string,
  strict: boolean
): ParsedField {
  if (value.length !== 1) {
    return {
      property: {},
      isRequired: false,
      errors: [{ field: path, message: `Array schema for field '${name}' must contain exactly one item schema.` }],
    };
  }

  const itemSchema = value[0];
  const itemResult = parseArrayItemSchema(`${name}[]`, itemSchema, `${path}[]`, strict);
  if (itemResult.errors.length > 0) {
    return { property: {}, isRequired: false, errors: itemResult.errors };
  }

  return {
    property: {
      type: "array",
      items: itemResult.property,
    },
    isRequired: !keyOptional,
    errors: [],
  };
}

function parseArrayItemSchema(name: string, value: unknown, path: string, strict: boolean): Pick<ParsedField, "property" | "errors"> {
  if (typeof value === "string") {
    const parsed = parseStringShorthand(name, value, false, path, strict);
    return { property: parsed.property, errors: parsed.errors };
  }

  if (Array.isArray(value)) {
    const parsed = parseArrayShorthand(name, value, false, path, strict);
    return { property: parsed.property, errors: parsed.errors };
  }

  if (isRecord(value)) {
    if ("type" in value) {
      const parsed = parseObjectForm(name, value, false, path, strict);
      return { property: parsed.property, errors: parsed.errors };
    }
    const nested = compileSchemaMap(value, path, strict);
    return { property: nested.schema, errors: nested.errors };
  }

  return {
    property: {},
    errors: [{ field: path, message: `Array item schema for field '${name}' must be a type string, a nested object map, an array schema, or an object form with type.` }],
  };
}

function parseNestedObject(
  _name: string,
  value: Record<string, unknown>,
  keyOptional: boolean,
  path: string,
  strict: boolean
): ParsedField {
  const nested = compileSchemaMap(value, path, strict);
  return {
    property: nested.schema,
    isRequired: !keyOptional,
    errors: nested.errors,
  };
}

function parseObjectForm(
  name: string,
  value: Record<string, unknown>,
  keyOptional: boolean,
  path: string,
  strict: boolean
): ParsedField {
  // Collect ALL errors before returning so the user gets a complete picture.
  const errors = validateObjectFormKeys(name, value, path);
  const rawType = value.type;

  if (typeof rawType !== "string") {
    errors.push({ field: path, message: `Object form for field '${name}' must include a string 'type'.` });
  } else {
    // Also validate the type string even if there are unsupported-key errors,
    // so the user sees all problems at once.
    const normalized = normalizeType(rawType);
    if (!normalized) {
      errors.push({ field: path, message: `Invalid type '${rawType}' for field '${name}'. Valid types: ${[...VALID_TYPES].join(", ")}.` });
    }
  }

  if (errors.length > 0) {
    return { property: {}, isRequired: false, errors };
  }

  const normalized = normalizeType(rawType as string)!;

  const property: Record<string, unknown> = { type: normalized };
  if (normalized === "object" && strict) {
    property.additionalProperties = false;
  }
  if ("description" in value && typeof value.description === "string") {
    property.description = value.description;
  }
  if ("default" in value) {
    property.default = value.default;
  }

  const hasDefault = "default" in value;
  const explicitRequired = value.required;
  let isRequired: boolean;
  if (explicitRequired !== undefined) {
    isRequired = !!explicitRequired;
  } else if (hasDefault) {
    isRequired = false;
  } else {
    isRequired = !keyOptional;
  }

  return { property, isRequired, errors: [] };
}

function validateObjectFormKeys(name: string, value: Record<string, unknown>, path: string): SchemaDslError[] {
  const errors: SchemaDslError[] = [];
  for (const key of Object.keys(value)) {
    if (OBJECT_FORM_KEYS.has(key)) {
      continue;
    }
    const suffix = UNSUPPORTED_SCHEMA_KEY_HINTS.has(key)
      ? " Use the Acpus recursive DSL instead of raw schema keys."
      : "";
    errors.push({
      field: `${path}.${key}`,
      message: `Unsupported object-form key '${key}' for field '${name}'. Allowed keys: ${[...OBJECT_FORM_KEYS].join(", ")}.${suffix}`,
    });
  }
  return errors;
}

function invalidType(name: string, rawType: string, path: string): ParsedField {
  return {
    property: {},
    isRequired: false,
    errors: [{ field: path, message: `Invalid type '${rawType}' for field '${name}'. Valid types: ${[...VALID_TYPES].join(", ")}.` }],
  };
}
