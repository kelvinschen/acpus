import ms from "ms";

export interface ParseDurationOptions {
  /** If true, throws on invalid/unparseable input. Default: false (returns 0). */
  strict?: boolean;
}

/**
 * Parse a duration string (e.g. "30s", "5m", "1h", "500ms") into milliseconds.
 * Returns 0 for undefined input. By default returns 0 for invalid input;
 * set `{ strict: true }` to throw instead.
 *
 * Only supports ms/s/m/h units (delegates arithmetic to the `ms` library
 * but rejects formats like "2 days" that `ms` would accept).
 */
export function parseDurationMs(value: string | undefined, options?: ParseDurationOptions): number {
  if (value === undefined) return 0;
  const trimmed = value.trim();
  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    if (options?.strict) throw new Error(`Invalid duration '${value}'. Use ms, s, m, or h.`);
    return 0;
  }
  const result = ms(trimmed as ms.StringValue);
  if (Number.isNaN(result)) {
    if (options?.strict) throw new Error(`Invalid duration '${value}'. Use ms, s, m, or h.`);
    return 0;
  }
  return result;
}
