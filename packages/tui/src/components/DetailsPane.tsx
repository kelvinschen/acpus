import React from "react";
import { Box, Text } from "ink";
import type { AgentToolCallTelemetry, AgentTelemetry } from "@acpus/runtime";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, styleForKind, styleForState } from "../theme.js";
import { ScrollArea, Tabs, jsonViewerRows, markdownRows } from "../ui/inkui/index.js";
import { clampInline, wrapText } from "../ui/inkui/theme.js";

/**
 * Right pane: details for the currently-selected node row.
 *
 * The whole pane is flattened into a single array of colored lines
 * (`DetailLine[]`) and then windowed with direct offset slicing — `scrollOffset`
 * is the top visible line index, NOT a selection-centric center position.
 * This makes u/d (half-page) and j/k (line) scroll the entire content
 * uniformly, one line per press.
 *
 * `artifactPaths` maps an artifact:// URI to its resolved absolute filesystem
 * path (pre-fetched by App). Artifacts render as a cyan filename line followed
 * by a gray absolute-path line in plain wrapped text.
 */

/** One colored segment of a detail line. */
export interface DetailSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

/** One rendered line of the NODE DETAILS pane. */
export interface DetailLine {
  segments: DetailSegment[];
}

export type DetailSectionKey = "summary" | "execution" | "prompt" | "error" | "output" | "artifacts";

export interface DetailSection {
  key: DetailSectionKey;
  label: string;
  /** Plain fallback used for OSC 52 copy and non-rich rendering. */
  lines: DetailLine[];
  richContent?: { kind: "markdown"; content: string } | { kind: "json"; data: unknown };
}

export interface JsonDisplayState {
  expandedIds?: ReadonlySet<string>;
  selectedIndex?: number;
}

export function DetailsPane({
  lines,
  sections,
  activeSectionKey,
  height,
  width = 38,
  focused,
  scrollOffset = 0,
  jsonDisplay
}: {
  lines?: DetailLine[];
  sections?: DetailSection[];
  activeSectionKey?: DetailSectionKey;
  height?: number;
  width?: number;
  focused?: boolean;
  scrollOffset?: number;
  jsonDisplay?: JsonDisplayState;
}): React.ReactElement {
  const paneSections = sections ?? [{ key: "summary" as const, label: "Details", lines: lines ?? [] }];
  const activeSection = paneSections.find((section) => section.key === activeSectionKey) ?? paneSections[0];
  const cols = Math.max(12, width - 4);
  const contentCols = Math.max(11, cols - 1);
  const visibleRows = detailContentRows(height);
  const rows = activeSection ? detailSectionRows(activeSection, contentCols, jsonDisplay) : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Text bold color="magenta">
        NODE DETAILS{focused ? " ◂" : ""}
      </Text>
      {paneSections.length > 0 ? (
        <Tabs tabs={paneSections.map((section) => ({ key: section.key, label: section.label }))} activeKey={activeSection?.key ?? ""} width={cols} />
      ) : null}
      <Box marginTop={1}>
        {!activeSection || rows.length === 0 ? (
          <Text color="gray">No node selected.</Text>
        ) : (
          <ScrollArea height={visibleRows} width={cols} offset={scrollOffset}>
            {rows}
          </ScrollArea>
        )}
      </Box>
    </Box>
  );
}

export function detailContentRows(height: number | undefined): number {
  return Math.max(1, (height ?? 12) - 5);
}

export function detailSectionRowCount(section: DetailSection | undefined, width: number, jsonDisplay?: JsonDisplayState): number {
  if (!section) return 0;
  return detailSectionRows(section, Math.max(11, width - 5), jsonDisplay).length;
}

function detailSectionRows(section: DetailSection, cols: number, jsonDisplay?: JsonDisplayState): React.ReactElement[] {
  if (section.richContent?.kind === "markdown") {
    return markdownRows(section.richContent.content, cols);
  }
  if (section.richContent?.kind === "json") {
    return jsonViewerRows(section.richContent.data, cols, {
      rootLabel: "root",
      initialDepth: 3,
      expandedIds: jsonDisplay?.expandedIds,
      selectedIndex: jsonDisplay?.selectedIndex
    });
  }
  return trimLeadingBlanks(section.lines).map((line, i) => renderDetailLine(line, i));
}

function renderDetailLine(line: DetailLine, key: React.Key): React.ReactElement {
  return (
    <Text key={key}>
      {line.segments.length === 0 ? (
        " "
      ) : (
        line.segments.map((seg, j) => (
          <Text key={j} color={seg.color} bold={seg.bold}>{seg.text}</Text>
        ))
      )}
    </Text>
  );
}

function trimLeadingBlanks(lines: DetailLine[]): DetailLine[] {
  let firstContent = 0;
  while (firstContent < lines.length && lines[firstContent].segments.length === 0) firstContent++;
  return lines.slice(firstContent);
}

// ─── Line building (pure) ────────────────────────────────────────

/** A blank spacer line. */
function blank(): DetailLine {
  return { segments: [] };
}

/** A "label: value" line — label gray, value in `valueColor` (default none). */
function field(label: string, value: string, cols: number, valueColor?: string): DetailLine {
  // Keep the gap as its own segment so truncation never eats it.
  return {
    segments: [
      { text: `${label}: `, color: "gray" },
      { text: clampInline(value, Math.max(1, cols - label.length - 2)), color: valueColor }
    ]
  };
}

/** A node-kind field that mirrors the graph's node type legend. */
function kindField(kind: DisplayRow["irNode"]["kind"]): DetailLine {
  const kindStyle = styleForKind(kind);
  return {
    segments: [
      { text: "Kind: ", color: "gray" },
      { text: KIND_LABELS[kind], color: kindStyle.color },
      { text: ` ${kindStyle.symbol}`, color: kindStyle.color }
    ]
  };
}

/** A "label: long value" field that wraps the value over multiple lines. */
function wrappedField(label: string, value: string, cols: number, valueColor?: string): DetailLine[] {
  const prefix = `${label}: `;
  const firstWidth = Math.max(1, cols - prefix.length);
  const restPrefix = " ".repeat(prefix.length);
  const chunks = wrapText(value, firstWidth);
  return chunks.map((chunk, i) => ({
    segments: i === 0
      ? [{ text: prefix, color: "gray" }, { text: chunk, color: valueColor }]
      : [{ text: restPrefix, color: "gray" }, { text: chunk, color: valueColor }]
  }));
}

/** A plain heading line (gray). */
function heading(text: string): DetailLine {
  return { segments: [{ text, color: "gray" }] };
}

/** A low-emphasis subsection heading inside dense detail panes. */
function sectionHeading(text: string): DetailLine {
  return { segments: [{ text: `── ${text} ──`, color: "gray", bold: true }] };
}

/** Split a multi-line string into wrapped DetailLines. */
function textLines(s: string, cols: number, color?: string): DetailLine[] {
  return s.split("\n").flatMap((line) =>
    wrapText(line, cols).map((chunk) => ({
      segments: [{ text: chunk, color }]
    }))
  );
}

/**
 * Flatten the selected row into a single array of colored lines. Pure: callers
 * (App) reuse it to compute the scroll bound, then pass the result to the pane.
 */
export function buildDetailLines(
  row: DisplayRow | undefined,
  width: number,
  artifactPaths: Record<string, string>,
  freezeAt?: string | number,
  agentTelemetry?: AgentTelemetry
): DetailLine[] {
  return buildDetailSections(row, width, artifactPaths, freezeAt, agentTelemetry).flatMap((section) => section.lines);
}

export function buildDetailSections(
  row: DisplayRow | undefined,
  width: number,
  artifactPaths: Record<string, string>,
  freezeAt?: string | number,
  agentTelemetry?: AgentTelemetry
): DetailSection[] {
  if (!row) return [];
  const cols = Math.max(12, width - 4);
  const inst = row.instance;
  const style = styleForState(row.state);
  const dyn = inst?.dynamicContext;
  const meta = (row.irNode.metadata ?? {}) as Record<string, unknown>;
  const sections: DetailSection[] = [];
  const summary: DetailLine[] = [sectionHeading("Runtime")];

  // ── Runtime info ──
  summary.push(field("Node", row.label, cols));
  summary.push(kindField(row.irNode.kind));
  summary.push({
    segments: [
      { text: "Status: ", color: "gray" },
      { text: `${style.glyph} ${style.label}`, color: style.color }
    ]
  });
  if (inst) summary.push(field("Attempt", String(inst.attempt), cols));
  if (row.groupDim === "lane") summary.push(field("Lane", row.groupValue ?? "?", cols));
  if (row.groupDim === "lane" && row.groupItem !== undefined) summary.push(field("Item", row.groupItem, cols));
  if (row.groupDim === "round") summary.push(field("Round", row.groupValue ?? "?", cols));
  if (row.branchLabel) summary.push(field("Branch", row.branchLabel, cols));
  if (row.branchWhen) summary.push(...wrappedField("When", row.branchWhen, cols));
  if (inst) summary.push(field("Duration", formatDuration(inst.startedAt, inst.completedAt, freezeAt), cols));
  if (row.nodeKey) summary.push(...wrappedField("Key", row.nodeKey, cols));

  // ── Dynamic context ──
  if (dyn) {
    summary.push(blank(), sectionHeading("Context"));
    if (dyn.item_id !== undefined) summary.push(field("  item_id", String(dyn.item_id), cols));
    if (dyn.item_index !== undefined) summary.push(field("  item_idx", String(dyn.item_index), cols));
    if (dyn.loop) summary.push(field("  loop.iter", String(dyn.loop.iter), cols));
  }

  // ── Definition (from IR metadata) ──
  const definition = definitionLines(row.irNode.kind, meta, row.summary, row.state, cols, inst?.renderedSessionKey);
  if (hasContent(definition)) summary.push(...definition);
  sections.push({ key: "summary", label: "Summary", lines: summary });

  const effectiveAgentTelemetry = agentTelemetry ?? inst?.agentTelemetry;
  const agentAttempt = effectiveAgentTelemetry?.attempts.find((attempt) => attempt.attempt === effectiveAgentTelemetry.currentAttempt)
    ?? effectiveAgentTelemetry?.attempts[effectiveAgentTelemetry.attempts.length - 1];

  // ── Agent execution telemetry from compact Node state ──
  if (row.irNode.kind === "run.agent" && agentAttempt) {
    const execution: DetailLine[] = [blank(), heading("Execution:")];
    if (agentAttempt.context) {
      execution.push(field("  Context", formatContextUsage(agentAttempt.context.used, agentAttempt.context.size), cols));
    }
    execution.push(field("  Tool calls", String(agentAttempt.tools.totalToolCallCount), cols));
    if (agentAttempt.tools.droppedToolCallCount > 0) {
      execution.push(field("  Dropped", String(agentAttempt.tools.droppedToolCallCount), cols));
    }
    if (agentAttempt.tools.recentCalls.length > 0) {
      execution.push(heading("  Last tools:"));
      for (const tool of agentAttempt.tools.recentCalls.slice(0, 3)) {
        execution.push(...textLines(`  - ${formatToolCall(tool)}`, cols));
      }
    }
    sections.push({ key: "execution", label: "Execution", lines: execution });
  }

  // ── Prompt (prefer runtime preview, fall back to IR template) ──
  const prompt = agentAttempt?.input?.preview
    ?? inst?.renderedPrompt
    ?? (typeof meta.prompt === "string" ? meta.prompt : undefined);
  if (prompt) {
    sections.push({
      key: "prompt",
      label: "Prompt",
      lines: [blank(), heading("Prompt:"), ...textLines(prompt, cols)],
      richContent: { kind: "markdown", content: prompt }
    });
  }

  // ── Error ──
  if (inst?.error && inst.error !== "Aborted: paused") {
    sections.push({
      key: "error",
      label: "Error",
      lines: [blank(), { segments: [{ text: "Error:", color: "red" }] }, ...textLines(inst.error, cols, "red")]
    });
  }

  // ── Output ──
  if (row.irNode.kind === "run.agent" && agentAttempt?.output) {
    const outputText = agentAttempt.output.preview;
    sections.push({
      key: "output",
      label: "Output",
      lines: [blank(), heading("Output:"), ...textLines(outputText, cols)],
      richContent: { kind: "markdown", content: outputText }
    });
  } else if (inst?.output !== undefined) {
    const outputValue = inst.output;
    const outputText = JSON.stringify(outputValue, null, 2) ?? String(outputValue);
    sections.push({
      key: "output",
      label: "Output",
      lines: [blank(), heading("Output:"), ...textLines(outputText, cols)],
      richContent: isExpandableJson(outputValue) ? { kind: "json", data: outputValue } : undefined
    });
  }

  // ── Artifacts (cyan filename line + gray path line; no OSC 8) ──
  if (inst?.artifactRefs && inst.artifactRefs.length > 0) {
    const artifacts: DetailLine[] = [blank(), heading("Artifacts:")];
    for (const [index, ref] of inst.artifactRefs.entries()) {
      const absPath = artifactPaths[ref];
      const name = ref.split("/").pop() ?? ref;
      if (index > 0) artifacts.push(blank());
      artifacts.push({ segments: [{ text: clampInline(name, cols), color: "cyan" }] });
      if (absPath) {
        for (const l of textLines(absPath, cols, "gray")) artifacts.push(l);
      } else {
        // Path not resolved yet: show the raw artifact:// URI.
        for (const l of textLines(ref, cols, "gray")) artifacts.push(l);
      }
    }
    sections.push({ key: "artifacts", label: "Artifacts", lines: artifacts });
  }

  return sections;
}

function hasContent(lines: DetailLine[]): boolean {
  return lines.some((line) => line.segments.length > 0);
}

/** Non-null objects and arrays benefit from the JSON tree viewer. */
function isExpandableJson(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/** Definition block lines, varying by node kind. */
function definitionLines(
  kind: DisplayRow["irNode"]["kind"],
  meta: Record<string, unknown>,
  summary: string | undefined,
  state: DisplayRow["state"],
  cols: number,
  renderedSessionKey?: string
): DetailLine[] {
  const out: DetailLine[] = [];

  if (kind === "run.agent") {
    const agent = (meta.agent ?? {}) as Record<string, unknown>;
    const retry = meta.retry as { max?: unknown; backoff?: unknown } | undefined;
    out.push(blank(), sectionHeading("Definition"));
    if (agent.use !== undefined) out.push(...wrappedField("  Use", String(agent.use), cols));
    out.push(field("  Type", String(agent.type ?? "builtin"), cols));
    if (renderedSessionKey !== undefined) out.push(...wrappedField("  Session key", renderedSessionKey, cols));
    if (agent.model !== undefined) out.push(field("  Model", String(agent.model), cols));
    if (meta.timeout !== undefined) out.push(field("  Timeout", String(meta.timeout), cols));
    if (retry) {
      out.push(
        field(
          "  Retry",
          `max=${String(retry.max ?? "?")}${retry.backoff !== undefined ? ` backoff=${String(retry.backoff)}` : ""}`,
          cols
        )
      );
    }
    return out;
  }

  if (kind === "run.program") {
    const cmd = Array.isArray(meta.cmd) ? meta.cmd.map(String).join(" ") : undefined;
    const capture = meta.capture as { from?: unknown; parse?: unknown } | undefined;
    out.push(blank(), sectionHeading("Definition"));
    if (cmd) out.push(...wrappedField("  Command", cmd, cols));
    if (capture) {
      out.push(
        field(
          "  Capture",
          `from=${String(capture.from ?? "?")}${capture.parse !== undefined ? ` parse=${String(capture.parse)}` : ""}`,
          cols
        )
      );
    }
    return out;
  }

  if (kind === "guard") {
    out.push(blank(), sectionHeading("Definition"));
    if (meta.when !== undefined) out.push(...wrappedField("  When", String(meta.when), cols));
    if (meta.then !== undefined) out.push(field("  Then", String(meta.then), cols));
    if (meta.else !== undefined) out.push(field("  Else", String(meta.else), cols));
    if (meta.message !== undefined) out.push(...wrappedField("  Message", String(meta.message), cols));
    return out;
  }

  if (kind === "approval") {
    out.push(blank(), sectionHeading("Definition"));
    if (meta.timeout !== undefined) out.push(field("  Timeout", String(meta.timeout), cols));
    if (meta.on_timeout !== undefined) out.push(field("  On timeout", String(meta.on_timeout), cols));
    if (state === "awaiting") {
      out.push({ segments: [{ text: "  ⏳ awaiting decision — [a] approve  [x] reject", color: "blue" }] });
    }
    return out;
  }

  // composite / subworkflow: surface the summary if any.
  if (summary) {
    out.push(blank(), sectionHeading("Definition"), ...wrappedField("  Flow", summary, cols));
  }
  return out;
}

function formatToolCall(tool: AgentToolCallTelemetry): string {
  const status = tool.status ?? "unknown";
  const name = tool.title ?? tool.toolName ?? tool.kind ?? tool.toolCallId;
  const suffix = [tool.toolName, tool.kind]
    .filter((v): v is string => v !== undefined && v !== name)
    .join(" / ");
  return suffix ? `${status} ${name} (${suffix})` : `${status} ${name}`;
}

export function formatContextUsage(used: number, size: number): string {
  return `${formatContextNumber(used)}/${formatContextNumber(size)}`;
}

function formatContextNumber(value: number): string {
  return value < 1000 ? String(value) : `${Math.floor(value / 1000)}k`;
}

/** Plain text form used for clipboard copy; strips colors. */
export function formatDetailLinesPlainText(lines: DetailLine[]): string {
  return lines.map((line) => line.segments.map((seg) => seg.text).join("")).join("\n");
}
