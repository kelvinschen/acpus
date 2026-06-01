import type { Variable } from "../schema/workflow-spec.js";

export const PLACEHOLDER_PATTERN = /(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function extractPlaceholders(prompt: string): string[] {
  const names = new Set<string>();
  for (const match of prompt.matchAll(PLACEHOLDER_PATTERN)) {
    names.add(match[1]);
  }
  return Array.from(names);
}

export function findVariableIssues(prompt: string, variables: Variable[]): {
  missing: string[];
  unused: string[];
  duplicates: string[];
} {
  const declared = new Map<string, number>();
  for (const variable of variables) {
    declared.set(variable.name, (declared.get(variable.name) ?? 0) + 1);
  }
  const used = new Set(extractPlaceholders(prompt));
  return {
    missing: Array.from(used).filter((name) => !declared.has(name)),
    unused: Array.from(declared.keys()).filter((name) => !used.has(name)),
    duplicates: Array.from(declared.entries()).filter(([, count]) => count > 1).map(([name]) => name)
  };
}

export function renderPrompt(prompt: string, values: Record<string, unknown>): string {
  return prompt
    .replace(PLACEHOLDER_PATTERN, (_, name: string) => stringifyPromptValue(values[name]))
    .replace(/\\\$\{/g, "${");
}

function stringifyPromptValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
