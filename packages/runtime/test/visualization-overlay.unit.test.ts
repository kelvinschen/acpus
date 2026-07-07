import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { createWorkflowVisualizationOverlay } from "../src/visualization/overlay.js";

const timing = { createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:01.000Z" };
const attemptTiming = { startedAt: "2026-07-03T00:00:00.000Z", finishedAt: "2026-07-03T00:00:01.000Z" };

describe("workflow visualization overlay", () => {
  it("combines static node structure with dynamic runtime projection summaries", () => {
    const overlay = createWorkflowVisualizationOverlay(workflow(), {
      version: 9,
      frames: [
        { frameKey: "root", frameKind: "root", status: "running", ...timing },
        { frameKey: "approval", nodeId: "approval", frameKind: "node", status: "running", strategy: "all", ...timing },
        { frameKey: "approval.left", nodeId: "approval", frameKind: "branch", status: "running", strategy: "all", ...timing },
        { frameKey: "approval.right", nodeId: "approval", frameKind: "branch", status: "completed", strategy: "all", ...timing },
      ],
      nodeInstances: [
        { nodeKey: "left_approve", nodeId: "left_approve", status: "awaiting", ...timing },
        { nodeKey: "right_approve", nodeId: "right_approve", status: "completed", output: { ok: true }, ...timing },
      ],
      attempts: [
        { attemptId: "attempt_prepare", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "completed", ...attemptTiming },
      ],
      groupMembers: [
        { groupKey: "approval", memberKey: "approval.left", memberKind: "branch", branchId: "left", status: "running", ...timing },
        { groupKey: "approval", memberKey: "approval.right", memberKind: "branch", branchId: "right", status: "completed", ...timing },
      ],
      signalWaits: [
        { nodeKey: "left_approve", nodeId: "left_approve", status: "awaiting", ...timing },
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

  it("attaches per-kind authored semantic detail from the IR", () => {
    const overlay = createWorkflowVisualizationOverlay(detailWorkflow());
    const detailById = new Map(overlay.nodes.map(node => [node.nodeId, node.detail]));

    expect(detailById.get("prepare")).toEqual({ kind: "task", inputs: ["lane"], target: "inline" });
    expect(detailById.get("review")).toMatchObject({
      kind: "agent",
      agent: "reviewer",
      use: "codex",
      model: "sonnet",
      outputSchema: { kind: "object", required: ["ok"], fields: { ok: { kind: "boolean" }, note: { kind: "string", optional: true } } },
    });
    expect(detailById.get("gate")).toEqual({ kind: "assert", condition: call("gte", ref("input", "score"), lit(50)) });
    expect(detailById.get("branchy")).toEqual({ kind: "if", condition: ref("input", "enabled") });
    expect(detailById.get("router")).toEqual({ kind: "switch", cases: [call("eq", ref("input", "mode"), lit("auto"))], hasDefault: true });
    expect(detailById.get("lanes")).toEqual({ kind: "fanout", over: ref("input", "lanes"), strategy: "all" });
    expect(detailById.get("retry")).toEqual({ kind: "loop", maxIterations: 3, stopWhen: ref("state", "done") });
  });

  it("keeps historical attempts from overriding the current node status", () => {
    const overlay = createWorkflowVisualizationOverlay(workflow(), {
      version: 10,
      frames: [],
      nodeInstances: [
        { nodeKey: "prepare", nodeId: "prepare", status: "completed", output: { ok: true }, ...timing },
      ],
      attempts: [
        { attemptId: "attempt_failed", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "failed", error: { reason: "first" }, ...attemptTiming },
        { attemptId: "attempt_completed", nodeKey: "prepare", nodeId: "prepare", attemptNo: 2, status: "completed", result: { ok: true }, ...attemptTiming },
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

function detailWorkflow(): WorkflowIR {
  return {
    irVersion: 2,
    name: "detail-test",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: { reviewer: { kind: "agent_definition", use: "codex", model: "sonnet" } },
    root: {
      nodes: [
        {
          id: "prepare",
          kind: "task",
          run: { kind: "task_run", input: { lane: ref("input", "lane") }, target: { kind: "inline", runtime: "node", source: "async function t() {}" } },
        },
        {
          id: "review",
          kind: "agent",
          outputSchema: { kind: "object", fields: { ok: { kind: "boolean" }, note: { kind: "string", optional: true } }, required: ["ok"], additionalProperties: false },
          run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
        },
        { id: "gate", kind: "assert", condition: call("gte", ref("input", "score"), lit(50)) },
        {
          id: "branchy",
          kind: "if",
          condition: ref("input", "enabled"),
          then: { nodes: [] },
          else: { nodes: [] },
        },
        {
          id: "router",
          kind: "switch",
          cases: [{ when: call("eq", ref("input", "mode"), lit("auto")), then: { nodes: [] } }],
          default: { nodes: [{ id: "fallback", kind: "task", run: { kind: "task_run", input: {}, target: { kind: "inline", runtime: "node", source: "async function t() {}" } } }] },
        },
        {
          id: "lanes",
          kind: "fanout",
          over: ref("input", "lanes"),
          strategy: "all",
          do: { nodes: [] },
        },
        {
          id: "retry",
          kind: "loop",
          initial: lit({}),
          maxIterations: 3,
          stopWhen: ref("state", "done"),
          do: { nodes: [] },
        },
      ],
      outputs: {},
    },
    lock: { acpusCoreVersion: "test", generatedAt: "2026-06-30T00:00:00.000Z", notes: [] },
    diagnostics: [],
  } as unknown as WorkflowIR;
}

function ref(...path: string[]) {
  return { kind: "ref", path };
}

function lit(value: unknown) {
  return { kind: "literal", value };
}

function call(fn: string, ...args: unknown[]) {
  return { kind: "call", fn, args };
}

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
