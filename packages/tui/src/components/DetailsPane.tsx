import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, styleForState } from "../theme.js";

/**
 * Right pane: details for the currently-selected node row.
 *
 * Layout order: runtime info → node Definition (from IR metadata) → error →
 * output → artifacts. When Tab-focused, the border highlights and `scrollOffset`
 * shifts the lower (output/artifacts) region so long content can be read.
 * Pressing Enter toggles `expanded`, which removes per-field truncation/line
 * limits so the full content can be scrolled with u/d.
 *
 * `artifactPaths` maps an artifact:// URI to its resolved absolute filesystem
 * path (pre-fetched by App). Artifacts render as "<filename>  <absPath>" in
 * plain text (no OSC 8 hyperlink — Ink's truncation mangles the escape).
 */
export function DetailsPane({
  row,
  height,
  width = 38,
  focused,
  scrollOffset = 0,
  expanded = false,
  artifactPaths = {}
}: {
  row?: DisplayRow;
  height?: number;
  width?: number;
  focused?: boolean;
  scrollOffset?: number;
  expanded?: boolean;
  artifactPaths?: Record<string, string>;
}): React.ReactElement {
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
        NODE DETAILS{focused ? " ◂" : ""}{expanded ? " (expanded)" : ""}
      </Text>
      {row ? (
        <Details
          row={row}
          maxHeight={height}
          maxWidth={width}
          scrollOffset={scrollOffset}
          expanded={expanded}
          artifactPaths={artifactPaths}
        />
      ) : (
        <Text color="gray">No node selected.</Text>
      )}
    </Box>
  );
}

function Details({
  row,
  maxHeight,
  maxWidth = 38,
  scrollOffset,
  expanded,
  artifactPaths
}: {
  row: DisplayRow;
  maxHeight?: number;
  maxWidth?: number;
  scrollOffset: number;
  expanded: boolean;
  artifactPaths: Record<string, string>;
}): React.ReactElement {
  const inst = row.instance;
  const style = styleForState(row.state);
  const dyn = inst?.dynamicContext;
  const meta = (row.irNode.metadata ?? {}) as Record<string, unknown>;
  // Visible content width = pane width minus border (2) and paddingX (2).
  const cols = Math.max(12, maxWidth - 4);
  // In expanded mode, single-line fields wrap instead of truncating, and
  // multi-line blocks are not line-limited (scroll with u/d to read them).
  const inline = (s: string) => (expanded ? s : clampInline(s, cols));
  const lineLimit = (n: number) => (expanded ? Number.MAX_SAFE_INTEGER : n);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* ── Runtime info ── */}
      <Line label="Node" value={row.label} wrap={expanded} />
      <Line label="Kind" value={KIND_LABELS[row.irNode.kind]} />
      <Box>
        <Text color="gray">Status: </Text>
        <Text color={style.color}>
          {style.glyph} {style.label}
        </Text>
      </Box>
      {inst ? <Line label="Attempt" value={String(inst.attempt)} /> : null}
      {row.groupDim === "lane" ? <Line label="Lane" value={row.groupValue ?? "?"} /> : null}
      {row.groupDim === "lane" && row.groupItem !== undefined ? (
        <Line label="Item" value={inline(row.groupItem)} wrap={expanded} />
      ) : null}
      {row.groupDim === "round" ? <Line label="Round" value={row.groupValue ?? "?"} /> : null}
      {row.branchLabel ? <Line label="Branch" value={row.branchLabel} /> : null}
      {row.branchWhen ? <Line label="When" value={inline(row.branchWhen)} wrap={expanded} /> : null}
      {inst ? <Line label="Duration" value={formatDuration(inst.startedAt, inst.completedAt)} /> : null}
      {row.nodeKey ? <Line label="Key" value={inline(row.nodeKey)} wrap={expanded} /> : null}

      {/* ── Definition (from IR metadata) ── */}
      <Definition kind={row.irNode.kind} meta={meta} summary={row.summary} state={row.state} cols={cols} expanded={expanded} />

      {/* ── Dynamic context ── */}
      {dyn ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Context:</Text>
          {dyn.item_id !== undefined ? <Line label="  item_id" value={String(dyn.item_id)} /> : null}
          {dyn.item_index !== undefined ? <Line label="  item_idx" value={String(dyn.item_index)} /> : null}
          {dyn.loop ? <Line label="  loop.iter" value={String(dyn.loop.iter)} /> : null}
        </Box>
      ) : null}

      {/* ── Error ── */}
      {inst?.error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">Error:</Text>
          <Text color="red">{clampLines(inst.error, lineLimit(3), scrollOffset, cols, expanded)}</Text>
        </Box>
      ) : null}

      {/* ── Output (scrollable) ── */}
      {inst?.output !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Output:</Text>
          <Text>{clampLines(JSON.stringify(inst.output, null, 2), lineLimit(outputLines(maxHeight)), scrollOffset, cols, expanded)}</Text>
        </Box>
      ) : null}

      {/* ── Artifacts ("<filename>  <absPath>", plain text — no OSC 8) ── */}
      {inst?.artifactRefs && inst.artifactRefs.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Artifacts:</Text>
          {inst.artifactRefs.map((ref) => {
            const absPath = artifactPaths[ref];
            const name = ref.split("/").pop() ?? ref;
            if (absPath) {
              // Filename (cyan) acts as the title; the absolute path follows in
              // gray as secondary info so the two are visually distinct.
              return (
                <Box key={ref} flexDirection="column">
                  <Text color="cyan" wrap={expanded ? "wrap" : "truncate"}>
                    {name}
                  </Text>
                  <Text color="gray" wrap={expanded ? "wrap" : "truncate"}>
                    {"  "}{absPath}
                  </Text>
                </Box>
              );
            }
            // Path not yet resolved: fall back to the raw artifact:// URI.
            return (
              <Text key={ref} color="gray" wrap={expanded ? "wrap" : "truncate"}>
                {ref}
              </Text>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}

/** Node Definition block, varies by kind. Reads static IR metadata. */
function Definition({
  kind,
  meta,
  summary,
  state,
  cols = 33,
  expanded = false
}: {
  kind: DisplayRow["irNode"]["kind"];
  meta: Record<string, unknown>;
  summary?: string;
  state?: DisplayRow["state"];
  cols?: number;
  expanded?: boolean;
}): React.ReactElement | null {
  const inline = (s: string) => (expanded ? s : clampInline(s, cols));
  const promptLimit = expanded ? Number.MAX_SAFE_INTEGER : 6;
  if (kind === "run.agent") {
    const agent = (meta.agent ?? {}) as Record<string, unknown>;
    const retry = meta.retry as { max?: unknown; backoff?: unknown } | undefined;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Definition:</Text>
        {agent.use !== undefined ? <Line label="  Use" value={String(agent.use)} /> : null}
        <Line label="  Type" value={String(agent.type ?? "builtin")} />
        {agent.model !== undefined ? <Line label="  Model" value={String(agent.model)} /> : null}
        {meta.timeout !== undefined ? <Line label="  Timeout" value={String(meta.timeout)} /> : null}
        {retry ? (
          <Line
            label="  Retry"
            value={`max=${String(retry.max ?? "?")}${retry.backoff !== undefined ? ` backoff=${String(retry.backoff)}` : ""}`}
          />
        ) : null}
        {typeof meta.prompt === "string" ? (
          <Box flexDirection="column">
            <Text color="gray">  Prompt:</Text>
            <Text>{clampLines(meta.prompt, promptLimit, 0, cols, expanded)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (kind === "run.program") {
    const cmd = Array.isArray(meta.cmd) ? meta.cmd.map(String).join(" ") : undefined;
    const capture = meta.capture as { from?: unknown; parse?: unknown } | undefined;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Definition:</Text>
        {cmd ? <Line label="  Command" value={inline(cmd)} wrap={expanded} /> : null}
        {capture ? (
          <Line
            label="  Capture"
            value={`from=${String(capture.from ?? "?")}${capture.parse !== undefined ? ` parse=${String(capture.parse)}` : ""}`}
          />
        ) : null}
      </Box>
    );
  }

  if (kind === "approval") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Definition:</Text>
        {meta.timeout !== undefined ? <Line label="  Timeout" value={String(meta.timeout)} /> : null}
        {meta.on_timeout !== undefined ? <Line label="  On timeout" value={String(meta.on_timeout)} /> : null}
        {typeof meta.prompt === "string" ? (
          <Box flexDirection="column">
            <Text color="gray">  Prompt:</Text>
            <Text>{clampLines(meta.prompt, promptLimit, 0, cols, expanded)}</Text>
          </Box>
        ) : null}
        {state === "awaiting" ? (
          <Text color="blue">  ⏳ awaiting decision — [a] approve  [x] reject</Text>
        ) : null}
      </Box>
    );
  }

  // composite / subworkflow: surface the summary if any.
  if (summary) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Definition:</Text>
        <Line label="  Flow" value={inline(summary)} wrap={expanded} />
      </Box>
    );
  }
  return null;
}

function Line({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }): React.ReactElement {
  return (
    <Box>
      {/* Separate space node so the gap survives Ink's truncation layout
          (a trailing space inside the label Text can be dropped). */}
      <Text color="gray">{label}:</Text>
      <Text> </Text>
      <Text wrap={wrap ? "wrap" : "truncate"}>{value}</Text>
    </Box>
  );
}

/** How many output lines fit, scaled to the pane height (leave room for other fields). */
function outputLines(maxHeight?: number): number {
  if (!maxHeight) return 8;
  return Math.max(3, Math.floor(maxHeight / 3));
}

/** Truncate a single-line value so it never wraps (~33 visible cols). */
function clampInline(s: string, width = 33): string {
  return s.length > width ? s.slice(0, width - 1) + "…" : s;
}

/**
 * Clamp a multi-line string to at most `maxLines` lines starting at `offset`,
 * and truncate each line so it never wraps (wrapping would silently grow the
 * pane height and break Ink's frame erasure). The details pane is ~34 cols wide.
 * In `expanded` mode lines are NOT per-line truncated (full content shown);
 * Ink's pane `overflow="hidden"` clips overflow and u/d scrolls through it.
 */
function clampLines(s: string, maxLines: number, offset = 0, width = 33, expanded = false): string {
  const all = expanded
    ? s.split("\n")
    : s.split("\n").map((line) => (line.length > width ? line.slice(0, width - 1) + "…" : line));
  const start = Math.max(0, Math.min(offset, Math.max(0, all.length - maxLines)));
  const slice = all.slice(start, start + maxLines);
  const prefix = start > 0 ? "↑…\n" : "";
  const suffix = start + maxLines < all.length ? "\n…" : "";
  return prefix + slice.join("\n") + suffix;
}
