import { describe, expect, it } from "vitest";
import type { ExprIR, JsonPrimitive } from "@acpus/expression/ir";
import type { WorkflowVisualizationOverlay } from "@acpus/runtime";
import { graphFromOverlay, type WebGraph } from "../src/server/graph.js";

const timing = { createdAt: "2026-07-04T11:40:57.000Z", updatedAt: "2026-07-04T11:40:58.000Z" };
const ref = (...path: string[]): ExprIR => ({ kind: "ref", path });
const lit = (value: JsonPrimitive): ExprIR => ({ kind: "literal", value });
const call = (fn: string, ...args: ExprIR[]): ExprIR => ({ kind: "call", fn, args });

type OverlayNode = WorkflowVisualizationOverlay["nodes"][number];
type OverlayFrame = OverlayNode["frames"][number];
type OverlayInstance = OverlayNode["instances"][number];
type InstancePath = NonNullable<OverlayFrame["instancePath"]>;

describe("graphFromOverlay", () => {
  it("produces browser-ready static graph structure", () => {
    const graph = graphFromOverlay(compositeRunOverlay(), "static");

    expect(graph.mode).toBe("static");
    expect(graph.workflow).toEqual({ name: "web-composite-agent" });
    expect(graph.nodes).toHaveLength(17);
    expect(graph.nodes.map(node => [node.id, node.kind])).toContainEqual(["execution", "parallel"]);
    expect(graph.nodes.map(node => [node.id, node.kind])).toContainEqual(["repair_loop", "loop"]);
    expect(graph.selectors).toEqual([]);
    expect(graph.runtimeStates).toEqual([]);
    expect(graph.nodes.every(node => node.status === "not_started")).toBe(true);
  });

  it("models the composite run with containers and valid semantic edge endpoints", () => {
    const graph = graphFromOverlay(compositeRunOverlay(), "runtime");
    const ids = new Set([...graph.nodes.map(node => node.id), ...graph.containers.map(container => container.id)]);

    expect(graph.nodes).toHaveLength(17);
    expect(graph.containers.map(container => [container.nodeId, container.label])).toEqual(expect.arrayContaining([
      ["execution", "branch: lane_matrix"],
      ["execution", "branch: agent_preview"],
      ["execution", "branch: race_preview"],
      ["lanes", "do"],
      ["route", 'case: lift(fanout.lanes.item.mode, "mode => mode === \\"auto\\"")'],
      ["route", "default"],
      ["repair_loop", "do"],
      ["race", "branch: cache"],
      ["race", "branch: compute"],
      ["operator_gate", "then"],
      ["operator_gate", "else"],
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "execution", target: "operator_gate", kind: "sequence" }),
      expect.objectContaining({ source: "operator_gate", target: "final_gate", kind: "sequence" }),
      expect.objectContaining({ source: "route", target: "repair_loop", kind: "sequence" }),
      expect.objectContaining({ source: "repair_loop", target: "score_gate", kind: "sequence" }),
    ]));
    expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.edges.some(edge => edge.kind === "branch")).toBe(true);
  });

  it("surfaces runtime fanout and loop selectors with scoped options", () => {
    const graph = graphFromOverlay(compositeRunOverlay(), "runtime");
    const fanout = graph.selectors.find(selector => selector.nodeId === "lanes");
    const loop = graph.selectors.find(selector => selector.nodeId === "repair_loop");

    expect(fanout).toMatchObject({ kind: "fanout" });
    expect(fanout?.options.map(option => ({
      label: "label" in option ? option.label : undefined,
      itemIndex: "itemIndex" in option ? option.itemIndex : undefined,
    }))).toEqual([
      { label: "item[0]", itemIndex: 0 },
      { label: "item[1]", itemIndex: 1 },
    ]);
    expect(fanout?.defaultOptionId).toBe("lanes.beta");

    expect(loop).toMatchObject({ kind: "loop" });
    expect(loop?.targetId).toBe("repair_loop::do");
    expect(loop?.options).toHaveLength(2);
    expect(loop?.options.map(option => option.parentSelections[0])).toEqual([
      { nodeId: "lanes", kind: "fanout", itemIndex: 0 },
      { nodeId: "lanes", kind: "fanout", itemIndex: 1 },
    ]);
    expect(loop?.options.every(option => "iteration" in option && option.iteration === 0)).toBe(true);
  });

  it("emits runtime states scoped to selected fanout items and branches", () => {
    const graph = graphFromOverlay(compositeRunOverlay(), "runtime");
    const autoRoute = stateFor(graph, "auto_route");
    const manualRoute = stateFor(graph, "manual_route");
    const defaultContainer = graph.containers.find(container => container.nodeId === "route" && container.label === "default");

    expect(autoRoute?.status).toBe("completed");
    expect(autoRoute?.selectors).toEqual([{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }]);
    expect(manualRoute?.selectors).toEqual([{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }]);
    expect(defaultContainer).toBeDefined();
    expect(graph.runtimeStates).toContainEqual(expect.objectContaining({
      targetId: defaultContainer!.id,
      status: "completed",
      selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }],
    }));
  });

  it("aggregates nested fanout occurrences without colliding on local item indexes", () => {
    const graph = graphFromOverlay(nestedFanoutOverlay(), "runtime");
    const inner = graph.selectors.find(selector => selector.nodeId === "items");

    expect(graph.selectors.filter(selector => selector.nodeId === "items")).toHaveLength(1);
    expect(inner?.options.map(option => ({
      id: option.id,
      itemIndex: "itemIndex" in option ? option.itemIndex : undefined,
      parentSelections: option.parentSelections,
    }))).toEqual([
      { id: "items.0.0", itemIndex: 0, parentSelections: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }] },
      { id: "items.0.1", itemIndex: 1, parentSelections: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }] },
      { id: "items.1.0", itemIndex: 0, parentSelections: [{ nodeId: "groups", kind: "fanout", itemIndex: 1 }] },
    ]);
  });
});

function stateFor(graph: WebGraph, targetId: string) {
  return graph.runtimeStates.find(state => state.targetId === targetId);
}

function nestedFanoutOverlay(): WorkflowVisualizationOverlay {
  return {
    workflow: { name: "nested-fanout", runId: "run_1", status: "running", dynamicVersion: 1 },
    nodes: [
      node("groups", "fanout", ["root", "groups"], {
        detail: { kind: "fanout", over: ref("input", "groups"), strategy: "all" },
      }),
      node("items", "fanout", ["root", "groups", "do", "items"], {
        parentNodeId: "groups",
        detail: { kind: "fanout", over: ref("fanout", "groups", "item", "items"), strategy: "all" },
      }),
    ],
    groups: [
      {
        nodeId: "groups",
        groupKey: "groups",
        kind: "fanout",
        status: "running",
        instancePath: [{ kind: "node", nodeId: "groups" }],
        members: [
          { groupKey: "groups", memberKey: "groups.0", memberKind: "fanout_item", itemIndex: 0, item: { items: ["a", "b"] }, status: "completed", ...timing },
          { groupKey: "groups", memberKey: "groups.1", memberKind: "fanout_item", itemIndex: 1, item: { items: ["c"] }, status: "running", ...timing },
        ],
      },
      {
        nodeId: "items",
        groupKey: "items.0",
        kind: "fanout",
        status: "completed",
        instancePath: [{ kind: "fanout", nodeId: "groups", itemIndex: 0 }, { kind: "node", nodeId: "items" }],
        members: [
          { groupKey: "items.0", memberKey: "items.0.0", memberKind: "fanout_item", itemIndex: 0, item: "a", status: "completed", ...timing },
          { groupKey: "items.0", memberKey: "items.0.1", memberKind: "fanout_item", itemIndex: 1, item: "b", status: "completed", ...timing },
        ],
      },
      {
        nodeId: "items",
        groupKey: "items.1",
        kind: "fanout",
        status: "running",
        instancePath: [{ kind: "fanout", nodeId: "groups", itemIndex: 1 }, { kind: "node", nodeId: "items" }],
        members: [
          { groupKey: "items.1", memberKey: "items.1.0", memberKind: "fanout_item", itemIndex: 0, item: "c", status: "running", ...timing },
        ],
      },
    ],
  };
}

function compositeRunOverlay(): WorkflowVisualizationOverlay {
  return {
    workflow: { name: "web-composite-agent", runId: "20260704194056A5C66CB699247307B635", status: "completed", dynamicVersion: 119 },
    nodes: [
      node("execution", "parallel", ["root", "execution"], {
        detail: { kind: "parallel", branches: ["lane_matrix", "agent_preview", "race_preview"], strategy: "all" },
        frames: [
          frame("execution~root", "execution", "node", "completed", [{ kind: "node", nodeId: "execution" }]),
          frame("execution.lane_matrix", "execution", "branch", "completed", [{ kind: "branch", nodeId: "execution", branchId: "lane_matrix" }]),
          frame("execution.agent_preview", "execution", "branch", "completed", [{ kind: "branch", nodeId: "execution", branchId: "agent_preview" }]),
          frame("execution.race_preview", "execution", "branch", "completed", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }]),
        ],
      }),
      node("lanes", "fanout", ["root", "execution", "branch:lane_matrix", "lanes"], {
        parentNodeId: "execution",
        detail: { kind: "fanout", over: ref("input", "lanes"), strategy: "all" },
        frames: [
          frame("lanes", "lanes", "node", "completed", branchFanoutPath()),
          frame("lanes.alpha", "lanes", "fanout_item", "completed", branchFanoutPath(0)),
          frame("lanes.beta", "lanes", "fanout_item", "completed", branchFanoutPath(1)),
        ],
      }),
      node("route", "switch", ["root", "execution", "branch:lane_matrix", "lanes", "do", "route"], {
        parentNodeId: "lanes",
        detail: { kind: "switch", cases: [call("lift", ref("fanout", "lanes", "item", "mode"), lit("mode => mode === \"auto\""))], hasDefault: true },
        frames: [
          frame("route.alpha", "route", "node", "completed", [...branchFanoutPath(0), { kind: "node", nodeId: "route" }]),
          frame("route.alpha.case", "route", "branch", "completed", [...branchFanoutPath(0), { kind: "branch", nodeId: "route", branchId: "case:0" }]),
          frame("route.beta", "route", "node", "completed", [...branchFanoutPath(1), { kind: "node", nodeId: "route" }]),
          frame("route.beta.default", "route", "branch", "completed", [...branchFanoutPath(1), { kind: "branch", nodeId: "route", branchId: "default" }]),
        ],
      }),
      node("auto_route", "task", ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "case:0", "auto_route"], {
        parentNodeId: "route",
        detail: { kind: "task", inputs: ["lane", "score"], target: "inline" },
        instances: [instance("auto_route.alpha", "auto_route", "completed", [...branchFanoutPath(0), { kind: "branch", nodeId: "route", branchId: "case:0" }, { kind: "node", nodeId: "auto_route" }])],
      }),
      node("manual_route", "task", ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "default", "manual_route"], {
        parentNodeId: "route",
        detail: { kind: "task", inputs: ["lane", "score"], target: "inline" },
        instances: [instance("manual_route.beta", "manual_route", "completed", [...branchFanoutPath(1), { kind: "branch", nodeId: "route", branchId: "default" }, { kind: "node", nodeId: "manual_route" }])],
      }),
      node("repair_loop", "loop", ["root", "execution", "branch:lane_matrix", "lanes", "do", "repair_loop"], {
        parentNodeId: "lanes",
        detail: { kind: "loop", state: { kind: "object", fields: {} } },
        frames: [
          frame("repair.alpha", "repair_loop", "loop", "completed", [...branchFanoutPath(0), { kind: "node", nodeId: "repair_loop" }]),
          frame("repair.alpha.0", "repair_loop", "loop_iteration", "completed", [...branchFanoutPath(0), { kind: "loop", nodeId: "repair_loop", iter: 0 }]),
          frame("repair.beta", "repair_loop", "loop", "completed", [...branchFanoutPath(1), { kind: "node", nodeId: "repair_loop" }]),
          frame("repair.beta.0", "repair_loop", "loop_iteration", "completed", [...branchFanoutPath(1), { kind: "loop", nodeId: "repair_loop", iter: 0 }]),
        ],
      }),
      node("score_gate", "assert", ["root", "execution", "branch:lane_matrix", "lanes", "do", "score_gate"], {
        parentNodeId: "lanes",
        detail: { kind: "assert", condition: call("lift", ref("fanout", "lanes", "item", "score"), ref("input", "minScore"), lit("(score, minScore) => score >= minScore")) },
        frames: [
          frame("score.alpha", "score_gate", "node", "completed", [...branchFanoutPath(0), { kind: "node", nodeId: "score_gate" }]),
          frame("score.beta", "score_gate", "node", "completed", [...branchFanoutPath(1), { kind: "node", nodeId: "score_gate" }]),
        ],
      }),
      node("agent_gate", "if", ["root", "execution", "branch:agent_preview", "agent_gate"], {
        parentNodeId: "execution",
        detail: { kind: "if", condition: ref("input", "runAgents") },
        frames: [
          frame("agent_gate", "agent_gate", "node", "completed", [{ kind: "branch", nodeId: "execution", branchId: "agent_preview" }, { kind: "node", nodeId: "agent_gate" }]),
          frame("agent_gate.else", "agent_gate", "branch", "completed", [{ kind: "branch", nodeId: "execution", branchId: "agent_preview" }, { kind: "branch", nodeId: "agent_gate", branchId: "else" }]),
        ],
      }),
      node("reviewer_agent", "agent", ["root", "execution", "branch:agent_preview", "agent_gate", "then", "reviewer_agent"], {
        parentNodeId: "agent_gate",
        detail: { kind: "agent", agent: "reviewer", use: "codex" },
      }),
      node("skip_agent", "task", ["root", "execution", "branch:agent_preview", "agent_gate", "else", "skip_agent"], {
        parentNodeId: "agent_gate",
        detail: { kind: "task", inputs: [], target: "inline" },
        instances: [instance("skip_agent", "skip_agent", "completed", [{ kind: "branch", nodeId: "execution", branchId: "agent_preview" }, { kind: "branch", nodeId: "agent_gate", branchId: "else" }, { kind: "node", nodeId: "skip_agent" }])],
      }),
      node("race", "parallel", ["root", "execution", "branch:race_preview", "race"], {
        parentNodeId: "execution",
        detail: { kind: "parallel", branches: ["cache", "compute"], strategy: "race" },
        frames: [
          frame("race", "race", "node", "completed", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }, { kind: "node", nodeId: "race" }]),
          frame("race.cache", "race", "branch", "cancelled", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }, { kind: "branch", nodeId: "race", branchId: "cache" }]),
          frame("race.compute", "race", "branch", "completed", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }, { kind: "branch", nodeId: "race", branchId: "compute" }]),
        ],
      }),
      node("cache_hit", "task", ["root", "execution", "branch:race_preview", "race", "branch:cache", "cache_hit"], {
        parentNodeId: "race",
        detail: { kind: "task", inputs: [], target: "inline" },
        instances: [instance("cache_hit", "cache_hit", "cancelled", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }, { kind: "branch", nodeId: "race", branchId: "cache" }, { kind: "node", nodeId: "cache_hit" }])],
      }),
      node("compute_value", "task", ["root", "execution", "branch:race_preview", "race", "branch:compute", "compute_value"], {
        parentNodeId: "race",
        detail: { kind: "task", inputs: [], target: "inline" },
        instances: [instance("compute_value", "compute_value", "completed", [{ kind: "branch", nodeId: "execution", branchId: "race_preview" }, { kind: "branch", nodeId: "race", branchId: "compute" }, { kind: "node", nodeId: "compute_value" }])],
      }),
      node("operator_gate", "if", ["root", "operator_gate"], {
        detail: { kind: "if", condition: ref("input", "requireSignal") },
        frames: [
          frame("operator_gate", "operator_gate", "node", "completed", [{ kind: "node", nodeId: "operator_gate" }]),
          frame("operator_gate.else", "operator_gate", "branch", "completed", [{ kind: "branch", nodeId: "operator_gate", branchId: "else" }]),
        ],
      }),
      node("operator_signal", "signal", ["root", "operator_gate", "then", "operator_signal"], {
        parentNodeId: "operator_gate",
        detail: { kind: "signal", outputSchema: { kind: "object", fields: { ok: { kind: "boolean" }, note: { kind: "string" } }, required: ["ok", "note"], additionalProperties: false } },
      }),
      node("auto_operator_gate", "task", ["root", "operator_gate", "else", "auto_operator_gate"], {
        parentNodeId: "operator_gate",
        detail: { kind: "task", inputs: [], target: "inline" },
        instances: [instance("auto_operator_gate", "auto_operator_gate", "completed", [{ kind: "branch", nodeId: "operator_gate", branchId: "else" }, { kind: "node", nodeId: "auto_operator_gate" }])],
      }),
      node("final_gate", "assert", ["root", "final_gate"], {
        detail: { kind: "assert", condition: ref("nodes", "operator_gate", "output", "ok") },
        frames: [frame("final_gate", "final_gate", "node", "completed", [{ kind: "node", nodeId: "final_gate" }])],
      }),
    ],
    groups: [
      {
        nodeId: "lanes",
        groupKey: "lanes",
        kind: "fanout",
        status: "completed",
        strategy: "all",
        members: [
          { groupKey: "lanes", memberKey: "lanes.alpha", memberKind: "fanout_item", itemIndex: 0, item: { mode: "auto" }, childFrameKey: "lanes.alpha", status: "completed", ...timing },
          { groupKey: "lanes", memberKey: "lanes.beta", memberKind: "fanout_item", itemIndex: 1, item: { mode: "manual" }, childFrameKey: "lanes.beta", status: "completed", ...timing },
        ],
      },
    ],
  };
}

function node(
  nodeId: string,
  kind: OverlayNode["kind"],
  path: string[],
  partial: Partial<OverlayNode> = {},
): OverlayNode {
  return {
    nodeId,
    kind,
    path,
    instances: [],
    frames: [],
    attempts: [],
    signalWaits: [],
    status: partial.status ?? (partial.instances?.[0]?.status as any) ?? (partial.frames?.[0]?.status as any) ?? "not_started",
    ...partial,
  } as OverlayNode;
}

function frame(
  frameKey: string,
  nodeId: string,
  frameKind: OverlayFrame["frameKind"],
  status: string,
  instancePath: InstancePath,
): OverlayFrame {
  return { frameKey, nodeId, frameKind, status, instancePath, ...timing } as OverlayFrame;
}

function instance(
  nodeKey: string,
  nodeId: string,
  status: string,
  instancePath: OverlayInstance["instancePath"],
): OverlayInstance {
  return { nodeKey, nodeId, status, instancePath, ...timing } as OverlayInstance;
}

function branchFanoutPath(itemIndex?: number): InstancePath {
  return [
    { kind: "branch", nodeId: "execution", branchId: "lane_matrix" },
    ...(itemIndex === undefined ? [] : [{ kind: "fanout" as const, nodeId: "lanes", itemIndex }]),
  ];
}
