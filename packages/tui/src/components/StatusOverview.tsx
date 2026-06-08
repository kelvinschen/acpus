import React from "react";
import { Box, Text } from "ink";
import type { NodeState } from "@acpus/runtime";
import { STATE_STYLES } from "../theme.js";

/**
 * Left pane: aggregate dashboard. Total + per-state counts (always all 7 states,
 * so it doubles as the legend) + overall progress bar. Counts use the runtime
 * instance basis (fanout lanes / loop rounds each count once); Total == sum of
 * the 7 state counts, so the three numbers are always self-consistent.
 */
export function StatusOverview({
  counts,
  height
}: {
  counts: Record<NodeState, number> & { total: number };
  height?: number;
}): React.ReactElement {
  const done = counts.completed;
  const total = counts.total || 1;
  const pct = Math.round((done / total) * 100);
  const barWidth = 18;
  const filled = Math.round((done / total) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      width={26}
      height={height}
      overflow="hidden"
    >
      <Text bold color="magenta">
        STATUS OVERVIEW
      </Text>

      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray">Total Nodes</Text>
        <Text bold>{counts.total}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {(Object.keys(STATE_STYLES) as NodeState[]).map((s) => (
          <Box key={s} justifyContent="space-between">
            <Text color={STATE_STYLES[s].color}>
              {STATE_STYLES[s].glyph} {STATE_STYLES[s].label}
            </Text>
            <Text color={STATE_STYLES[s].color}>{counts[s]}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text color="gray">Overall Progress</Text>
          <Text color="green">{pct}%</Text>
        </Box>
        <Text color="green">[{bar}]</Text>
        <Text color="gray">
          {done} / {counts.total} completed
        </Text>
      </Box>
    </Box>
  );
}
