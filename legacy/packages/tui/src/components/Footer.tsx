import React from "react";
import { Box } from "ink";
import { KeyHint, type KeyHintItem } from "../ui/inkui/index.js";
import { CONTROL_KEY_TO_ACTION } from "../controls.js";

/** Bottom bar: keybinding hints only; dynamic messages live in StatusOverview. */
export function Footer({
  focus = "graph",
  tabCount = 0,
  readOnly = false
}: {
  focus?: "graph" | "details";
  tabCount?: number;
  readOnly?: boolean;
}): React.ReactElement {
  const { nav, global } = footerHintGroups(focus, tabCount, readOnly);
  return (
    <Box flexDirection="column">
      <KeyHint keys={nav} />
      <KeyHint keys={global} />
    </Box>
  );
}

export function footerHintGroups(
  focus: "graph" | "details" = "graph",
  tabCount = 0,
  readOnly = false
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
  const global: KeyHintItem[] = readOnly
    ? [
        { key: "h/l", label: "focus" },
        { key: "read-only", label: "controls disabled" },
        { key: "Esc", label: "back" },
        { key: "q", label: "quit" }
      ]
    : [
        { key: "h/l", label: "focus" },
        { key: controlKeyForAction("pause"), label: "pause" },
        { key: controlKeyForAction("resume"), label: "resume" },
        { key: controlKeyForAction("cancel"), label: "cancel" },
        { key: controlKeyForAction("retry"), label: "retry" },
        { key: controlKeyForAction("signal"), label: "signal" },
        { key: "Esc", label: "back" },
        { key: "q", label: "quit" }
      ];
  return { nav, global };
}

function controlKeyForAction(action: string): string {
  const entry = Object.entries(CONTROL_KEY_TO_ACTION).find(([, value]) => value === action);
  return entry?.[0] ?? "";
}
