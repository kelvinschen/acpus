import React from "react";
import { Box, Text } from "ink";
import { acpusInkUiTheme, type InkUiTheme } from "./theme.js";

export interface KeyHintItem {
  key: string;
  label: string;
}

export function KeyHint({
  keys,
  theme = acpusInkUiTheme
}: {
  keys: KeyHintItem[];
  theme?: InkUiTheme;
}): React.ReactElement {
  return (
    <Box gap={2}>
      {keys.map(({ key, label }) => (
        <Box key={`${key}:${label}`} gap={1}>
          <Text bold color={theme.colors.text}>
            [{key}]
          </Text>
          <Text color={theme.colors.muted}>{label}</Text>
        </Box>
      ))}
    </Box>
  );
}
