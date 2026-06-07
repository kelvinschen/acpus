import React from "react";
import { Box, Text } from "ink";

/** Bottom bar: keybinding hints + last action result / error toast. */
export function Footer({ toast, isError }: { toast?: string; isError?: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {toast ? (
        <Box>
          <Text color={isError ? "red" : "green"}>{toast}</Text>
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
