import { describe, it, expect } from "vitest";
import {
  buildDetailLines,
  buildDetailSections,
  detailContentRows,
  detailSectionRowCount,
  formatDetailLinesPlainText
} from "../src/components/DetailsPane.js";
import type { DisplayRow } from "../src/model.js";
import type { IrNode } from "@acpus/core";

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

  it("splits details into task-focused sections with rich prompt and output content", () => {
    const row = makeRow({
      irNode: {
        id: "test-node",
        kind: "run.agent",
        nodePath: ["workflow", "test-node"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/test-node" },
        metadata: { prompt: "## Review\n- item" }
      },
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: { result: 42, nested: { ok: true } }
      }
    });

    const sections = buildDetailSections(row, 60, {});
    expect(sections.map((section) => section.key)).toEqual([
      "summary",
      "definition",
      "prompt",
      "output"
    ]);
    expect(sections.find((section) => section.key === "prompt")?.richContent).toEqual({
      kind: "markdown",
      content: "## Review\n- item"
    });
    expect(sections.find((section) => section.key === "output")?.richContent).toEqual({
      kind: "json",
      data: { result: 42, nested: { ok: true } }
    });
  });

  it("keeps Markdown prompt and JSON output useful in plain copied details", () => {
    const row = makeRow({
      irNode: {
        id: "test-node",
        kind: "run.agent",
        nodePath: ["workflow", "test-node"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/test-node" },
        metadata: { prompt: "## Review\n- check `json`" }
      },
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: { result: 42, nested: { ok: true } }
      }
    });

    const text = formatDetailLinesPlainText(buildDetailLines(row, 80, {}));
    expect(text).toContain("Prompt:");
    expect(text).toContain("## Review");
    expect(text).toContain("- check `json`");
    expect(text).toContain("Output:");
    expect(text).toContain("\"result\": 42");
    expect(text).toContain("\"ok\": true");
    expect(text).not.toContain("\u001b[");
  });

  it("preserves persisted output envelopes in the Output tab", () => {
    const agentRow = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: {
          output: { report_path: "/tmp/report.md", top_findings: [] },
          exit_code: 0
        }
      }
    });

    const parallelRow = makeRow({
      irNode: {
        id: "parallel-node",
        kind: "parallel",
        nodePath: ["workflow", "parallel-node"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/parallel-node" },
        metadata: {}
      },
      label: "parallel-node",
      instance: {
        nodeKey: "workflow/parallel-node",
        nodeId: "parallel-node",
        kind: "parallel",
        state: "completed",
        attempt: 1,
        output: {
          output: {
            contract: { report_path: "/tmp/contract.md" },
            correctness: { blocking_count: 0 }
          }
        }
      }
    });

    const agentOutput = buildDetailSections(agentRow, 80, {}).find((section) => section.key === "output");
    expect(agentOutput?.richContent).toEqual({
      kind: "json",
      data: {
        output: { report_path: "/tmp/report.md", top_findings: [] },
        exit_code: 0
      }
    });
    expect(formatDetailLinesPlainText(agentOutput?.lines ?? [])).toContain("\"output\":");
    expect(formatDetailLinesPlainText(agentOutput?.lines ?? [])).toContain("\"exit_code\": 0");

    const parallelOutput = buildDetailSections(parallelRow, 80, {}).find((section) => section.key === "output");
    expect(parallelOutput?.richContent).toEqual({
      kind: "json",
      data: {
        output: {
          contract: { report_path: "/tmp/contract.md" },
          correctness: { blocking_count: 0 }
        }
      }
    });
    expect(formatDetailLinesPlainText(parallelOutput?.lines ?? [])).toContain("\"output\":");
  });

  it("renders Guard definitions with wrapped conditions and optional message", () => {
    const longWhen = "input.changed_files.exists(path, path.endsWith('.ts') || path.endsWith('.tsx')) && steps.collect_context.output.has_changes";
    const row = makeRow({
      irNode: {
        id: "require_changed_files",
        kind: "guard",
        nodePath: ["workflow", "require_changed_files"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/require_changed_files" },
        metadata: {
          when: longWhen,
          then: "continue",
          else: "fail",
          message: "No TypeScript changes were detected."
        }
      },
      label: "require_changed_files",
      instance: {
        nodeKey: "workflow/require_changed_files",
        nodeId: "require_changed_files",
        kind: "guard",
        state: "completed",
        attempt: 1,
        output: { output: { matched: true, action: "continue" } }
      }
    });

    const sections = buildDetailSections(row, 44, {});
    const summaryText = formatDetailLinesPlainText(sections.find((section) => section.key === "summary")?.lines ?? []);
    const definitionText = formatDetailLinesPlainText(sections.find((section) => section.key === "definition")?.lines ?? []);

    expect(summaryText).not.toContain("When:");
    expect(definitionText).toContain("Definition:");
    expect(definitionText).toContain("  When:");
    expect(definitionText).toContain("input.changed_files.exists");
    expect(definitionText).toContain("steps.collect_context.output.has");
    expect(definitionText).toContain("_changes");
    expect(definitionText).toContain("  Then: continue");
    expect(definitionText).toContain("  Else: fail");
    expect(definitionText).toContain("  Message:");
    expect(definitionText).toContain("No TypeScript changes were");
    expect(definitionText).toContain("detected.");
    expect(definitionText).not.toContain("…");
  });

  it("omits Guard definition message when no message is declared", () => {
    const row = makeRow({
      irNode: {
        id: "check",
        kind: "guard",
        nodePath: ["workflow", "check"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/check" },
        metadata: {
          when: "true",
          then: "continue",
          else: "fail"
        }
      },
      label: "check"
    });

    const definitionText = formatDetailLinesPlainText(buildDetailSections(row, 80, {}).find((section) => section.key === "definition")?.lines ?? []);
    expect(definitionText).toContain("  When: true");
    expect(definitionText).toContain("  Then: continue");
    expect(definitionText).toContain("  Else: fail");
    expect(definitionText).not.toContain("Message:");
  });

  it("counts active detail section rows from rich renderers", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        output: { result: 42, nested: { ok: true } }
      }
    });

    const output = buildDetailSections(row, 40, {}).find((section) => section.key === "output");
    expect(detailContentRows(12)).toBe(7);
    expect(detailSectionRowCount(output, 40)).toBeGreaterThan(1);
  });

  it("renders agent execution details before prompt", () => {
    const row = makeRow({
      irNode: {
        id: "test-node",
        kind: "run.agent",
        nodePath: ["workflow", "test-node"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/test-node" },
        metadata: { prompt: "template" }
      },
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "running",
        attempt: 1,
        renderedPrompt: "rendered prompt"
      }
    });

    const text = formatDetailLinesPlainText(buildDetailLines(row, 80, {}, undefined, {
      outputTokenSource: "unknown",
      toolCallCount: 4,
      recentToolCalls: [
        { toolCallId: "call-1", title: "Read file", status: "completed", kind: "read", toolName: "Read" }
      ]
    }));

    expect(text).toContain("Execution:");
    expect(text).toContain("  Output tokens: unknown");
    expect(text).toContain("  Tool calls: 4");
    expect(text).toContain("completed Read file");
    expect(text.indexOf("Execution:")).toBeLessThan(text.indexOf("Prompt:"));
  });

  it("marks estimated agent output tokens", () => {
    const row = makeRow({
      irNode: {
        id: "test-node",
        kind: "run.agent",
        nodePath: ["workflow", "test-node"],
        keyTemplate: { astVersion: 1, nodePath: "workflow/test-node" },
        metadata: {}
      }
    });

    const text = formatDetailLinesPlainText(buildDetailLines(row, 80, {}, undefined, {
      outputTokens: 42,
      outputTokenSource: "estimated",
      toolCallCount: 0,
      recentToolCalls: []
    }));

    expect(text).toContain("  Output tokens: ~42");
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

  it("renders artifact filenames and absolute paths as plain wrapped text", () => {
    const uri = "artifact://runs/run-1/nodes/workflow:test/attempt-001.prompt.md";
    const absPath = "/Users/bytedance/KProjects/acpus_alpha/.acpus/state/runs/run-1/artifacts/workflow:test/attempt-001.prompt.md";
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
    expect(filename?.segments[0]).toEqual({ text: "attempt-001.prompt.md", color: "cyan" });

    const plain = formatDetailLinesPlainText(lines);
    expect(plain).toContain("attempt-001.prompt.md");
    expect(plain).toContain("/Users/bytedance/KProjects");
    expect(plain).not.toContain("\u001b]8");
  });

  it("keeps artifact filename and path adjacent while spacing separate artifacts", () => {
    const firstUri = "artifact://runs/run-1/nodes/workflow:test/attempt-001.prompt.md";
    const secondUri = "artifact://runs/run-1/nodes/workflow:test/attempt-001.response.md";
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "completed",
        attempt: 1,
        artifactRefs: [firstUri, secondUri]
      }
    });

    const lines = formatDetailLinesPlainText(buildDetailLines(row, 120, {
      [firstUri]: "/tmp/attempt-001.prompt.md",
      [secondUri]: "/tmp/attempt-001.response.md"
    })).split("\n");

    const firstName = lines.indexOf("attempt-001.prompt.md");
    const secondName = lines.indexOf("attempt-001.response.md");
    expect(lines[firstName + 1]).toBe("/tmp/attempt-001.prompt.md");
    expect(lines[secondName + 1]).toBe("/tmp/attempt-001.response.md");
    expect(lines[secondName - 1]).toBe("");
  });

  it("hides the internal paused abort reason from details", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "paused",
        attempt: 1,
        error: "Aborted: paused"
      }
    });
    const text = formatDetailLinesPlainText(buildDetailLines(row, 60, {}));
    expect(text).not.toContain("Error:");
    expect(text).not.toContain("Aborted: paused");
  });

  it("uses a frozen clock for open-ended durations", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "paused",
        attempt: 1,
        startedAt: "2026-06-09T00:00:00.000Z"
      }
    });
    const text = formatDetailLinesPlainText(buildDetailLines(row, 60, {}, "2026-06-09T00:00:07.000Z"));
    expect(text).toContain("Duration: 00:00:07");
  });

  it("uses the supplied render clock for running open-ended durations", () => {
    const row = makeRow({
      instance: {
        nodeKey: "workflow/test",
        nodeId: "test-node",
        kind: "run.agent",
        state: "running",
        attempt: 1,
        startedAt: "2026-06-09T00:00:00.000Z"
      }
    });
    const first = formatDetailLinesPlainText(buildDetailLines(row, 60, {}, Date.parse("2026-06-09T00:00:07.000Z")));
    const second = formatDetailLinesPlainText(buildDetailLines(row, 60, {}, Date.parse("2026-06-09T00:00:08.000Z")));
    expect(first).toContain("Duration: 00:00:07");
    expect(second).toContain("Duration: 00:00:08");
  });
});
