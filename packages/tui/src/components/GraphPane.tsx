import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { isComposite, styleForKind, styleForState } from "../theme.js";

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
  width,
  freezeAt
}: {
  rows: DisplayRow[];
  selectedIndex: number;
  focused: boolean;
  moreAbove?: number;
  moreBelow?: number;
  height?: number;
  width?: number;
  freezeAt?: string | number;
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
          <GraphRow key={row.rowKey} row={row} selected={i === selectedIndex} freezeAt={freezeAt} />
        ))}
      </Box>
      {moreBelow > 0 ? <Text color="gray">  ↓ {moreBelow} more</Text> : null}
    </Box>
  );
}

export function GraphRow({
  row,
  selected,
  freezeAt
}: {
  row: DisplayRow;
  selected: boolean;
  freezeAt?: string | number;
}): React.ReactElement {
  const style = styleForState(row.state);
  const kindStyle = styleForKind(row.irNode.kind);
  const isGroup = row.groupDim !== undefined;
  const composite = !isGroup && isComposite(row.irNode.kind);

  const dur = row.instance ? formatDuration(row.instance.startedAt, row.instance.completedAt, freezeAt) : "";

  // Single-line row: render everything (incl. duration) inside one truncating
  // Text so Ink never wraps the duration onto a second line. Tree guide-line
  // segments stay outside the selection highlight and use the owning kind color.
  return (
    <Text wrap="truncate">
      {row.treeSegments.map((seg, i) => (
        <Text key={i} color={styleForKind(seg.ownerKind).color}>
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
        <Text color={kindStyle.color}> {kindStyle.symbol}</Text>
        {row.branchLabel ? <Text color="yellow"> [{row.branchLabel}]</Text> : null}
        {row.summary ? <Text color="gray"> ({row.summary})</Text> : null}
      </Text>
      {dur ? <Text color="gray">  {dur}</Text> : null}
    </Text>
  );
}
