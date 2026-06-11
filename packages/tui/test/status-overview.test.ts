import React from "react";
import { describe, expect, it } from "vitest";
import { StatusOverview } from "../src/components/StatusOverview.js";
import { STATE_STYLES } from "../src/theme.js";

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement<{ children?: unknown }>(node)) return collectText(node.props.children);
  return "";
}

describe("StatusOverview", () => {
  it("uses an ASCII paused glyph so browser terminal renderers do not disagree on width", () => {
    expect(STATE_STYLES.paused.glyph).toBe("=");
  });

  it("renders state legend, node-kind legend, and overview messages", () => {
    const element = StatusOverview({
      counts: {
        pending: 1,
        running: 2,
        awaiting: 0,
        completed: 3,
        failed: 1,
        paused: 0,
        cancelled: 0,
        total: 7
      },
      messages: [
        { text: "pause run -> paused", level: "info" },
        { text: "Cannot resume a failed run", level: "error" }
      ]
    });

    const text = collectText(element);
    expect(text).toContain("STATUS OVERVIEW");
    expect(text).toContain("Running");
    expect(text).toContain("Node Types");
    expect(text).toContain("◉ Agent");
    expect(text).toContain("$ Program");
    expect(text).toContain("◇ Switch");
    expect(text).toContain("◈ Guard");
    expect(text).toContain("Messages");
    expect(text).toContain("pause run -> paused");
    expect(text).toContain("Cannot resume a failed run");
  });
});
