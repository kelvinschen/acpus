/**
 * Shared schema helpers used by the recursive schema DSL compiler (dsl.ts).
 */

/** JSON Schema primitive types allowed in Acpus schema DSL shorthand. */
export const VALID_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
]);

/** Alias map: common short forms → canonical JSON Schema type names. */
export const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  str: "string",
  bool: "boolean",
  num: "number",
};

/** Normalize a type string to its canonical JSON Schema form. */
export function normalizeType(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  return TYPE_ALIASES[lower] ?? (VALID_TYPES.has(lower) ? lower : undefined);
}

/** Parse `field?` into `{ name: "field", optional: true }`. */
export function parseKey(rawKey: string): { name: string; optional: boolean } {
  if (rawKey.endsWith("?")) {
    return { name: rawKey.slice(0, -1), optional: true };
  }
  return { name: rawKey, optional: false };
}

/**
 * Parse a default value string into its JS representation.
 *
 * Handles: integers, floats, booleans, null, quoted strings, and
 * falls through to raw string for anything else.
 */
export function parseDefaultValue(raw: string): unknown {
  if (/^-?\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    return parseFloat(raw);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Type guard for plain record objects (not null, not array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
