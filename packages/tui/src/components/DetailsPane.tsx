import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, styleForState } from "../theme.js";
import { hyperlink } from "../osc8.js";

/**
 * Right pane: details for the currently-selected node row.
 *
 * Layout order: runtime info → node Definition (from IR metadata) → error →
 * output → artifacts. When Tab-focused, the border highlights and `scrollOffset`
 * shifts the lower (output/artifacts) region so long content can be read.
 *
 * `artifactPaths` maps an artifact:// URI to its resolved absolute filesystem
 * path (pre-fetched by App); when present, the artifact renders as a clickable
 * OSC 8 hyperlink to `file://<absPath>`.
 */
export function DetailsPane({
  row,
  height,
  focused,
  scrollOffset = 0,
  artifactPaths = {}
}: {
  row?: DisplayRow;
  height?: number;
  focused?: boolean;
  scrollOffset?: number;
  artifactPaths?: Record<string, string>;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      width={38}
      height={height}
      overflow="hidden"
    >
      <Text bold color="magenta">
        NODE DETAILS{focused ? " ◂" : ""}
      </Text>
      {row ? (
        <Details row={row} maxHeight={height} scrollOffset={scrollOffset} artifactPaths={artifactPaths} />
      ) : (
        <Text color="gray">No node selected.</Text>
      )}
    </Box>
  );
}

function Details({
  row,
  maxHeight,
  scrollOffset,
  artifactPaths
}: {
  row: DisplayRow;
  maxHeight?: number;
  scrollOffset: number;
  artifactPaths: Record<string, string>;
}): React.ReactElement {
  const inst = row.instance;
  const style = styleForState(row.state);
  const dyn = inst?.dynamicContext;
  const meta = (row.irNode.metadata ?? {}) as Record<string, unknown>;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* ── Runtime info ── */}
      <Line label="Node" value={row.label} />
      <Line label="Kind" value={KIND_LABELS[row.irNode.kind]} />
      <Box>
        <Text color="gray">Status: </Text>
        <Text color={style.color}>
          {style.glyph} {style.label}
        </Text>
      </Box>
      {inst ? <Line label="Attempt" value={String(inst.attempt)} /> : null}
      {row.branchLabel ? <Line label="Branch" value={row.branchLabel} /> : null}
      {row.branchWhen ? <Line label="When" value={clampInline(row.branchWhen)} /> : null}
      {inst ? <Line label="Duration" value={formatDuration(inst.startedAt, inst.completedAt)} /> : null}
      {row.nodeKey ? <Line label="Key" value={clampInline(row.nodeKey)} /> : null}

      {/* ── Definition (from IR metadata) ── */}
      <Definition kind={row.irNode.kind} meta={meta} summary={row.summary} />

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
          <Text color="red">{clampLines(inst.error, 3, scrollOffset)}</Text>
        </Box>
      ) : null}

      {/* ── Output (scrollable) ── */}
      {inst?.output !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Output:</Text>
          <Text>{clampLines(JSON.stringify(inst.output, null, 2), outputLines(maxHeight), scrollOffset)}</Text>
        </Box>
      ) : null}

      {/* ── Artifacts (OSC 8 clickable when path resolved) ── */}
      {inst?.artifactRefs && inst.artifactRefs.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Artifacts:</Text>
          {inst.artifactRefs.map((ref) => {
            const absPath = artifactPaths[ref];
            const name = ref.split("/").pop() ?? ref;
            if (absPath) {
              return (
                <Text key={ref} color="cyan" wrap="truncate">
                  {hyperlink(name, `file://${absPath}`)}
                </Text>
              );
            }
            return (
              <Text key={ref} wrap="truncate">
                {name}
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
  summary
}: {
  kind: DisplayRow["irNode"]["kind"];
  meta: Record<string, unknown>;
  summary?: string;
}): React.ReactElement | null {
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
            <Text>{clampLines(meta.prompt, 6, 0)}</Text>
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
        {cmd ? <Line label="  Command" value={clampInline(cmd)} /> : null}
        {capture ? (
          <Line
            label="  Capture"
            value={`from=${String(capture.from ?? "?")}${capture.parse !== undefined ? ` parse=${String(capture.parse)}` : ""}`}
          />
        ) : null}
      </Box>
    );
  }

  // composite / approval / subworkflow: surface the summary if any.
  if (summary) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Definition:</Text>
        <Line label="  Flow" value={clampInline(summary)} />
      </Box>
    );
  }
  return null;
}

function Line({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box>
      <Text color="gray">{label}: </Text>
      <Text wrap="truncate">{value}</Text>
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
 */
function clampLines(s: string, maxLines: number, offset = 0, width = 33): string {
  const all = s.split("\n").map((line) => (line.length > width ? line.slice(0, width - 1) + "…" : line));
  const start = Math.max(0, Math.min(offset, Math.max(0, all.length - maxLines)));
  const slice = all.slice(start, start + maxLines);
  const prefix = start > 0 ? "↑…\n" : "";
  const suffix = start + maxLines < all.length ? "\n…" : "";
  return prefix + slice.join("\n") + suffix;
}
