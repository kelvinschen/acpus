import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, styleForState } from "../theme.js";

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

export function DetailsPane({
  lines,
  height,
  width = 38,
  focused,
  scrollOffset = 0
}: {
  lines: DetailLine[];
  height?: number;
  width?: number;
  focused?: boolean;
  scrollOffset?: number;
}): React.ReactElement {
  // Content rows available = pane height minus border (2) + title (1) + the
  // two "↑/↓ more" hint lines budget (2). Mirror GraphPane's accounting.
  const visibleRows = Math.max(1, (height ?? 12) - 5);
  const { start, end, moreAbove, moreBelow } = offsetWindow(lines.length, scrollOffset, visibleRows);
  const windowed = lines.slice(start, end);

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
      {lines.length === 0 ? (
        <Text color="gray">No node selected.</Text>
      ) : (
        <>
          {moreAbove > 0 ? <Text color="gray">  ↑ {moreAbove} more</Text> : null}
          <Box flexDirection="column">
            {windowed.map((line, i) => (
              <Text key={start + i}>
                {line.segments.length === 0 ? (
                  " "
                ) : (
                  line.segments.map((seg, j) => (
                    <Text key={j} color={seg.color} bold={seg.bold}>{seg.text}</Text>
                  ))
                )}
              </Text>
            ))}
          </Box>
          {moreBelow > 0 ? <Text color="gray">  ↓ {moreBelow} more</Text> : null}
        </>
      )}
    </Box>
  );
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
  freezeAt?: string | number
): DetailLine[] {
  if (!row) return [];
  const cols = Math.max(12, width - 4);
  const inst = row.instance;
  const style = styleForState(row.state);
  const dyn = inst?.dynamicContext;
  const meta = (row.irNode.metadata ?? {}) as Record<string, unknown>;
  const lines: DetailLine[] = [];

  // ── Runtime info ──
  lines.push(field("Node", row.label, cols));
  lines.push(field("Kind", KIND_LABELS[row.irNode.kind], cols));
  lines.push({
    segments: [
      { text: "Status: ", color: "gray" },
      { text: `${style.glyph} ${style.label}`, color: style.color }
    ]
  });
  if (inst) lines.push(field("Attempt", String(inst.attempt), cols));
  if (row.groupDim === "lane") lines.push(field("Lane", row.groupValue ?? "?", cols));
  if (row.groupDim === "lane" && row.groupItem !== undefined) lines.push(field("Item", row.groupItem, cols));
  if (row.groupDim === "round") lines.push(field("Round", row.groupValue ?? "?", cols));
  if (row.branchLabel) lines.push(field("Branch", row.branchLabel, cols));
  if (row.branchWhen) lines.push(...wrappedField("When", row.branchWhen, cols));
  if (inst) lines.push(field("Duration", formatDuration(inst.startedAt, inst.completedAt, freezeAt), cols));
  if (row.nodeKey) lines.push(...wrappedField("Key", row.nodeKey, cols));

  // ── Definition (from IR metadata) ──
  for (const l of definitionLines(row.irNode.kind, meta, row.summary, row.state, cols)) lines.push(l);

  // ── Dynamic context ──
  if (dyn) {
    lines.push(blank());
    lines.push(heading("Context:"));
    if (dyn.item_id !== undefined) lines.push(field("  item_id", String(dyn.item_id), cols));
    if (dyn.item_index !== undefined) lines.push(field("  item_idx", String(dyn.item_index), cols));
    if (dyn.loop) lines.push(field("  loop.iter", String(dyn.loop.iter), cols));
  }

  // ── Prompt (prefer runtime-rendered, fall back to IR template) ──
  const prompt = inst?.renderedPrompt ?? (typeof meta.prompt === "string" ? meta.prompt : undefined);
  if (prompt) {
    lines.push(blank());
    lines.push(heading("Prompt:"));
    for (const l of textLines(prompt, cols)) lines.push(l);
  }

  // ── Error ──
  if (inst?.error && inst.error !== "Aborted: paused") {
    lines.push(blank());
    lines.push({ segments: [{ text: "Error:", color: "red" }] });
    for (const l of textLines(inst.error, cols, "red")) lines.push(l);
  }

  // ── Output ──
  if (inst?.output !== undefined) {
    lines.push(blank());
    lines.push(heading("Output:"));
    for (const l of textLines(JSON.stringify(inst.output, null, 2), cols)) lines.push(l);
  }

  // ── Artifacts (cyan filename line + gray path line; no OSC 8) ──
  if (inst?.artifactRefs && inst.artifactRefs.length > 0) {
    lines.push(blank());
    lines.push(heading("Artifacts:"));
    for (const ref of inst.artifactRefs) {
      const absPath = artifactPaths[ref];
      const name = ref.split("/").pop() ?? ref;
      if (absPath) {
        lines.push({ segments: [{ text: clampInline(name, cols), color: "cyan" }] });
        for (const l of textLines(`  ${absPath}`, cols, "gray")) lines.push(l);
      } else {
        // Path not resolved yet: show the raw artifact:// URI.
        for (const l of textLines(ref, cols, "gray")) lines.push(l);
      }
    }
  }

  return lines;
}

/** Definition block lines, varying by node kind. */
function definitionLines(
  kind: DisplayRow["irNode"]["kind"],
  meta: Record<string, unknown>,
  summary: string | undefined,
  state: DisplayRow["state"],
  cols: number
): DetailLine[] {
  const out: DetailLine[] = [];

  if (kind === "run.agent") {
    const agent = (meta.agent ?? {}) as Record<string, unknown>;
    const retry = meta.retry as { max?: unknown; backoff?: unknown } | undefined;
    out.push(blank(), heading("Definition:"));
    if (agent.use !== undefined) out.push(...wrappedField("  Use", String(agent.use), cols));
    out.push(field("  Type", String(agent.type ?? "builtin"), cols));
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
    out.push(blank(), heading("Definition:"));
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

  if (kind === "approval") {
    out.push(blank(), heading("Definition:"));
    if (meta.timeout !== undefined) out.push(field("  Timeout", String(meta.timeout), cols));
    if (meta.on_timeout !== undefined) out.push(field("  On timeout", String(meta.on_timeout), cols));
    if (state === "awaiting") {
      out.push({ segments: [{ text: "  ⏳ awaiting decision — [a] approve  [x] reject", color: "blue" }] });
    }
    return out;
  }

  // composite / subworkflow: surface the summary if any.
  if (summary) {
    out.push(blank(), heading("Definition:"), ...wrappedField("  Flow", summary, cols));
  }
  return out;
}

/** Truncate a single line so it never wraps (Ink would otherwise grow height). */
function clampInline(s: string, width = 33): string {
  return s.length > width ? s.slice(0, Math.max(1, width - 1)) + "…" : s;
}

function wrapText(s: string, width: number): string[] {
  const cols = Math.max(1, width);
  if (s.length === 0) return [""];
  const lines: string[] = [];
  let rest = s;
  while (rest.length > cols) {
    const window = rest.slice(0, cols + 1);
    const slash = window.lastIndexOf("/");
    const space = window.lastIndexOf(" ");
    const breakAt = Math.max(slash, space);
    if (breakAt > Math.floor(cols * 0.4)) {
      lines.push(rest.slice(0, breakAt + 1));
      rest = rest.slice(breakAt + 1);
    } else {
      lines.push(rest.slice(0, cols));
      rest = rest.slice(cols);
    }
  }
  lines.push(rest);
  return lines;
}

/** Plain text form used for clipboard copy; strips colors. */
export function formatDetailLinesPlainText(lines: DetailLine[]): string {
  return lines.map((line) => line.segments.map((seg) => seg.text).join("")).join("\n");
}

/**
 * Direct offset-based viewport window for the details pane.
 * `scrollOffset` is the index of the top visible line.
 * Returns the clamped [start, end) slice and the moreAbove/moreBelow counts.
 */
export function offsetWindow(
  total: number,
  scrollOffset: number,
  visibleRows: number
): { start: number; end: number; moreAbove: number; moreBelow: number } {
  const maxOffset = Math.max(0, total - visibleRows);
  const start = Math.max(0, Math.min(scrollOffset, maxOffset));
  const end = Math.min(total, start + visibleRows);
  return { start, end, moreAbove: start, moreBelow: total - end };
}
