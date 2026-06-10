import React from "react";
import { Text } from "ink";
import { acpusInkUiTheme, wrapText, type InkUiTheme } from "./theme.js";

export interface JsonRowDescriptor {
  id: string;
  text: string;
  color: string;
  branch: boolean;
}

export function JSONViewer({
  data,
  width,
  rootLabel = "output",
  initialDepth = 2,
  expandedIds,
  selectedIndex,
  theme = acpusInkUiTheme
}: {
  data: unknown;
  width: number;
  rootLabel?: string;
  initialDepth?: number;
  expandedIds?: ReadonlySet<string>;
  selectedIndex?: number;
  theme?: InkUiTheme;
}): React.ReactElement {
  return <>{jsonViewerRows(data, width, { rootLabel, initialDepth, expandedIds, selectedIndex, theme })}</>;
}

export function jsonViewerRows(
  data: unknown,
  width: number,
  {
    rootLabel = "output",
    initialDepth = 2,
    expandedIds,
    selectedIndex,
    theme = acpusInkUiTheme
  }: {
    rootLabel?: string;
    initialDepth?: number;
    expandedIds?: ReadonlySet<string>;
    selectedIndex?: number;
    theme?: InkUiTheme;
  } = {}
): React.ReactElement[] {
  return jsonRowDescriptors(data, { rootLabel, initialDepth, expandedIds, theme })
    .flatMap((row, rowIndex) =>
      wrapText(row.text, width).map((chunk, index) => (
        <Text key={`${row.id}:${index}`} color={row.color} inverse={selectedIndex === rowIndex}>
          {index === 0 ? chunk : `  ${chunk}`}
        </Text>
      ))
    );
}

export function jsonPlainText(data: unknown, rootLabel = "output", initialDepth = Number.POSITIVE_INFINITY): string {
  return jsonRowDescriptors(data, { rootLabel, initialDepth }).map((row) => row.text).join("\n");
}

export function jsonRowDescriptors(
  data: unknown,
  {
    rootLabel = "output",
    initialDepth = 2,
    expandedIds,
    theme = acpusInkUiTheme
  }: {
    rootLabel?: string;
    initialDepth?: number;
    expandedIds?: ReadonlySet<string>;
    theme?: InkUiTheme;
  } = {}
): JsonRowDescriptor[] {
  const rows: JsonRowDescriptor[] = [];
  const visited = new WeakSet<object>();
  visit(data, rootLabel, 0, "root", []);
  return rows;

  function visit(value: unknown, key: string, depth: number, path: string, prefixes: string[]): void {
    const prefix = prefixes.join("");
    const type = jsonType(value);
    const branch = type === "object" || type === "array";
    if (branch && value !== null && typeof value === "object") {
      if (visited.has(value)) {
        rows.push({
          id: path,
          text: `${prefix}  ${key}: [circular]`,
          color: theme.colors.warning,
          branch: false
        });
        return;
      }
      visited.add(value);
    }
    const expanded = branch && (expandedIds ? expandedIds.has(path) : depth < initialDepth);
    const summary = formatSummary(value, type);
    rows.push({
      id: path,
      text: `${prefix}${expanded ? "▾" : branch ? "▸" : " "} ${key}${summary}`,
      color: branch ? theme.colors.primary : colorFor(type, theme),
      branch
    });
    if (!expanded) return;

    const entries = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    entries.forEach(([childKey, childValue], index) => {
      const last = index === entries.length - 1;
      visit(childValue, childKey, depth + 1, `${path}.${childKey}`, [...prefixes, last ? "  " : "│ "]);
    });
  }
}

export function jsonExpandedIdsForInitialDepth(
  data: unknown,
  {
    rootLabel = "output",
    initialDepth = 2
  }: {
    rootLabel?: string;
    initialDepth?: number;
  } = {}
): Set<string> {
  const expanded = new Set<string>();
  const visited = new WeakSet<object>();
  visit(data, rootLabel, 0, "root");
  return expanded;

  function visit(value: unknown, _key: string, depth: number, path: string): void {
    const type = jsonType(value);
    const branch = type === "object" || type === "array";
    if (!branch || depth >= initialDepth) return;
    if (value !== null && typeof value === "object") {
      if (visited.has(value)) return;
      visited.add(value);
    }
    expanded.add(path);
    const entries = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const [childKey, childValue] of entries) {
      visit(childValue, childKey, depth + 1, `${path}.${childKey}`);
    }
  }
}

export function toggleJsonExpandedId(expandedIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expandedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function jsonType(value: unknown): "object" | "array" | "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function formatSummary(value: unknown, type: ReturnType<typeof jsonType>): string {
  if (type === "array") return ` [${(value as unknown[]).length}]`;
  if (type === "object") return ` {${Object.keys(value as Record<string, unknown>).length}}`;
  if (type === "string") return `: ${JSON.stringify(value)}`;
  if (type === "null") return ": null";
  return `: ${String(value)}`;
}

function colorFor(type: ReturnType<typeof jsonType>, theme: InkUiTheme): string {
  if (type === "string") return theme.colors.success;
  if (type === "number") return theme.colors.warning;
  if (type === "boolean") return theme.colors.info;
  if (type === "null") return theme.colors.muted;
  return theme.colors.text;
}
