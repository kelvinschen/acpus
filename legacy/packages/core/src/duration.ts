export interface ParseDurationOptions {
  /** If true, throws on invalid/unparseable input. Default: false (returns 0). */
  strict?: boolean;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000
};

/**
 * Parse a duration string (e.g. "30s", "5m", "1h", "500ms") into milliseconds.
 * Returns 0 for undefined input. By default returns 0 for invalid input;
 * set `{ strict: true }` to throw instead.
 *
 * Only supports ms/s/m/h units.
 */
export function parseDurationMs(value: string | undefined, options?: ParseDurationOptions): number {
  if (value === undefined) return 0;
  const trimmed = value.trim();
  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    if (options?.strict) throw new Error(`Invalid duration '${value}'. Use ms, s, m, or h.`);
    return 0;
  }
  const result = Number(match[1]) * UNIT_MS[match[2] ?? "ms"];
  if (!Number.isSafeInteger(result)) {
    if (options?.strict) throw new Error(`Invalid duration '${value}'. Use ms, s, m, or h.`);
    return 0;
  }
  return result;
}
