import React from "react";
import { describe, expect, it } from "vitest";
import type { DisplayRow } from "../src/model.js";
import { GraphRow } from "../src/components/GraphPane.js";

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement<{ children?: unknown }>(node)) return collectText(node.props.children);
  return "";
}

describe("GraphRow", () => {
  it("renders kind symbols, bracket branch labels, and no per-node attempt marker", () => {
    const row: DisplayRow = {
      rowKey: "row",
      irNode: {
        id: "switch_alpha_agent",
        kind: "run.agent",
        nodePath: ["workflow", "switch_alpha_agent"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/switch_alpha_agent" },
        metadata: {}
      },
      depth: 1,
      instance: {
        nodeKey: "workflow/switch_alpha_agent",
        nodeId: "switch_alpha_agent",
        kind: "run.agent",
        state: "running",
        attempt: 2
      },
      state: "running",
      label: "switch_alpha_agent",
      isHeader: false,
      nodeKey: "workflow/switch_alpha_agent",
      branchLabel: "case_1",
      treeSegments: [{ text: "└─ ", ownerKind: "switch" }]
    };

    const text = collectText(GraphRow({ row, selected: false }));
    expect(text).toContain("▷ switch_alpha_agent ◉ [case_1]");
    expect(text).not.toContain("▷ ◉ switch_alpha_agent");
    expect(text).not.toContain("«case_1»");
    expect(text).not.toContain("[AGENT]");
    expect(text).not.toContain("↺2");
  });
});
