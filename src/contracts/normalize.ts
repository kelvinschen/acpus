export type AliasNormalization = {
  path: string;
  from: string;
  to: string;
};

export function normalizeDeterministicAliases(value: unknown): {
  value: unknown;
  normalizations: AliasNormalization[];
} {
  const cloned = cloneJson(value);
  const normalizations: AliasNormalization[] = [];
  if (cloned && typeof cloned === "object" && Array.isArray((cloned as Record<string, unknown>).checks)) {
    const checks = (cloned as Record<string, unknown>).checks as unknown[];
    for (let index = 0; index < checks.length; index += 1) {
      const item = checks[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.status !== undefined) continue;
      if (!isAllowedCheckStatus(record.result)) continue;
      record.status = record.result;
      delete record.result;
      normalizations.push({
        path: `/checks/${index}`,
        from: "checks[].result",
        to: "checks[].status"
      });
    }
  }
  return { value: cloned, normalizations };
}

function isAllowedCheckStatus(value: unknown): value is "pass" | "fail" | "skipped" | "unknown" {
  return value === "pass" || value === "fail" || value === "skipped" || value === "unknown";
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
