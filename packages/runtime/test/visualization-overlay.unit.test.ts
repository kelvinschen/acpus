import { describe, expect, it } from "vitest";
import type { ExprIR, JsonPrimitive, WorkflowIR } from "@acpus/core/ir";
import { createWorkflowVisualizationOverlay } from "../src/visualization/overlay.js";

const timing = { createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:01.000Z" };
const attemptTiming = { startedAt: "2026-07-03T00:00:00.000Z", finishedAt: "2026-07-03T00:00:01.000Z" };

describe("workflow visualization overlay", () => {
  it("combines static node structure with dynamic runtime projection summaries", () => {
    const overlay = createWorkflowVisualizationOverlay(workflow(), {
      version: 9,
      frames: [
        { frameKey: "root", frameKind: "root", status: "running", ...timing },
        { frameKey: "approval", nodeId: "approval", frameKind: "node", status: "running", strategy: "all", instancePath: [{ kind: "node", nodeId: "approval" }], ...timing },
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
      groups: [
        { groupKey: "approval", nodeKey: "approval", nodeId: "approval", kind: "parallel", strategy: "all", status: "running", maxConcurrency: 1 },
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
        maxConcurrency: 1,
        instancePath: [{ kind: "node", nodeId: "approval" }],
        members: expect.arrayContaining([
          expect.objectContaining({ memberKey: "approval.left" }),
          expect.objectContaining({ memberKey: "approval.right" }),
        ]),
      }),
    ]);
    expect(overlay.groups).toHaveLength(1);
  });

  it("labels conditional and dynamic-body child paths", () => {
    const overlay = createWorkflowVisualizationOverlay(compositePathWorkflow());

    expect(
      overlay.nodes
        .filter(node => node.parentNodeId !== undefined)
        .map(node => [node.nodeId, node.parentNodeId, node.path.join(" > ")]),
    ).toEqual([
      ["if_then", "choose", "root > choose > then > if_then"],
      ["if_else", "choose", "root > choose > else > if_else"],
      ["switch_case", "route", "root > route > case:0 > switch_case"],
      ["switch_default", "route", "root > route > default > switch_default"],
      ["fanout_body", "items", "root > items > do > fanout_body"],
      ["loop_body", "repeat", "root > repeat > do > loop_body"],
    ]);
  });

  it("attaches per-kind authored semantic detail from the IR", () => {
    const overlay = createWorkflowVisualizationOverlay(detailWorkflow());
    const detailById = new Map(overlay.nodes.map(node => [node.nodeId, node.detail]));

    expect(detailById.get("prepare")).toEqual({
      kind: "task",
      input: { kind: "object", fields: { lane: ref("input", "lane") } },
      target: "inline",
    });
    expect(detailById.get("fallback")).toEqual({
      kind: "task",
      input: lit(null),
      target: "inline",
    });
    expect(detailById.get("review")).toMatchObject({
      kind: "agent",
      agent: "reviewer",
      use: "codex",
      model: "opus",
      outputSchema: { kind: "object", required: ["ok"], fields: { ok: { kind: "boolean" }, note: { kind: "string", optional: true } } },
    });
    expect(detailById.get("gate")).toEqual({ kind: "assert", condition: call("gte", ref("input", "score"), lit(50)) });
    expect(detailById.get("branchy")).toEqual({ kind: "if", condition: ref("input", "enabled") });
    expect(detailById.get("router")).toEqual({ kind: "switch", cases: [call("eq", ref("input", "mode"), lit("auto"))], hasDefault: true });
    expect(detailById.get("lanes")).toEqual({ kind: "fanout", over: ref("input", "lanes"), strategy: "all" });
    expect(detailById.get("retry")).toEqual({
      kind: "loop",
      state: { kind: "object", fields: {} },
    });
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
      groups: [],
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

function compositePathWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "composite-paths",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [
        {
          id: "choose",
          kind: "if",
          condition: { kind: "literal", value: true },
          then: { output: { kind: "object", fields: {} }, nodes: [task("if_then")] },
          else: { output: { kind: "object", fields: {} }, nodes: [task("if_else")] },
        },
        {
          id: "route",
          kind: "switch",
          cases: [{ when: { kind: "literal", value: true }, then: { output: { kind: "object", fields: {} }, nodes: [task("switch_case")] } }],
          default: { output: { kind: "object", fields: {} }, nodes: [task("switch_default")] },
        },
        {
          id: "items",
          kind: "fanout",
          strategy: "all",
          over: { kind: "array", items: [] },
          do: { output: { kind: "object", fields: {} }, nodes: [task("fanout_body")] },
        },
        {
          id: "repeat",
          kind: "loop",
          state: { kind: "literal", value: null },
          do: {
            nodes: [task("loop_body")],
            output: { kind: "object", fields: {
              state: { kind: "literal", value: null },
              stop: { kind: "literal", value: true },
            } },
          },
        },
      ],
    },

    diagnostics: [],
  };
}

function detailWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "detail-test",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: { reviewer: { kind: "agent_definition", use: "codex", model: "sonnet", config: { model: "opus" } } },
    root: {
      output: { kind: "object", fields: {} },
      nodes: [
        {
          id: "prepare",
          kind: "task",
          run: {
            input: { kind: "object", fields: { lane: ref("input", "lane") } },
            target: { kind: "inline", source: "async function t() {}" },
          },
        },
        {
          id: "review",
          kind: "agent",
          outputSchema: { kind: "object", fields: { ok: { kind: "boolean" }, note: { kind: "string", optional: true } }, required: ["ok"], additionalProperties: false },
          run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
        },
        { id: "gate", kind: "assert", condition: call("gte", ref("input", "score"), lit(50)) },
        {
          id: "branchy",
          kind: "if",
          condition: ref("input", "enabled"),
          then: { output: { kind: "object", fields: {} }, nodes: [] },
          else: { output: { kind: "object", fields: {} }, nodes: [] },
        },
        {
          id: "router",
          kind: "switch",
          cases: [{ when: call("eq", ref("input", "mode"), lit("auto")), then: { output: { kind: "object", fields: {} }, nodes: [] } }],
          default: {
            output: { kind: "object", fields: {} },
            nodes: [{
              id: "fallback",
              kind: "task",
              run: {
                input: { kind: "literal", value: null },
                target: { kind: "inline", source: "async function t() {}" },
              },
            }],
          },
        },
        {
          id: "lanes",
          kind: "fanout",
          over: ref("input", "lanes"),
          strategy: "all",
          do: { output: { kind: "object", fields: {} }, nodes: [] },
        },
        {
          id: "retry",
          kind: "loop",
          state: { kind: "object", fields: {} },
          do: { nodes: [], output: { kind: "object", fields: { state: ref("loop", "retry", "state"), stop: ref("loop", "retry", "state", "done") } } },
        },
      ],
    },

    diagnostics: [],
  };
}

function ref(...path: string[]): ExprIR {
  return { kind: "ref", path };
}

function lit(value: JsonPrimitive): ExprIR {
  return { kind: "literal", value };
}

function call(fn: string, ...args: ExprIR[]): ExprIR {
  return { kind: "call", fn, args };
}

function workflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "overlay-test",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [
        task("prepare"),
        {
          id: "approval",
          kind: "parallel",
          strategy: "all",
          branches: {
            left: { output: { kind: "object", fields: {} }, nodes: [signal("left_approve")] },
            right: { output: { kind: "object", fields: {} }, nodes: [signal("right_approve")] },
          },
        },
      ],
    },

    diagnostics: [],
  };
}

function task(id: string): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source: "async function task() {}" },
    },
  };
}

function signal(id: string): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "signal",
    outputSchema: { kind: "object", fields: {}, required: [], additionalProperties: true },
    run: { prompt: { kind: "literal", value: "" } },
  };
}
