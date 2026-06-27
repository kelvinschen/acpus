import React from "react";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import {
  KeyHint,
  ScrollArea,
  Tabs,
  clampInline,
  confirmSuffix,
  jsonExpandedIdsForInitialDepth,
  jsonRowDescriptors,
  jsonViewerRows,
  markdownRows,
  scrollAreaMetrics,
  scrollbarMetrics,
  spinnerFrame,
  wrapText
} from "../../src/ui/inkui/index.js";

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement<{ children?: unknown }>(node)) return collectText(node.props.children);
  return "";
}

describe("InkUI-adapted components", () => {
  it("computes controlled ScrollArea bounds", () => {
    expect(scrollAreaMetrics(3, 5, 0)).toEqual({ start: 0, end: 3, moreAbove: 0, moreBelow: 0, maxOffset: 0 });
    expect(scrollAreaMetrics(20, 5, 100)).toEqual({ start: 15, end: 20, moreAbove: 15, moreBelow: 0, maxOffset: 15 });
  });

  it("computes scrollbar metrics for exact-fit and overflowing content", () => {
    expect(scrollbarMetrics(5, 5, 0)).toEqual({ show: false, thumbSize: 5, thumbPos: 0 });
    expect(scrollbarMetrics(6, 5, 1)).toEqual({ show: true, thumbSize: 4, thumbPos: 1 });
    expect(scrollbarMetrics(100, 10, 45)).toEqual({ show: true, thumbSize: 1, thumbPos: 4 });
  });

  it("renders controlled ScrollArea slices and scrollbars", () => {
    const rows = Array.from({ length: 6 }, (_, i) => React.createElement(Text, { key: i }, `Line ${i + 1}`));
    const text = collectText(ScrollArea({ height: 3, offset: 2, children: rows }));
    expect(text).toContain("Line 3");
    expect(text).toContain("Line 5");
    expect(text).not.toContain("Line 1");
    expect(text).toContain("█");
  });

  it("can pin the ScrollArea scrollbar to a fixed content width", () => {
    const rows = Array.from({ length: 6 }, (_, i) => React.createElement(Text, { key: i }, `Line ${i + 1}`));
    const area = ScrollArea({ height: 3, width: 20, offset: 2, children: rows });
    expect(area.props.width).toBe(20);
    expect(area.props.children[0].props.width).toBe(19);
    expect(area.props.children[1].props.width).toBe(1);
  });

  it("renders plain Markdown paragraphs as direct text so Ink does not drop the first glyph", () => {
    const first = markdownRows("Continue the previous task from where you left off.", 80)[0];
    expect(first.props.children).toEqual(["Continue the previous task from where you left off."]);
  });

  it("renders ScrollArea empty content and suppresses disabled scrollbars", () => {
    const emptyText = collectText(ScrollArea({ height: 3, children: [], empty: React.createElement(Text, {}, "Empty") }));
    expect(emptyText).toContain("Empty");
    const rows = Array.from({ length: 6 }, (_, i) => React.createElement(Text, { key: i }, `Line ${i + 1}`));
    const text = collectText(ScrollArea({ height: 3, offset: 1, scrollbar: false, children: rows }));
    expect(text).not.toContain("█");
    expect(text).not.toContain("░");
  });

  it("renders grouped key hints", () => {
    const text = collectText(KeyHint({
      keys: [{ key: "j/k", label: "scroll" }, { key: "y", label: "copy all" }]
    }));
    expect(text).toContain("[j/k]");
    expect(text).toContain("scroll");
    expect(text).toContain("[y]");
    expect(text).toContain("copy all");
  });

  it("renders confirmation default hints", () => {
    expect(confirmSuffix(false)).toBe("(y/N)");
    expect(confirmSuffix(true)).toBe("(Y/n)");
  });

  it("renders spinner as inline text suitable for top bars", () => {
    expect(spinnerFrame("dots", 0, false)).toBe("■");
    expect(spinnerFrame("line", 1, true)).toBe("\\");
  });

  it("renders no tab bar for empty tab sets", () => {
    expect(Tabs({ tabs: [], activeKey: "", width: 40 })).toBeNull();
  });

  it("turns Markdown prompts into structured terminal rows", () => {
    const text = collectText(markdownRows("## Prompt\n- **review** `output`\n  1. nested", 40));
    expect(text).toContain("Prompt");
    expect(text).toContain("• ");
    expect(text).toContain("  1. ");
    expect(text).toContain("review");
    expect(text).toContain("output");
  });

  it("uses stable Markdown keys for the same source lines across widths", () => {
    const source = "```ts\nconst value = 1234567890;\n```\n> quoted text";
    const narrowKeys = markdownRows(source, 12).map((row) => row.key);
    const wideKeys = markdownRows(source, 80).map((row) => row.key);
    expect(new Set(narrowKeys)).toContain("fence-0");
    expect(new Set(wideKeys)).toContain("fence-0");
    expect(new Set(narrowKeys)).toContain("code-1-0");
    expect(new Set(wideKeys)).toContain("code-1-0");
    expect(new Set(narrowKeys)).toContain("quote-3-0");
    expect(new Set(wideKeys)).toContain("quote-3-0");
  });

  it("turns JSON output into expandable-looking structured rows", () => {
    const text = collectText(jsonViewerRows({ result: 42, nested: { ok: true } }, 80, { initialDepth: 3 }));
    expect(text).toContain("▾ root {2}");
    expect(text).toContain("result: 42");
    expect(text).toContain("nested {1}");
    expect(text).toContain("ok: true");
  });

  it("can label the synthetic JSON root distinctly from data fields", () => {
    const text = collectText(jsonViewerRows({ output: { ok: true } }, 80, { rootLabel: "root", initialDepth: 3 }));
    expect(text).toContain("▾ root {1}");
    expect(text).toContain("output {1}");
  });

  it("renders JSON output from controlled expansion state", () => {
    const data = { nested: { deep: { ok: true } } };
    const initial = jsonExpandedIdsForInitialDepth(data, { initialDepth: 1 });
    expect([...initial].sort()).toEqual(["root"]);

    const collapsedText = jsonRowDescriptors(data, { expandedIds: initial }).map((row) => row.text).join("\n");
    expect(collapsedText).toContain("▸ nested {1}");
    expect(collapsedText).not.toContain("ok: true");

    const expandedText = jsonRowDescriptors(data, {
      expandedIds: new Set([...initial, "root.nested", "root.nested.deep"])
    }).map((row) => row.text).join("\n");
    expect(expandedText).toContain("▾ nested {1}");
    expect(expandedText).toContain("ok: true");
  });

  it("guards JSON output against circular references", () => {
    const circular: { name: string; self?: unknown } = { name: "node" };
    circular.self = circular;
    const text = collectText(jsonViewerRows(circular, 80, { initialDepth: 3 }));
    expect(text).toContain("self: [circular]");
  });

  it("wraps text at very narrow widths", () => {
    expect(wrapText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(wrapText("aa/bb cc", 4)).toEqual(["aa/", "bb ", "cc"]);
    expect(clampInline("abc", 1)).toBe("…");
  });
});
