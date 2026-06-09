import { describe, it, expect } from "vitest";
import { offsetWindow, buildDetailLines, formatDetailLinesPlainText } from "../src/components/DetailsPane.js";
import type { DisplayRow } from "../src/model.js";
import type { IrNode } from "@acpus/core";

// ─── offsetWindow tests ─────────────────────────────────────────

describe("offsetWindow", () => {
  it("returns full range when content fits in viewport", () => {
    const result = offsetWindow(5, 0, 10);
    expect(result).toEqual({ start: 0, end: 5, moreAbove: 0, moreBelow: 0 });
  });

  it("starts at scrollOffset 0 when at top", () => {
    // 20 lines, viewport 5, scrollOffset 0 → lines 0..4
    const result = offsetWindow(20, 0, 5);
    expect(result).toEqual({ start: 0, end: 5, moreAbove: 0, moreBelow: 15 });
  });

  it("scrolls one line per offset increment", () => {
    // scrollOffset 1 → lines 1..5 (NOT 0..4 like windowSlice would give)
    const result = offsetWindow(20, 1, 5);
    expect(result).toEqual({ start: 1, end: 6, moreAbove: 1, moreBelow: 14 });
  });

  it("scrolls to the bottom at max offset", () => {
    // 20 lines, viewport 5: maxOffset = 15 → lines 15..19
    const result = offsetWindow(20, 15, 5);
    expect(result).toEqual({ start: 15, end: 20, moreAbove: 15, moreBelow: 0 });
  });

  it("clamps scrollOffset beyond max", () => {
    // scrollOffset 100 with only 20 lines and viewport 5 → clamped to 15
    const result = offsetWindow(20, 100, 5);
    expect(result).toEqual({ start: 15, end: 20, moreAbove: 15, moreBelow: 0 });
  });

  it("clamps negative scrollOffset to 0", () => {
    const result = offsetWindow(20, -3, 5);
    expect(result).toEqual({ start: 0, end: 5, moreAbove: 0, moreBelow: 15 });
  });

  it("handles zero-length content", () => {
    const result = offsetWindow(0, 0, 5);
    expect(result).toEqual({ start: 0, end: 0, moreAbove: 0, moreBelow: 0 });
  });

  it("computes moreAbove and moreBelow correctly at mid-scroll", () => {
    // 30 lines, viewport 8, scrollOffset 10 → lines 10..17
    const result = offsetWindow(30, 10, 8);
    expect(result).toEqual({ start: 10, end: 18, moreAbove: 10, moreBelow: 12 });
  });
});

// ─── buildDetailLines tests ─────────────────────────────────────

function makeRow(overrides: Partial<DisplayRow> = {}): DisplayRow {
  const irNode: IrNode = {
    id: "test-node",
    kind: "run.agent",
    nodePath: ["workflow", "test-node"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/test-node" },
    metadata: {}
  };
  return {
    rowKey: "test-key",
    irNode,
    label: "test-node",
    state: "completed",
    depth: 0,
    treeSegments: [],
    groupDim: undefined,
    groupValue: undefined,
    groupItem: undefined,
    branchLabel: undefined,
    branchWhen: undefined,
    summary: undefined,
    nodeKey: undefined,
    instance: undefined,
    ...overrides
  };
}

describe("buildDetailLines", () => {
  it("returns empty array for undefined row", () => {
    expect(buildDetailLines(undefined, 40, {})).toEqual([]);
  });

  it("produces at least one line for a minimal row", () => {
    const lines = buildDetailLines(makeRow(), 40, {});
    expect(lines.length).toBeGreaterThan(0);
  });

  it("includes runtime info fields", () => {
    const lines = buildDetailLines(makeRow(), 60, {});
    const text = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("Node:");
    expect(text).toContain("Kind:");
    expect(text).toContain("Status:");
  });

  it("shows error lines when instance has an error", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "failed",
        attempt: 1,
        error: "something went wrong"
      }
    });
    const lines = buildDetailLines(row, 60, {});
    const text = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("Error:");
    expect(text).toContain("something went wrong");
  });

  it("shows output lines when instance has output", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: { result: 42 }
      }
    });
    const lines = buildDetailLines(row, 60, {});
    const text = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("Output:");
  });

  it("exposes enough lines that scrolling is needed for long content", () => {
    // Build a row with a long prompt to produce many wrapped lines.
    const irNode: IrNode = {
      id: "long-agent",
      kind: "run.agent",
      nodePath: ["workflow", "long-agent"],
      keyTemplate: { astVersion: 1, nodePath: "workflow/long-agent" },
      metadata: { prompt: "line\n".repeat(30) }
    };
    const row = makeRow({
      irNode,
      instance: {
        nodeKey: "workflow/long-agent",
        nodeId: "long-agent",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: { text: "result\n".repeat(20) }
      }
    });
    const lines = buildDetailLines(row, 40, {});
    // Should have enough lines to require scrolling in a typical pane.
    expect(lines.length).toBeGreaterThan(20);
  });

  it("wraps long node keys instead of truncating them", () => {
    const row = makeRow({
      nodeKey: "workflow/fanout_parallel_loop_switch/lane_parallel/loop_lane/round:1234567890/loop_agent"
    });
    const lines = buildDetailLines(row, 40, {});
    const text = formatDetailLinesPlainText(lines);
    expect(text).toContain("Key: workflow/fanout_parallel_");
    expect(text).toContain("round:1234567890");
    expect(text).not.toContain("…");
  });

  it("links artifact filenames but keeps absolute paths as plain wrapped text", () => {
    const uri = "artifact://runs/run-1/nodes/workflow:test/attempt-001.prompt.md";
    const absPath = "/Users/bytedance/KProjects/acpus_alpha/.acpus/runs/run-1/artifacts/workflow:test/attempt-001.prompt.md";
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        artifactRefs: [uri]
      }
    });

    const lines = buildDetailLines(row, 44, { [uri]: absPath });
    const filename = lines.find((line) => line.segments.some((seg) => seg.text === "attempt-001.prompt.md"));
    expect(filename?.segments[0]?.href).toBe("file:///Users/bytedance/KProjects/acpus_alpha/.acpus/runs/run-1/artifacts/workflow:test/attempt-001.prompt.md");

    const plain = formatDetailLinesPlainText(lines);
    expect(plain).toContain("attempt-001.prompt.md");
    expect(plain).toContain("/Users/bytedance/KProjects");
    expect(plain).not.toContain("\u001b]8");
  });
});
