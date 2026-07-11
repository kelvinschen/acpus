import type { RunNodeProgress } from "@acpus/runtime";

export function formatAgentProgressLines(progress: RunNodeProgress): string[] {
  const lines = [`Agent progress: ${progress.nodeKey} ${progress.status}${progress.message ? ` (${progress.message})` : ""}`];
  lines.push(...formatAgentProgressDetailLines(progress).map(line => `  ${line}`));
  return lines;
}

function formatAgentProgressDetailLines(progress: RunNodeProgress, options: { includeMessage?: boolean; nowMs?: number } = {}): string[] {
  const lines: string[] = [];
  const lastActive = formatLastActive(progress.updatedAt, options.nowMs);
  if (lastActive) lines.push(`Last active: ${lastActive}`);
  if (options.includeMessage && progress.message) lines.push(`Progress: ${progress.message}`);
  const context = progress.context ? formatContext(progress.context) : undefined;
  const tokenUsage = progress.tokenUsage ? formatTokenUsage(progress.tokenUsage) : undefined;
  const tools = progress.tools ? formatTools(progress.tools) : undefined;
  if (context) lines.push(`Context: ${context}`);
  if (tokenUsage) lines.push(`Tokens: ${tokenUsage}`);
  if (tools) lines.push(`Tools: ${tools}`);
  return lines;
}

function formatContext(value: unknown): string | undefined {
  const record = objectRecord(value);
  const used = numberValue(record?.used);
  const size = numberValue(record?.size);
  if (used !== undefined && size !== undefined) return `${compactNumber(used)}/${compactNumber(size)}`;
  if (used !== undefined) return compactNumber(used);
  if (size !== undefined) return `size ${compactNumber(size)}`;
  return undefined;
}

function formatTokenUsage(value: unknown): string | undefined {
  const record = objectRecord(value);
  const input = numberValue(record?.inputTokens);
  const output = numberValue(record?.outputTokens);
  const total = numberValue(record?.totalTokens);
  const parts = [
    input === undefined ? undefined : `in ${compactNumber(input)}`,
    output === undefined ? undefined : `out ${compactNumber(output)}`,
    total === undefined ? undefined : `total ${compactNumber(total)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatTools(value: unknown): string | undefined {
  const record = objectRecord(value);
  const total = numberValue(record?.totalToolCallCount);
  const calls = Array.isArray(record?.lastCalls)
    ? record.lastCalls.slice(-3).flatMap(call => {
      const item = objectRecord(call);
      if (!item) return [];
      return truncateCommand(toolCommand(item));
    })
    : [];
  if (total === undefined) return calls.length > 0 ? `last ${calls.join(", ")}` : undefined;
  return calls.length > 0 ? `${compactNumber(total)} total; last ${calls.join(", ")}` : `${compactNumber(total)} total`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactNumber(value: number): string {
  if (Math.abs(value) < 1_000) return String(value);
  return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

function formatLastActive(value: string, nowMs = Date.now()): string | undefined {
  const activeMs = Date.parse(value);
  if (!Number.isFinite(activeMs)) return undefined;
  const ageMs = Math.max(0, nowMs - activeMs);
  if (ageMs < 1_000) return "<1s ago";
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toolCommand(call: Record<string, unknown>): string {
  return stringValue(call.title) ?? stringValue(call.toolName) ?? "tool";
}

function truncateCommand(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= 50 ? text : `${text.slice(0, 47)}...`;
}
