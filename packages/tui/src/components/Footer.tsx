import React from "react";
import { Box } from "ink";
import { KeyHint, type KeyHintItem } from "../ui/inkui/index.js";

/** Bottom bar: keybinding hints only; dynamic messages live in StatusOverview. */
export function Footer({
  focus = "graph",
  tabCount = 0
}: {
  focus?: "graph" | "details";
  tabCount?: number;
}): React.ReactElement {
  const { nav, global } = footerHintGroups(focus, tabCount);
  return (
    <Box flexDirection="column">
      <KeyHint keys={nav} />
      <KeyHint keys={global} />
    </Box>
  );
}

export function footerHintGroups(
  focus: "graph" | "details" = "graph",
  tabCount = 0
): { nav: KeyHintItem[]; global: KeyHintItem[] } {
  const nav: KeyHintItem[] = focus === "details"
    ? [
        { key: "j/k", label: "scroll" },
        { key: "u/d", label: "half-page" },
        { key: "Space", label: "expand" },
        ...(tabCount > 0 ? [{ key: "1-9", label: `tabs (${tabCount})` }] : []),
        { key: "y", label: "copy all" }
      ]
    : [
        { key: "j/k", label: "select" },
        { key: "g/G", label: "top/bottom" },
        { key: "Space", label: "fold" }
      ];
  const global: KeyHintItem[] = [
    { key: "h/l", label: "focus" },
    { key: "p", label: "pause" },
    { key: "r", label: "resume" },
    { key: "c", label: "cancel" },
    { key: "R", label: "retry" },
    { key: "a/x", label: "approve/reject" },
    { key: "q", label: "quit" }
  ];
  return { nav, global };
}
