import React from "react";
import { Box, Text } from "ink";

/** Bottom bar: keybinding hints only; dynamic messages live in StatusOverview. */
export function Footer({
  focus = "graph"
}: {
  focus?: "graph" | "details";
}): React.ReactElement {
  const nav =
    focus === "details"
      ? "j/k line  ·  u/d half-page  ·  y copy"
      : "j/k select  ·  g/G top/bottom  ·  Space fold";
  return (
    <Box>
      <Text color="gray">
        {nav}  ·  h/l graph/details  ·  p pause run  ·  r resume run  ·  c cancel run  ·  R retry  ·  q quit
      </Text>
    </Box>
  );
}
