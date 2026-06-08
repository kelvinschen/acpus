/**
 * Observation formatting for the follow loop.
 *
 * Two modes:
 * - Human-readable: compact glyph format with node key, state, duration
 * - JSON: newline-delimited JSON (JSONL) observations
 */

import type { NodeState, RunStatus } from "@acpus/runtime";

export interface ObservationEvent {
  type: "run" | "node" | "summary";
  runId?: string;
  status?: RunStatus;
  nodeKey?: string;
  state?: NodeState;
  duration?: number;
  error?: string;
}

const STATE_GLYPHS: Record<NodeState, string> = {
  pending: "○",
  running: "⠋",
  awaiting: "⏳",
  completed: "✓",
  failed: "◆",
  paused: "⏸",
  cancelled: "✗"
};

/**
 * Format an observation event for output.
 */
export function formatObservation(event: ObservationEvent, runName?: string, json = false): string {
  if (json) return JSON.stringify(event);

  switch (event.type) {
    case "run":
      return formatRunObservation(event.runId!, event.status!, runName);
    case "node":
      return formatNodeObservation(event.nodeKey!, event.state!, event.duration, event.error);
    case "summary":
      return formatSummaryObservation(event.runId!, event.status!, runName);
    default:
      return JSON.stringify(event);
  }
}

/**
 * Format a terminal summary line.
 */
export function formatTerminalSummary(runId: string, status: RunStatus, runName?: string, json = false): string {
  if (json) {
    return JSON.stringify({ type: "summary", runId, status });
  }
  return formatSummaryObservation(runId, status, runName);
}

function formatRunObservation(runId: string, status: RunStatus, runName?: string): string {
  const name = runName ? ` ${runName}` : "";
  const glyph = status === "running" ? "▶" : "■";
  return `${glyph} Run ${runId}${name} ${status}`;
}

function formatNodeObservation(nodeKey: string, state: NodeState, duration?: number, error?: string): string {
  const glyph = STATE_GLYPHS[state] ?? "?";
  const dur = duration !== undefined ? `  (${(duration / 1000).toFixed(1)}s)` : "";
  const err = error ? `  ${error}` : "";
  const suffix = state === "running" ? "..." : "";
  return `  ${glyph} ${nodeKey}  ${state}${suffix}${dur}${err}`;
}

function formatSummaryObservation(runId: string, status: RunStatus, runName?: string): string {
  const name = runName ? ` ${runName}` : "";
  const glyph = STATE_GLYPHS[status as NodeState] ?? "■";
  return `${glyph} Run ${runId}${name} ${status}`;
}
