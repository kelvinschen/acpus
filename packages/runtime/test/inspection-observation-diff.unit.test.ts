import { describe, expect, it } from "vitest";
import { inspectionChanges } from "../src/inspection/use-cases.js";
import type { InspectionView } from "../src/inspection/types.js";
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
});

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
