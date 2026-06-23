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
  freezeAt,
  collapsedRows
}: {
  rows: DisplayRow[];
  selectedIndex: number;
  focused: boolean;
  moreAbove?: number;
  moreBelow?: number;
  height?: number;
  width?: number;
  freezeAt?: string | number;
  collapsedRows?: ReadonlySet<string>;
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
        WORKFLOW GRAPH
      </Text>
      {moreAbove > 0 ? <Text color="gray">  ↑ {moreAbove} more</Text> : null}
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <GraphRow
            key={row.rowKey}
            row={row}
            selected={i === selectedIndex}
            collapsed={collapsedRows?.has(row.rowKey) ?? false}
            freezeAt={freezeAt}
          />
        ))}
      </Box>
      {moreBelow > 0 ? <Text color="gray">  ↓ {moreBelow} more</Text> : null}
    </Box>
  );
}

export function GraphRow({
  row,
  selected,
  collapsed = false,
  freezeAt
}: {
  row: DisplayRow;
  selected: boolean;
  collapsed?: boolean;
  freezeAt?: string | number;
}): React.ReactElement {
  const style = styleForState(row.state);
  const kindStyle = styleForKind(row.irNode.kind);
  const isGroup = row.groupDim !== undefined;
  const isBranch = row.rowKind === "branch";
  const plainStructureLabel = isBranch || isGroup;
  const composite = !plainStructureLabel && isComposite(row.irNode.kind);
  const indicator = collapseIndicatorForRow(row, collapsed);

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
        {plainStructureLabel ? (
          <Text color="yellow" bold>
            {row.label}
          </Text>
        ) : (
          <Text bold={composite}>{row.label}</Text>
        )}
        {isBranch ? null : <Text color={kindStyle.color}> {kindStyle.symbol}</Text>}
        {indicator ? <Text color={indicator.color}> {indicator.glyph}</Text> : null}
      </Text>
      {dur ? <Text color="gray">  {dur}</Text> : null}
    </Text>
  );
}

export function collapseIndicatorForRow(row: DisplayRow, collapsed: boolean): { glyph: "▸" | "▾"; color: string } | undefined {
  if (!row.isHeader) return undefined;
  return {
    glyph: collapsed ? "▸" : "▾",
    color: styleForKind(row.irNode.kind).color
  };
}
