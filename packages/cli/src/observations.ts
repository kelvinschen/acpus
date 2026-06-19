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
import { summarizeAgentActivity } from "./agent-activity.js";

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
