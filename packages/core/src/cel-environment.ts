import { Environment } from "@marcbachmann/cel-js";

export function createAcpusCelEnvironment(options?: { unlistedVariablesAreDyn?: boolean; nowTimestamp?: string }): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: options?.unlistedVariablesAreDyn ?? false });
  for (const root of ["input", "steps", "workflow", "loop_ctx", "item", "item_id", "item_index", "run_id"]) {
    env.registerVariable(root, "dyn");
  }
  env.registerFunction("now(): string", () => options?.nowTimestamp ?? new Date().toISOString());
  env.registerFunction("len(string): int", (str: string) => BigInt(str.length));
  env.registerFunction("len(list): int", (arr: unknown[]) => BigInt(arr.length));
  env.registerFunction("startsWith(string, string): bool", (str: string, prefix: string) => str.startsWith(prefix));
  env.registerFunction("matches(string, string): bool", (str: string, pattern: string) => {
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false;
    }
  });
  env.registerFunction("coalesce(dyn, dyn): dyn", (a: unknown, b: unknown) => (a !== null && a !== undefined) ? a : b);
  env.registerFunction("coalesce(dyn, dyn, dyn): dyn", (a: unknown, b: unknown, c: unknown) => {
    if (a !== null && a !== undefined) return a;
    if (b !== null && b !== undefined) return b;
    return c;
  });
  env.registerFunction("json(dyn): string", (value: unknown) => JSON.stringify(normalizeForJson(value)));
  return env;
}

function normalizeForJson(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value instanceof Map) return normalizeForJson(Object.fromEntries(value));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalizeForJson((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}
