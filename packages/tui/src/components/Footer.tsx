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
      ? "j/k line  ·  u/d half-page  ·  y copy"
      : "j/k select  ·  g/G top/bottom  ·  Space fold";
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
          {nav}  ·  h/l graph/details  ·  p pause run  ·  r resume run  ·  c cancel run  ·  R retry  ·  q quit
        </Text>
      </Box>
    </Box>
  );
}
