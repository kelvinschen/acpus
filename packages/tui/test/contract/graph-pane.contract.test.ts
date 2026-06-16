import React from "react";
import { describe, expect, it } from "vitest";
import type { DisplayRow } from "../../src/model.js";
import { GraphRow, collapseIndicatorForRow } from "../../src/components/GraphPane.js";

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
    expect(text).toContain("▷ switch_alpha_agent ✦ [case_1]");
    expect(text).not.toContain("▷ ✦ switch_alpha_agent");
    expect(text).not.toContain("«case_1»");
    expect(text).not.toContain("[AGENT]");
    expect(text).not.toContain("↺2");
  });

  it("renders guard kind symbols after the node name", () => {
    const row: DisplayRow = {
      rowKey: "guard",
      irNode: {
        id: "check",
        kind: "guard",
        nodePath: ["workflow", "check"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/check" },
        metadata: { when: "input.ok", then: "continue", else: "fail" }
      },
      depth: 1,
      instance: {
        nodeKey: "workflow/check",
        nodeId: "check",
        kind: "guard",
        state: "completed",
        attempt: 1
      },
      state: "completed",
      label: "check",
      isHeader: false,
      nodeKey: "workflow/check",
      treeSegments: [{ text: "└─ ", ownerKind: "pipeline" }]
    };

    const text = collectText(GraphRow({ row, selected: false }));
    expect(text).toContain("✓ check ◈");
    expect(text).not.toContain("✓ ◈ check");
  });

  it("renders program kind symbols as command markers", () => {
    const row: DisplayRow = {
      rowKey: "program",
      irNode: {
        id: "collect",
        kind: "run.program",
        nodePath: ["workflow", "collect"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/collect" },
        metadata: {}
      },
      depth: 0,
      state: "completed",
      label: "collect",
      isHeader: false,
      treeSegments: []
    };

    const text = collectText(GraphRow({ row, selected: false }));
    expect(text).toContain("✓ collect $");
    expect(text).not.toContain("✓ collect ▸");
  });

  it("renders colored disclosure indicators for collapsible graph rows", () => {
    const row: DisplayRow = {
      rowKey: "parallel",
      irNode: {
        id: "parallel",
        kind: "parallel",
        nodePath: ["workflow", "parallel"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/parallel" },
        metadata: {}
      },
      depth: 0,
      state: "completed",
      label: "parallel",
      isHeader: true,
      treeSegments: []
    };

    expect(collapseIndicatorForRow(row, false)).toEqual({ glyph: "▾", color: "blueBright" });
    expect(collapseIndicatorForRow(row, true)).toEqual({ glyph: "▸", color: "blueBright" });
    expect(collectText(GraphRow({ row, selected: false, collapsed: false }))).toContain("✓ parallel ▥ ▾");
    expect(collectText(GraphRow({ row, selected: false, collapsed: true }))).toContain("✓ parallel ▥ ▸");
  });

  it("does not render disclosure indicators for leaf graph rows", () => {
    const row: DisplayRow = {
      rowKey: "agent",
      irNode: {
        id: "agent",
        kind: "run.agent",
        nodePath: ["workflow", "agent"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/agent" },
        metadata: {}
      },
      depth: 0,
      state: "completed",
      label: "agent",
      isHeader: false,
      treeSegments: []
    };

    expect(collapseIndicatorForRow(row, false)).toBeUndefined();
    expect(collectText(GraphRow({ row, selected: false }))).toContain("✓ agent ✦");
    expect(collectText(GraphRow({ row, selected: false }))).not.toContain("▾");
  });
});
