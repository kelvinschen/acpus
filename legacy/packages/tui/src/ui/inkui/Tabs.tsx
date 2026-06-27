import React from "react";
import { Box, Text } from "ink";
import { acpusInkUiTheme, clampInline, type InkUiTheme } from "./theme.js";

export interface TabItem {
  key: string;
  label: string;
  badge?: number;
}

export function Tabs({
  tabs,
  activeKey,
  width,
  theme = acpusInkUiTheme
}: {
  tabs: TabItem[];
  activeKey: string;
  width: number;
  theme?: InkUiTheme;
}): React.ReactElement | null {
  if (tabs.length === 0) return null;
  const maxLabel = Math.max(5, Math.floor(Math.max(20, width) / Math.max(1, tabs.length)) - 4);
  return (
    <Box flexDirection="row" gap={1} overflow="hidden">
      {tabs.map((tab, index) => {
        const active = tab.key === activeKey;
        const suffix = tab.badge !== undefined ? ` ${tab.badge}` : "";
        const label = clampInline(`${index + 1}:${tab.label}${suffix}`, maxLabel);
        return (
          <Text
            key={tab.key}
            bold={active}
            color={active ? theme.colors.textInverse : theme.colors.muted}
            backgroundColor={active ? theme.colors.selection : undefined}
          >
            {active ? ` ${label} ` : ` ${label} `}
          </Text>
        );
      })}
    </Box>
  );
}
