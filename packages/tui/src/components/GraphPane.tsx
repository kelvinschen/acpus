import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, isComposite, styleForState, TREE_GUIDE_COLOR } from "../theme.js";

/**
 * Workflow graph rendered as a nested tree/outline. Composite nodes
 * (fanout/parallel/switch/loop/...) are labeled containers; fanout lanes and
 * loop rounds are synthetic group rows; the rest are real IR nodes. Honors
 * acpus's IR tree shape rather than the reference image's left-to-right boxed
 * DAG.
 */
export function GraphPane({
  rows,
  selectedIndex,
  focused,
  moreAbove = 0,
  moreBelow = 0,
  height,
  width
}: {
  rows: DisplayRow[];
  selectedIndex: number;
  focused: boolean;
  moreAbove?: number;
  moreBelow?: number;
  height?: number;
  width?: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      width={width}
      flexGrow={width ? undefined : 1}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold color="magenta">
        WORKFLOW GRAPH (IR)
      </Text>
      {moreAbove > 0 ? <Text color="gray">  ↑ {moreAbove} more</Text> : null}
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <GraphRow key={row.rowKey} row={row} selected={i === selectedIndex} />
        ))}
      </Box>
      {moreBelow > 0 ? <Text color="gray">  ↓ {moreBelow} more</Text> : null}
    </Box>
  );
}

function GraphRow({ row, selected }: { row: DisplayRow; selected: boolean }): React.ReactElement {
  const style = styleForState(row.state);
  const isGroup = row.groupDim !== undefined;
  const composite = !isGroup && isComposite(row.irNode.kind);

  // Synthetic lane/round group rows show their label as-is, never a kind tag.
  const kindTag = !isGroup && (composite || row.irNode.kind.startsWith("run."))
    ? `[${KIND_LABELS[row.irNode.kind]}]`
    : "";

  const dur = row.instance ? formatDuration(row.instance.startedAt, row.instance.completedAt) : "";

  // Single-line row: render everything (incl. duration) inside one truncating
  // Text so Ink never wraps the duration onto a second line (which produced
  // intermittent blank lines between leaf rows). The tree guide-line segments
  // are rendered OUTSIDE the selection highlight so connectors stay visible,
  // each colored by whether its column belongs to a parallel/sequential branch.
  return (
    <Text wrap="truncate">
      {row.treeSegments.map((seg, i) => (
        <Text key={i} color={seg.parallel ? TREE_GUIDE_COLOR.parallel : TREE_GUIDE_COLOR.sequential}>
          {seg.text}
        </Text>
      ))}
      <Text color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
        <Text color={style.color}>{style.glyph} </Text>
        {isGroup ? (
          <Text color="yellow" bold>
            {row.label}
          </Text>
        ) : (
          <Text bold={composite}>{row.label}</Text>
        )}
        {kindTag ? <Text color="blue"> {kindTag}</Text> : null}
        {row.branchLabel ? <Text color="yellow"> «{row.branchLabel}»</Text> : null}
        {row.instance && row.instance.attempt > 1 ? (
          <Text color="yellow"> ↺{row.instance.attempt}</Text>
        ) : null}
        {row.summary ? <Text color="gray"> ({row.summary})</Text> : null}
      </Text>
      {dur ? <Text color="gray">  {dur}</Text> : null}
    </Text>
  );
}
