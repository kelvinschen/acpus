/**
 * Observation formatting for the follow loop.
 *
 * Two modes:
 * - Human-readable: compact glyph format aligned with `runs show`
 * - JSON: newline-delimited JSON (JSONL) observations
 */

import type { AgentTelemetry, NodeState, RunStatus } from "@acpus/runtime";
import {
  formatNodeLines,
  formatDurationFromMs,
  formatWorkflowOutput,
  STATE_GLYPH
} from "./runs-show.js";

// --- Agent telemetry summary (sync, for follow loop) ---
import type { AgentTokenUsage, AgentToolCallTelemetry } from "@acpus/runtime";

function summarizeAgentActivity(agentTelemetry: AgentTelemetry, nowMs: number): string | undefined {
  const attempt = agentTelemetry.attempts.find((a) => a.attempt === agentTelemetry.currentAttempt)
    ?? agentTelemetry.attempts[agentTelemetry.attempts.length - 1];
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

// --- ObservationEvent type ---

export interface ObservationEvent {
  type: "run" | "node" | "summary";
  // Run-level fields
  runId?: string;
  status?: RunStatus;
  workflowName?: string;
  workflowRef?: string;
  createdAt?: string;
  // Node-level fields
  nodeKey?: string;
  state?: NodeState;
  kind?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  output?: Record<string, unknown>;
  agentTelemetry?: AgentTelemetry;
  artifactRefs?: string[];
  attempt?: number;
  // Summary-level fields
  runDuration?: number;
}

/**
 * Format an observation event for output.
 */
export function formatObservation(event: ObservationEvent, runName?: string, json = false): string {
  if (json) return JSON.stringify(event);

  switch (event.type) {
    case "run":
      return formatRunObservation(event.runId!, event.status!, runName);
    case "node":
      return formatNodeObservationHuman(event);
    case "summary":
      return formatSummaryObservation(event, runName);
    default:
      return JSON.stringify(event);
  }
}

/**
 * Format a terminal summary line.
 */
export function formatTerminalSummary(
  runId: string,
  status: RunStatus,
  runName?: string,
  json = false,
  options?: { runDuration?: number; output?: Record<string, unknown> }
): string {
  if (json) {
    const event: ObservationEvent = { type: "summary", runId, status };
    if (options?.runDuration !== undefined) event.runDuration = options.runDuration;
    if (options?.output) event.output = options.output;
    return JSON.stringify(event);
  }
  return formatSummaryObservation(
    { type: "summary", runId, status, runDuration: options?.runDuration, output: options?.output },
    runName
  );
}

function formatRunObservation(runId: string, status: RunStatus, runName?: string): string {
  const name = runName ? ` ${runName}` : "";
  const glyph = status === "running" ? "▶" : "■";
  return `${glyph} Run ${runId}${name} ${status}`;
}

/**
 * Human-readable node observation, aligned with `runs show` format.
 * Outputs the primary node line plus optional detail lines (error, artifacts, activity).
 */
function formatNodeObservationHuman(event: ObservationEvent): string {
  const nodeKey = event.nodeKey!;
  const state = event.state!;
  const kind = event.kind ?? "";
  const nowMs = Date.now();

  const activity = (kind === "run.agent" && state === "running" && event.agentTelemetry)
    ? summarizeAgentActivity(event.agentTelemetry, nowMs)
    : undefined;

  const lines = formatNodeLines(
    {
      nodeKey,
      kind,
      state,
      startedAt: event.startedAt,
      completedAt: event.completedAt,
      error: event.error,
      attempt: event.attempt,
      artifactRefs: event.artifactRefs,
    },
    nowMs,
    activity
  );

  return lines.join("\n");
}

function formatSummaryObservation(event: ObservationEvent, runName?: string): string {
  const runId = event.runId!;
  const status = event.status!;
  const name = runName ? ` ${runName}` : "";
  const glyph = STATE_GLYPH[status] ?? "■";

  // Use runs-show header format: Run {id}  {name}  {status}  {duration}
  const durationStr = event.runDuration !== undefined ? formatDurationFromMs(event.runDuration) : undefined;
  const durationPart = durationStr ? `  ${durationStr}` : "";

  const header = `${glyph} Run ${runId}${name} ${status}${durationPart}`;

  // Append workflow output section for completed runs, same format as runs show.
  const outputSection = formatWorkflowOutput(event.output);
  return outputSection ? `${header}\n\n${outputSection}` : header;
}

