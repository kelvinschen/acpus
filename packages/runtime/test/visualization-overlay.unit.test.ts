import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { createWorkflowVisualizationOverlay } from "../src/visualization/overlay.js";

describe("workflow visualization overlay", () => {
  it("combines static node structure with dynamic runtime projection summaries", () => {
    const overlay = createWorkflowVisualizationOverlay(workflow(), {
      version: 9,
      frames: [
        { frameKey: "root", frameKind: "root", status: "running" },
        { frameKey: "approval", nodeId: "approval", frameKind: "node", status: "running", strategy: "all" },
        { frameKey: "approval.left", nodeId: "approval", frameKind: "branch", status: "running", strategy: "all" },
        { frameKey: "approval.right", nodeId: "approval", frameKind: "branch", status: "completed", strategy: "all" },
      ],
      nodeInstances: [
        { nodeKey: "left_approve", nodeId: "left_approve", status: "awaiting" },
        { nodeKey: "right_approve", nodeId: "right_approve", status: "completed", output: { ok: true } },
      ],
      attempts: [
        { attemptId: "attempt_prepare", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "completed" },
      ],
      groupMembers: [
        { groupKey: "approval", memberKey: "approval.left", memberKind: "branch", branchId: "left", status: "running" },
        { groupKey: "approval", memberKey: "approval.right", memberKind: "branch", branchId: "right", status: "completed" },
      ],
      signalWaits: [
        { nodeKey: "left_approve", nodeId: "left_approve", status: "awaiting" },
      ],
    }, { runId: "run_1", status: "awaiting" });

    expect(overlay.workflow).toEqual({ name: "overlay-test", runId: "run_1", status: "awaiting", dynamicVersion: 9 });
    expect(overlay.nodes.map(node => [node.nodeId, node.kind, node.path.join(" > "), node.status])).toEqual([
      ["prepare", "task", "root > prepare", "completed"],
      ["approval", "parallel", "root > approval", "running"],
      ["left_approve", "signal", "root > approval > branch:left > left_approve", "awaiting"],
      ["right_approve", "signal", "root > approval > branch:right > right_approve", "completed"],
    ]);
    expect(overlay.groups).toEqual([
      expect.objectContaining({
        nodeId: "approval",
        groupKey: "approval",
        kind: "parallel",
        status: "running",
        strategy: "all",
        members: expect.arrayContaining([
          expect.objectContaining({ memberKey: "approval.left" }),
          expect.objectContaining({ memberKey: "approval.right" }),
        ]),
      }),
    ]);
    expect(overlay.groups).toHaveLength(1);
  });

  it("keeps historical attempts from overriding the current node status", () => {
    const overlay = createWorkflowVisualizationOverlay(workflow(), {
      version: 10,
      frames: [],
      nodeInstances: [
        { nodeKey: "prepare", nodeId: "prepare", status: "completed", output: { ok: true } },
      ],
      attempts: [
        { attemptId: "attempt_failed", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "failed", error: { reason: "first" } },
        { attemptId: "attempt_completed", nodeKey: "prepare", nodeId: "prepare", attemptNo: 2, status: "completed", result: { ok: true } },
      ],
      groupMembers: [],
      signalWaits: [],
    });

    expect(overlay.nodes.find(node => node.nodeId === "prepare")).toMatchObject({
      status: "completed",
      attempts: expect.arrayContaining([
        expect.objectContaining({ attemptId: "attempt_failed" }),
        expect.objectContaining({ attemptId: "attempt_completed" }),
      ]),
    });
  });
});

function workflow(): WorkflowIR {
  return {
    irVersion: 2,
    name: "overlay-test",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: {},
    root: {
      nodes: [
        task("prepare"),
        {
          id: "approval",
          kind: "parallel",
          strategy: "all",
          branches: {
            left: { scope: { nodes: [signal("left_approve")] } },
            right: { scope: { nodes: [signal("right_approve")] } },
          },
        },
      ],
      outputs: {},
    },
    lock: { acpusCoreVersion: "test", generatedAt: "2026-06-30T00:00:00.000Z", notes: [] },
    diagnostics: [],
  } as unknown as WorkflowIR;
}

function task(id: string): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "task",
    run: { kind: "task_run", input: {}, target: { kind: "inline", runtime: "node", source: "async function task() {}" } },
  };
}

function signal(id: string): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "signal",
    outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: true },
    run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
  };
}
