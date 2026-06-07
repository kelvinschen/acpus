import React from "react";
import { Box, Text } from "ink";
import type { DisplayRow } from "../model.js";
import { formatDuration } from "../model.js";
import { KIND_LABELS, isComposite, styleForState } from "../theme.js";

/**
 * Workflow graph rendered as a nested tree/outline. Composite nodes
 * (fanout/parallel/switch/loop/...) are labeled containers; runtime instances
 * (lanes/rounds/branches) are indented children. Honors acpus's IR tree shape
 * rather than the reference image's left-to-right boxed DAG.
 */
export function GraphPane({
  rows,
  selectedIndex,
  focused,
  moreAbove = 0,
  moreBelow = 0,
  height
}: {
  rows: DisplayRow[];
  selectedIndex: number;
  focused: boolean;
  moreAbove?: number;
  moreBelow?: number;
  height?: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      flexGrow={1}
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
  const indent = "  ".repeat(row.depth);
  const composite = isComposite(row.irNode.kind);
  const connector = row.depth > 0 ? "└─ " : "";

  const kindTag = composite || row.irNode.kind.startsWith("run.")
    ? `[${KIND_LABELS[row.irNode.kind]}]`
    : "";

  const dur = row.instance ? formatDuration(row.instance.startedAt, row.instance.completedAt) : "";

  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate">
        <Text>{indent}</Text>
        <Text color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
          <Text>{connector}</Text>
          <Text color={style.color}>{style.glyph} </Text>
          <Text bold={composite}>{row.label}</Text>
          {kindTag ? <Text color="blue"> {kindTag}</Text> : null}
          {row.branchLabel ? <Text color="yellow"> «{row.branchLabel}»</Text> : null}
          {row.instance && row.instance.attempt > 1 ? (
            <Text color="yellow"> ↺{row.instance.attempt}</Text>
          ) : null}
          {row.summary ? <Text color="gray"> ({row.summary})</Text> : null}
        </Text>
      </Text>
      {dur ? <Text color="gray"> {dur}</Text> : null}
    </Box>
  );
}
