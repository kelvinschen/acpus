/**
 * Input schema compiler.
 *
 * Top-level `input` uses a concise flat-map style compiled to JSON Schema.
 * The public API exports from schema/index.ts instead.
 */

import {
  isRecord,
  normalizeType,
  parseDefaultValue,
  parseKey,
  VALID_TYPES,
} from "./helpers.js";

/**
 * Returns true when `obj` looks like a schema DSL map definition
 * (no `schema` key → not a JSON Schema escape hatch).
 */
export function isFlatMap(obj: Record<string, unknown>): boolean {
  return !("schema" in obj);
}

/**
 * Compile a flat-map input definition into a JSON Schema object.
 *
 * Accepts both shorthand (`field: string`) and object form
 * (`field: { type: string, required: true }`).
 */
export function compileInputSchema(
  input: Record<string, unknown>
): { schema: Record<string, unknown>; errors: InputFieldError[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const errors: InputFieldError[] = [];

  for (const [rawKey, value] of Object.entries(input)) {
    const { name, optional } = parseKey(rawKey);
    const result = parseFieldValue(name, value, optional, "input");

    if (result.error) {
      errors.push(result.error);
      continue;
    }

    properties[name] = result.property;
    if (result.isRequired) {
      required.push(name);
    }
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required.length > 0) {
    schema.required = required;
  }

  return { schema, errors };
}

export interface InputFieldError {
  field: string;
  message: string;
}

interface ParsedField {
  property: Record<string, unknown>;
  isRequired: boolean;
  error?: InputFieldError;
}

/**
 * Parse one field value in a flat-map input definition.
 *
 * Value forms:
 *   - string shorthand:  `"string"` | `"integer"` | ...
 *   - string w/ default: `"integer = 2"`  (whitespace around `=` optional)
 *   - object form:       `{ type: "string", required?: boolean, default?: any, description?: string }`
 */
function parseFieldValue(
  name: string,
  value: unknown,
  keyOptional: boolean,
  context: "input"
): ParsedField {
  if (typeof value === "string") {
    return parseStringShorthand(name, value, keyOptional);
  }

  if (isRecord(value)) {
    return parseObjectForm(name, value, keyOptional);
  }

  return {
    property: {},
    isRequired: false,
    error: { field: name, message: `${context} field '${name}' must be a type string or an object.` },
  };
}

function parseStringShorthand(
  name: string,
  value: string,
  keyOptional: boolean
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
    return {
      property: {},
      isRequired: false,
      error: { field: name, message: `Invalid type '${typePart}' for field '${name}'. Valid types: ${[...VALID_TYPES].join(", ")}.` },
    };
  }

  const property: Record<string, unknown> = { type: normalized };
  if (hasDefault) {
    property.default = defaultValue;
  }

  return { property, isRequired: !keyOptional && !hasDefault };
}

function parseObjectForm(
  name: string,
  value: Record<string, unknown>,
  keyOptional: boolean
): ParsedField {
  const rawType = value.type;
  if (typeof rawType !== "string") {
    return {
      property: {},
      isRequired: false,
      error: { field: name, message: `Object form for field '${name}' must include a string 'type'.` },
    };
  }

  const normalized = normalizeType(rawType);
  if (!normalized) {
    return {
      property: {},
      isRequired: false,
      error: { field: name, message: `Invalid type '${rawType}' for field '${name}'. Valid types: ${[...VALID_TYPES].join(", ")}.` },
    };
  }

  const property: Record<string, unknown> = { type: normalized };

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

  return { property, isRequired };
}
