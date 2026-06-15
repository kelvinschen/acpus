import type { AgentToolCallTelemetry, NodeExecutionState, RunState, RunSupervisorClient } from "@acpus/runtime";
import { stringify as stringifyYaml } from "yaml";

type ArtifactPathResolver = Pick<RunSupervisorClient, "getArtifactPath">;

// --- Compact kind display names ---
const COMPACT_KIND: Record<string, string> = {
  "run.agent": "agent",
  "run.program": "program",
  pipeline: "pipeline",
  parallel: "parallel",
  fanout: "fanout",
  switch: "switch",
  loop: "loop",
  guard: "guard",
  approval: "approval",
  subworkflow: "subworkflow",
};

// --- Container nodes: completed state is derivable from children ---
// Guard nodes are NOT included — they represent terminal decision points (pass/fail/skip)
// that are useful to see regardless of state.
const CONTAINER_KINDS = new Set<string>([
  "pipeline",
  "parallel",
  "fanout",
  "switch",
  "loop",
  "subworkflow",
]);

function isContainerKind(kind: string): boolean {
  return CONTAINER_KINDS.has(kind);
}

// --- State glyphs ---
const STATE_GLYPH: Record<string, string> = {
  pending: "○",
  running: "⠋",
  awaiting: "⏳",
  completed: "✓",
  failed: "◆",
  paused: "⏸",
  cancelled: "✗",
};

function formatGlyph(state: string): string {
  return STATE_GLYPH[state] ?? "·";
}

// --- Duration formatting ---
function formatDuration(isoStart?: string, isoEnd?: string, state?: string, nowMs?: number): string | undefined {
  if (!isoStart) return undefined;
  const startMs = Date.parse(isoStart);
  if (!Number.isFinite(startMs)) return undefined;
  // For terminal nodes without completedAt, don't inflate duration with Date.now()
  if (!isoEnd && state !== "running" && state !== "awaiting" && state !== "paused") return undefined;
  const endMs = isoEnd ? Date.parse(isoEnd) : (nowMs ?? Date.now());
  if (!Number.isFinite(endMs)) return undefined;
  const deltaMs = Math.max(0, endMs - startMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h${remainMin}m` : `${hours}h`;
}

function formatRunDuration(run: RunState): string {
  // Try to derive from first node's startedAt → last completed node's completedAt
  const nodes = run.nodes ?? [];
  const started = nodes.map(n => n.startedAt).filter((s): s is string => !!s).map(Date.parse).filter(Number.isFinite);
  const ended = nodes.map(n => n.completedAt).filter((s): s is string => !!s).map(Date.parse).filter(Number.isFinite);

  if (started.length === 0) return "<1s";

  const earliest = Math.min(...started);
  const latest = ended.length > 0 ? Math.max(...ended) : Date.parse(run.updatedAt);

  if (!Number.isFinite(latest)) return "<1s";
  const deltaMs = Math.max(0, latest - earliest);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// --- Collect child error messages for dedup ---
// Scope to children of a specific container (prefix match) to avoid
// cross-subtree false positives where unrelated subtrees share the same error.
function collectChildErrors(nodes: NodeExecutionState[], containerPrefix: string): Set<string> {
  const childErrors = new Set<string>();
  const prefix = containerPrefix + "/";
  for (const node of nodes) {
    if (node.nodeKey.startsWith(prefix) && !isContainerKind(node.kind) && node.error) {
      childErrors.add(node.error);
    }
  }
  return childErrors;
}

export async function formatRunShow(
  run: RunState,
  client?: ArtifactPathResolver,
  nowMs = Date.now()
): Promise<string> {
  const lines: string[] = [];

  // --- Compact header ---
  const duration = formatRunDuration(run);
  let header = `Run ${run.runId}  ${run.workflowName}  ${run.status}  ${duration}`;
  if (run.lineage) {
    header += `  forked from ${run.lineage.sourceRunId} (origin=${run.lineage.forkOriginNodeKey}, inherited=${run.lineage.inheritedNodeCount})`;
  }
  lines.push(header);
  if (run.error) {
    lines.push(`  Error: ${run.error}`);
  }

  // --- Nodes ---
  const nodes = run.nodes ?? [];

  for (const node of nodes) {
    if (isContainerKind(node.kind)) {
      // Show container if any of these apply:
      // 1. Has a unique error not duplicated in children
      // 2. Is in a non-completed, non-failed state (pending, running, awaiting, paused) — conveys meaningful status
      // Skip if: completed (derivable), or failed with a bubbled error (shown at child)
      const childErrors = collectChildErrors(nodes, node.nodeKey);
      const hasUniqueError = node.error && !childErrors.has(node.error);
      const isActionableState = node.state !== "completed" && node.state !== "failed";
      if (!hasUniqueError && !isActionableState) continue;
      // Fall through
    }

    const glyph = formatGlyph(node.state);
    const kind = COMPACT_KIND[node.kind] ?? node.kind;

    // Build node line
    const parts: string[] = [node.nodeKey, `[${kind}]`];

    // State text: only show non-completed (completed is implied by ✓ glyph)
    if (node.state !== "completed") {
      parts.push(node.state);
    }

    // Duration
    const dur = formatDuration(node.startedAt, node.completedAt, node.state, nowMs);
    if (dur) parts.push(dur);

    // Attempt: only show if > 1
    if (node.attempt > 1) {
      parts.push(`attempt=${node.attempt}`);
    }

    lines.push(`  ${glyph} ${parts.join("  ")}`);

    // Error: leaf nodes always show; container nodes already filtered by dedup above
    if (node.error) {
      lines.push(`    Error: ${node.error}`);
    }

    // Artifacts: count only, shown only for failed nodes
    if (node.artifactRefs?.length && node.state === "failed") {
      lines.push(`    Artifacts: ${node.artifactRefs.length} files`);
    }

    // Activity for running agents
    const activity = await summarizeRunningAgentActivity(run.runId, node, client, nowMs);
    if (activity) lines.push(`    Activity: ${activity}`);
  }

  // --- Workflow output ---
  const outputSection = formatWorkflowOutput(run.output);
  if (outputSection) {
    lines.push("");
    lines.push(outputSection);
  }

  return lines.join("\n");
}

async function summarizeRunningAgentActivity(
  runId: string,
  node: NodeExecutionState,
  client: ArtifactPathResolver | undefined,
  nowMs: number
): Promise<string | undefined> {
  void runId;
  void client;
  if (node.kind !== "run.agent" || node.state !== "running") return undefined;
  const telemetry = node.agentTelemetry;
  const attempt = telemetry?.attempts.find((item) => item.attempt === telemetry.currentAttempt)
    ?? telemetry?.attempts[telemetry.attempts.length - 1];
  if (!attempt) return undefined;

  const parts = [`updated=${formatAge(nowMs - Date.parse(attempt.updatedAt))} ago`, `tool_calls=${attempt.tools.totalToolCallCount}`];
  const recent = attempt.tools.recentCalls.slice(0, 3).map(formatToolName).filter(Boolean);
  if (recent.length > 0) parts.push(`recent=${recent.join(", ")}`);
  if (attempt.tools.droppedToolCallCount > 0) parts.push(`dropped=${attempt.tools.droppedToolCallCount}`);
  if (attempt.context) {
    const ctxDisplay = formatContextUsage(attempt.context.used, attempt.context.size);
    if (ctxDisplay) parts.push(`context=${ctxDisplay}`);
  }
  return parts.join("; ");
}

function formatContextUsage(used: number, size: number): string | undefined {
  // used=0 with tool calls means the measurement was lost (agent failed before
  // API reported token usage). Suppress rather than show misleading "0/200k".
  if (used === 0) return undefined;
  return `${formatContextNumber(used)}/${formatContextNumber(size)}`;
}

function formatContextNumber(value: number): string {
  return value < 1000 ? String(value) : `${Math.floor(value / 1000)}k`;
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

const MAX_OUTPUT_LINES = 25;

function formatWorkflowOutput(output: Record<string, unknown> | undefined): string | null {
  if (!output) return null;
  const yaml = stringifyYaml(output).trimEnd();
  if (yaml === "{}") return null;
  const lines = yaml.split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) {
    return ["Output:", ...lines.map(l => "  " + l)].join("\n");
  }
  // Truncate at a top-level key boundary (line without leading whitespace)
  let cutIndex = MAX_OUTPUT_LINES;
  while (cutIndex > 0 && lines[cutIndex - 1]?.match(/^\s/)) {
    cutIndex--;
  }
  const remaining = lines.length - cutIndex;
  const truncated = lines.slice(0, cutIndex).map(l => "  " + l);
  truncated.push(`  ... (${remaining} more lines)`);
  return ["Output:", ...truncated].join("\n");
}
