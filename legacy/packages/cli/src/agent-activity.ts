import type { AgentTelemetry, AgentTokenUsage, AgentToolCallTelemetry } from "@acpus/runtime";

export function summarizeAgentActivity(agentTelemetry: AgentTelemetry | undefined, nowMs: number): string | undefined {
  const attempt = agentTelemetry?.attempts.find((item) => item.attempt === agentTelemetry.currentAttempt)
    ?? agentTelemetry?.attempts[agentTelemetry.attempts.length - 1];
  if (!attempt) return undefined;

  const parts = [`updated=${formatAge(nowMs - Date.parse(attempt.updatedAt))} ago`, `tool_calls=${attempt.tools.totalToolCallCount}`];
  const recent = attempt.tools.recentCalls.slice(0, 3).map(formatToolName).filter(Boolean);
  if (recent.length > 0) parts.push(`recent=${recent.join(", ")}`);
  if (attempt.tools.droppedToolCallCount > 0) parts.push(`dropped=${attempt.tools.droppedToolCallCount}`);
  if (attempt.context) {
    const ctxDisplay = formatContextUsage(attempt.context.used, attempt.context.size);
    if (ctxDisplay) parts.push(`context=${ctxDisplay}`);
  }
  const tokenDisplay = formatTokenUsage(attempt.tokenUsage);
  if (tokenDisplay) parts.push(`tokens=${tokenDisplay}`);
  return parts.join("; ");
}

function formatContextUsage(used: number, size: number): string | undefined {
  if (used === 0) return undefined;
  return `${formatContextNumber(used)}/${formatContextNumber(size)}`;
}

function formatContextNumber(value: number): string {
  return value < 1000 ? String(value) : `${Math.floor(value / 1000)}k`;
}

function formatTokenUsage(usage: AgentTokenUsage | undefined): string | undefined {
  return usage?.totalTokens !== undefined ? formatContextNumber(usage.totalTokens) : undefined;
}

function formatToolName(tool: AgentToolCallTelemetry): string {
  const raw = tool.title ?? tool.toolName ?? tool.kind ?? tool.toolCallId;
  return raw.replace(/\s+/g, " ").trim();
}

function formatAge(deltaMs: number): string {
  const safeMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
