import type { AcpusIr, IrNode } from "@acpus/core";
import type { NodeExecutionState, RunState, RunSupervisorClient } from "@acpus/runtime";
import { staticNodePathFromKey } from "@acpus/runtime";
import { stringify as stringifyYaml } from "yaml";
import { summarizeAgentActivity } from "./agent-activity.js";

type ArtifactPathResolver = Pick<RunSupervisorClient, "getArtifactPath">;

// --- Compact kind display names ---
export const COMPACT_KIND: Record<string, string> = {
  "run.agent": "agent",
  "run.program": "program",
  pipeline: "pipeline",
  parallel: "parallel",
  fanout: "fanout",
  if: "if",
  switch: "switch",
  loop: "loop",
  guard: "guard",
  "run.signal": "signal",
  subworkflow: "subworkflow",
};

// --- Container nodes: completed state is derivable from children ---
// Guard nodes are NOT included — they represent terminal decision points (pass/fail/skip)
// that are useful to see regardless of state.
const CONTAINER_KINDS = new Set<string>([
  "pipeline",
  "parallel",
  "fanout",
  "if",
  "switch",
  "loop",
  "subworkflow",
]);

export function isContainerKind(kind: string): boolean {
  return CONTAINER_KINDS.has(kind);
}

// --- Awaiting Signal Node rendering ---
// Build a nodePath → IrNode lookup by walking the full IR tree once. Composite
// nodes expose children via `children` (pipeline/fanout/loop bodies)
// and `branches[].child` (parallel/switch branch pipelines); both must be walked so signal nodes
// nested inside any composite are indexed.
function indexIrNodesByPath(root: IrNode): Map<string, IrNode> {
  const byPath = new Map<string, IrNode>();
  const stack: IrNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    byPath.set(node.nodePath.join("/"), node);
    if (node.children) stack.push(...node.children);
    if (node.branches) {
      for (const branch of node.branches) {
        stack.push(branch.child);
      }
    }
  }
  return byPath;
}

// Render the prompt and expected payload schema for an awaiting Signal Node so
// the operator knows what to deliver via `acpus runs signal`. Indented two
// spaces to align with the node's detail lines.
function formatAwaitingSignal(node: NodeExecutionState, irNode: IrNode | undefined, runId: string): string[] {
  const lines: string[] = [];
  const prompt = node.renderedPrompt ?? (typeof irNode?.metadata.prompt === "string" ? irNode.metadata.prompt : undefined);
  if (prompt) {
    const promptLines = prompt.replace(/\s+$/, "").split("\n");
    lines.push("    Prompt:");
    for (const line of promptLines) lines.push(`      ${line}`);
  }

  const schema = irNode?.metadata.output;
  if (isRecord(schema)) {
    const fields = describeSchemaFields(schema);
    if (fields.length > 0) {
      lines.push("    Expected payload:");
      for (const field of fields) lines.push(`      ${field}`);
    } else {
      // A declared schema with no properties — never leave the operator without
      // payload guidance.
      lines.push("    Expected payload: {} (empty object; no properties declared)");
    }
  } else {
    lines.push("    Expected payload: any JSON object (no schema declared)");
  }

  lines.push(`    Deliver: acpus runs signal ${runId} --node ${node.nodeKey} --payload '{...}'`);
  return lines;
}

// Summarize a compiled JSON Schema's top-level properties as "name: type[, required]".
function describeSchemaFields(schema: Record<string, unknown>): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([name, def]) => {
    const type = isRecord(def) && typeof def.type === "string" ? def.type : "any";
    const req = required.has(name) ? " (required)" : " (optional)";
    return `${name}: ${type}${req}`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- State glyphs ---
export const STATE_GLYPH: Record<string, string> = {
  pending: "○",
  running: "⠋",
  awaiting: "⏳",
  completed: "✓",
  failed: "◆",
  paused: "⏸",
  cancelled: "✗",
};

export function formatGlyph(state: string): string {
  return STATE_GLYPH[state] ?? "·";
}

// --- Duration formatting ---

/**
 * Compute a Run's wall-clock duration in milliseconds.
 * Uses the earliest node startedAt → latest node completedAt (or updatedAt fallback).
 */
export function computeRunDurationMs(run: RunState): number {
  const nodes = run.nodes ?? [];
  const started = nodes.map(n => n.startedAt).filter((s): s is string => !!s).map(Date.parse).filter(Number.isFinite);
  const ended = nodes.map(n => n.completedAt).filter((s): s is string => !!s).map(Date.parse).filter(Number.isFinite);

  if (started.length === 0) return 0;

  const earliest = Math.min(...started);
  const latest = ended.length > 0 ? Math.max(...ended) : Date.parse(run.updatedAt);

  if (!Number.isFinite(latest)) return 0;
  return Math.max(0, latest - earliest);
}

/**
 * Format a duration in milliseconds to a compact string (e.g. "1m30s", "<1s", "2d").
 * Single source of truth for all duration display in the CLI.
 */
export function formatDurationFromMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatDuration(isoStart?: string, isoEnd?: string, state?: string, nowMs?: number): string | undefined {
  if (!isoStart) return undefined;
  const startMs = Date.parse(isoStart);
  if (!Number.isFinite(startMs)) return undefined;
  // For terminal nodes without completedAt, don't inflate duration with Date.now()
  if (!isoEnd && state !== "running" && state !== "awaiting" && state !== "paused") return undefined;
  const endMs = isoEnd ? Date.parse(isoEnd) : (nowMs ?? Date.now());
  if (!Number.isFinite(endMs)) return undefined;
  return formatDurationFromMs(Math.max(0, endMs - startMs));
}

export function formatRunDuration(run: RunState): string {
  const ms = computeRunDurationMs(run);
  return ms === 0 ? "<1s" : formatDurationFromMs(ms);
}

// --- Collect child error messages for dedup ---
// Scope to children of a specific container (prefix match) to avoid
// cross-subtree false positives where unrelated subtrees share the same error.
export function collectChildErrors(nodes: NodeExecutionState[], containerPrefix: string): Set<string> {
  const childErrors = new Set<string>();
  const prefix = containerPrefix + "/";
  for (const node of nodes) {
    if (node.nodeKey.startsWith(prefix) && !isContainerKind(node.kind) && node.error) {
      childErrors.add(node.error);
    }
  }
  return childErrors;
}

export function shouldShowNode(node: NodeExecutionState, allNodes: NodeExecutionState[]): boolean {
  if (!isContainerKind(node.kind)) return true;
  const childErrors = collectChildErrors(allNodes, node.nodeKey);
  const hasUniqueError = node.error && !childErrors.has(node.error);
  const isActionableState = node.state !== "completed" && node.state !== "failed";
  return Boolean(hasUniqueError || isActionableState);
}

/**
 * Format a single node line in the compact runs-show style.
 * Returns the primary line (e.g. "  ✓ workflow/review  [agent]  1m30s")
 * plus optional detail lines (error, artifacts, activity).
 */
export function formatNodeLines(
  node: {
    nodeKey: string;
    kind: string;
    state: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    attempt?: number;
    artifactRefs?: string[];
  },
  nowMs: number,
  activity?: string
): string[] {
  const lines: string[] = [];
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
  if ((node.attempt ?? 1) > 1) {
    parts.push(`attempt=${node.attempt}`);
  }

  lines.push(`  ${glyph} ${parts.join("  ")}`);

  // Error: indented detail line
  if (node.error) {
    lines.push(`    Error: ${node.error}`);
  }

  // Artifacts: count only, shown only for failed nodes
  if (node.artifactRefs?.length && node.state === "failed") {
    lines.push(`    Artifacts: ${node.artifactRefs.length} files`);
  }

  // Activity for running agents
  if (activity) {
    lines.push(`    Activity: ${activity}`);
  }

  return lines;
}

export async function formatRunShow(
  run: RunState,
  client?: ArtifactPathResolver,
  nowMs = Date.now(),
  ir?: AcpusIr
): Promise<string> {
  const lines: string[] = [];

  // Map IR nodePath → node so awaiting Signal Nodes can surface the prompt and
  // the expected payload schema the operator must satisfy.
  const irNodesByPath = ir ? indexIrNodesByPath(ir.root) : undefined;

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
    if (!shouldShowNode(node, nodes)) continue;

    const activity = node.kind === "run.agent" && node.state === "running"
      ? summarizeAgentActivity(node.agentTelemetry, nowMs)
      : undefined;
    const nodeLines = formatNodeLines(node, nowMs, activity);
    lines.push(...nodeLines);

    // Awaiting Signal Node: operators must act here, so surface the rendered
    // prompt and the expected payload schema rather than leaving them blind.
    if (node.kind === "run.signal" && node.state === "awaiting") {
      for (const detail of formatAwaitingSignal(node, irNodesByPath?.get(staticNodePathFromKey(node.nodeKey)), run.runId)) {
        lines.push(detail);
      }
    }
  }

  // --- Workflow output (completed runs only) ---
  const outputSection = run.status === "completed" ? formatWorkflowOutput(run.output) : null;
  if (outputSection) {
    lines.push("");
    lines.push(outputSection);
  }

  return lines.join("\n");
}

const MAX_OUTPUT_LINES = 25;

export function formatWorkflowOutput(output: Record<string, unknown> | undefined): string | null {
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
  if (cutIndex === 0) {
    // No content fits — emit placeholder
    return ["Output:", `  ... (${remaining} more lines, output too large to preview)`].join("\n");
  }
  // Check if we'd be left with just a top-level key name and no value
  // (cutIndex === 1 means only line 0, which is a top-level key with no value content)
  if (cutIndex === 1 && lines[0]?.match(/^[^\s]/)) {
    return ["Output:", `  ... (${lines.length} more lines, output too large to preview)`].join("\n");
  }
  const truncated = lines.slice(0, cutIndex).map(l => "  " + l);
  truncated.push(`  ... (${remaining} more lines)`);
  return ["Output:", ...truncated].join("\n");
}
