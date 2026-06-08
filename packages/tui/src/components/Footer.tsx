import React from "react";
import { Box, Text } from "ink";

/** Bottom bar: keybinding hints (vary by focused pane) + last action toast. */
export function Footer({
  toast,
  isError,
  awaiting,
  focus = "graph"
}: {
  toast?: string;
  isError?: boolean;
  awaiting?: boolean;
  focus?: "graph" | "details";
}): React.ReactElement {
  const nav =
    focus === "details"
      ? "u/d scroll  ·  ↵ expand"
      : "↑(k)/↓(j) select";
  return (
    <Box flexDirection="column">
      {toast ? (
        <Box>
          <Text color={isError ? "red" : "green"}>{toast}</Text>
        </Box>
      ) : null}
      {awaiting ? (
        <Box>
          <Text color="blue">a approve  ·  x reject  (selected gate is awaiting a decision)</Text>
        </Box>
      ) : null}
      <Box>
        <Text color="gray">
          {nav}  ·  Tab graph/details  ·  p pause  ·  r resume  ·  c cancel  ·  R retry  ·  q quit
        </Text>
      </Box>
    </Box>
  );
}
