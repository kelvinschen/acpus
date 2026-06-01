import type { z } from "zod";
import type { TransformSchema } from "../schema/workflow-spec.js";

export type Transform = z.infer<typeof TransformSchema>;

export function applyTransforms(value: unknown, transforms: Transform[] = []): unknown {
  let current = value;
  for (const transform of transforms) {
    current = applyTransform(current, transform);
  }
  return current;
}

function applyTransform(value: unknown, transform: Transform): unknown {
  const args = transform.args ?? {};
  switch (transform.fn) {
    case "compact":
      return compact(value, numberArg(args.maxChars, 2000));
    case "tail":
      return tail(value, numberArg(args.maxLines, 80));
    case "json":
      return JSON.stringify(value, null, args.pretty === false ? 0 : 2);
    case "quoteBlock":
      return `\`\`\`\n${String(value ?? "")}\n\`\`\``;
    case "pathList":
      return pathList(value).join("\n");
    case "filterSeverity":
      return filterSeverity(value, stringArrayArg(args.levels));
    case "severitySummary":
      return severitySummary(value);
    case "join":
      return Array.isArray(value) ? value.join(String(args.separator ?? "\n")) : String(value ?? "");
    case "default":
      return value == null || value === "" ? args.value : value;
  }
}

function compact(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n... [truncated]`;
}

function tail(value: unknown, maxLines: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lines = text.split("\n");
  return lines.slice(-maxLines).join("\n");
}

function pathList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.path === "string") return [record.path];
      if (typeof record.file === "string") return [record.file];
    }
    return [];
  });
}

function filterSeverity(value: unknown, levels: string[]): unknown[] {
  const items = Array.isArray(value) ? value : [];
  return items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    return levels.includes(String((item as Record<string, unknown>).severity ?? ""));
  });
}

function severitySummary(value: unknown): Record<string, number> {
  const summary: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const severity = String((item as Record<string, unknown>).severity ?? "");
      if (severity in summary) summary[severity] += 1;
    }
    return summary;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(summary)) {
      const count = (value as Record<string, unknown>)[key];
      if (typeof count === "number") summary[key] = count;
    }
  }
  return summary;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
