import React from "react";
import { Box, Text } from "ink";

/** Bottom bar: keybinding hints + last action result / error toast. */
export function Footer({ toast, isError, awaiting }: { toast?: string; isError?: boolean; awaiting?: boolean }): React.ReactElement {
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
          ↑/↓ select/scroll  ·  Tab graph/details  ·  p pause  ·  r resume  ·  c cancel  ·  R retry  ·  q quit
        </Text>
      </Box>
    </Box>
  );
}
