import { describe, expect, it } from "vitest";
import { inspectionChanges } from "../src/inspection/use-cases.js";
import type { InspectionTreeEntry, InspectionView } from "../src/inspection/types.js";
import type { RunDetails } from "../src/store/store.js";

describe("coherent inspection change selection", () => {
  it("retains repeated-target count changes and meaningful composite transitions", () => {
    const targetBefore = targetView({ total: 3, completed: 1, awaiting: 2 });
    const targetAfter = targetView({ total: 3, completed: 2, awaiting: 1 });

    expect(inspectionChanges(targetBefore, targetAfter, [], run())).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ label: "review" }), state: { status: "mixed" } }),
    ]);

    expect(inspectionChanges(
      runView("running", 0, "running"),
      runView("completed", 1, "completed"),
      [],
      run(),
    )).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ label: "batch", selector: "batch" }), state: { status: "completed" } }),
    ]);

    expect(inspectionChanges(
      runView("running", 0, "running"),
      runView("failed", 0, "completed"),
      [],
      run(),
    )).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ label: "batch", selector: "batch" }), state: { status: "failed" } }),
      expect.objectContaining({ subject: expect.objectContaining({ label: "review", selector: "review" }), state: { status: "completed" } }),
    ]);

    expect(inspectionChanges(
      runView("running", 0, "running"),
      runView("running", 1, "completed"),
      [],
      run(),
    )).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ label: "review", selector: "review" }), state: { status: "completed" } }),
    ]);
  });

  it("reports a completed repeat region when visible occurrences coalesce into a fold", () => {
    const before = treeView([item("round 1", "loop_iteration", "@111111111111", "completed"), item("round 2", "loop_iteration", "@222222222222", "running")]);
    const after = treeView([{
      type: "fold",
      scope: "loop-rounds",
      range: { start: 1, end: 2 },
      count: 2,
      state: { status: "completed" },
      children: [],
    }]);

    expect(inspectionChanges(before, after, [], run())).toEqual([{
      subject: { label: "rounds 1–2", kind: "loop-rounds" },
      state: { status: "completed" },
      progress: { completed: 2, total: 2 },
    }]);
  });

  it("reports each distinct state when a repeat fold splits around a failure", () => {
    const before = treeView([{
      type: "fold",
      scope: "fanout-items",
      range: { start: 0, end: 1 },
      count: 2,
      state: { status: "running" },
      children: [],
    }]);
    const after = treeView([
      item("item[0]", "fanout_item", "@000000000000", "running"),
      {
        ...item("item[1]", "fanout_item", "@111111111111", "failed"),
        state: {
          status: "failed",
          failure: { origin: "runtime", message: "Review failed." },
        },
        attention: { kind: "failure", summary: "Review failed." },
      },
    ]);

    expect(inspectionChanges(before, after, [], run())).toEqual([
      { subject: { label: "item[0]", kind: "fanout_item", selector: "@000000000000" }, state: { status: "running" } },
      {
        subject: { label: "item[1]", kind: "fanout_item", selector: "@111111111111" },
        state: { status: "failed", failure: { origin: "runtime", message: "Review failed." } },
      },
    ]);
  });

  it("reports the selected work rather than removed branch structure", () => {
    const before = treeView([{
      ...item("route", "if", "route", "running"),
      children: [
        item("then", "branch", undefined, "not_started"),
        item("else", "branch", undefined, "not_started"),
      ],
    }]);
    const after = treeView([item("review", "agent", "@abcdefabcdef", "running")]);

    expect(inspectionChanges(before, after, [], run())).toEqual([
      { subject: { label: "review", kind: "agent", selector: "@abcdefabcdef" }, state: { status: "running" } },
    ]);
  });
});

function treeView(children: InspectionTreeEntry[]): Extract<InspectionView, { kind: "run" }> {
  return {
    kind: "run",
    run: { id: "run", name: "workflow", status: "running" },
    counts: { total: 2 },
    tree: [{
      type: "item",
      subject: { label: "batch", kind: "fanout", selector: "batch" },
      state: { status: "running" },
      children,
    }],
  };
}

function item(
  label: string,
  kind: string,
  selector: string | undefined,
  status: Extract<InspectionTreeEntry, { type: "item" }>["state"]["status"],
): Extract<InspectionTreeEntry, { type: "item" }> {
  return {
    type: "item",
    subject: { label, kind, ...(selector ? { selector } : {}) },
    state: { status },
    children: [],
  };
}

function targetView(occurrences: { total: number; completed: number; awaiting: number }): Extract<InspectionView, { kind: "target"; detail: "summary" }> {
  return {
    kind: "target",
    detail: "summary",
    run: { id: "run", status: "running" },
    subject: { label: "review", kind: "agent" },
    state: { status: "mixed" },
    occurrences,
  };
}

function runView(
  batchStatus: "running" | "completed" | "failed",
  completed: number,
  reviewStatus: "running" | "completed" | "failed",
): Extract<InspectionView, { kind: "run" }> {
  return {
    kind: "run",
    run: { id: "run", name: "workflow", status: "running" },
    counts: { total: 1 },
    tree: [{
      type: "item",
      subject: { label: "batch", kind: "fanout", selector: "batch" },
      state: { status: batchStatus },
      progress: { completed, total: 1 },
      children: [{
        type: "item",
        subject: { label: "review", kind: "agent", selector: "review" },
        state: { status: reviewStatus },
        children: [],
      }],
    }],
  };
}

function run(): RunDetails {
  return {
    id: "run",
    name: "workflow",
    status: "running",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "sha256:test",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 0,
    nodeCount: 0,
    execution: { state: "inactive", lastStatus: "running" },
  };
}
