import { describe, expect, it } from "vitest";
import { activeEdgeIds, canStartPan, compositeBadge, compositeDescriptor, compositeStrategy, displayStatus, graphItemZIndex, isPanPastThreshold, normalizeSelections, safeParents, selectionContext, selectorOptionLabel, selectorStatusSummary, toRenderModel } from "../src/graph-renderer.js";
import type { WebGraph, WebGraphNode } from "../src/client/api.js";

function node(partial: Partial<WebGraphNode> & { id: string }): WebGraphNode {
  const { id, ...rest } = partial;
  return {
    ...rest,
    id,
    nodeId: partial.nodeId ?? id,
    kind: partial.kind ?? "task",
    label: partial.label ?? id,
    path: partial.path ?? ["root", id],
    status: partial.status ?? "completed",
    dynamic: { instances: 0, frames: 0, attempts: 0, signalWaits: 0 },
  };
}

function graphOf(partial: Partial<WebGraph> & { nodes: WebGraphNode[] }): WebGraph {
  const { nodes, ...rest } = partial;
  return {
    ...rest,
    workflow: partial.workflow ?? { name: "test" },
    mode: "runtime",
    nodes,
    containers: partial.containers ?? [],
    edges: partial.edges ?? [],
    selectors: partial.selectors ?? [],
    runtimeStates: partial.runtimeStates ?? [],
    groups: partial.groups ?? [],
  };
}

describe("safeParents cycle safety", () => {
  const ids = (nodes: Array<{ id: string }>) => new Set(nodes.map(n => n.id));

  it("drops a self-referential parent", () => {
    const nodes = [{ id: "a", parentId: "a" }];
    expect(safeParents(nodes, ids(nodes)).has("a")).toBe(false);
  });

  it("drops a two-node cycle", () => {
    const nodes = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect(safeParents(nodes, ids(nodes)).size).toBe(1);
  });

  it("drops a dangling parent that is not known", () => {
    const nodes = [{ id: "a", parentId: "ghost" }];
    expect(safeParents(nodes, ids(nodes)).has("a")).toBe(false);
  });

  it("keeps a valid acyclic parent chain", () => {
    const nodes = [
      { id: "root_group" },
      { id: "child", parentId: "root_group" },
      { id: "grandchild", parentId: "child" },
    ];
    const parents = safeParents(nodes, ids(nodes));
    expect(parents.get("child")).toBe("root_group");
    expect(parents.get("grandchild")).toBe("child");
  });
});

describe("toRenderModel server graph consumption", () => {
  it("uses server-provided containers and does not synthesize branch groups", () => {
    const graph = graphOf({
      nodes: [
        node({ id: "exec", kind: "parallel", detail: { kind: "parallel", branches: ["cache"], strategy: "all" } }),
        node({ id: "cache_hit", parentId: "exec::branch%3Acache", parentNodeId: "exec", path: ["root", "exec", "branch:cache", "cache_hit"] }),
      ],
      containers: [
        { id: "exec::branch%3Acache", nodeId: "exec", kind: "branch", label: "branch: cache", path: ["root", "exec", "branch:cache"], parentId: "exec", status: "completed" },
      ],
    });

    const model = toRenderModel(graph);
    const containers = [...model.items.values()].filter(item => item.type === "container");
    expect(containers).toHaveLength(1);
    expect(containers[0]!.id).toBe("exec::branch%3Acache");
    expect(containers[0]!.label).toBe("branch: cache");
    expect(model.items.get("cache_hit")?.parentId).toBe("exec::branch%3Acache");
  });

  it("keeps all runtime branches visible and dims not-started branches", () => {
    const graph = graphOf({
      workflow: { name: "test", status: "completed" },
      nodes: [
        node({ id: "gate", kind: "if", detail: { kind: "if", condition: "input.ok" }, status: "completed" }),
        node({ id: "then_task", parentId: "gate::then", parentNodeId: "gate", path: ["root", "gate", "then", "then_task"], status: "not_started" }),
        node({ id: "else_task", parentId: "gate::else", parentNodeId: "gate", path: ["root", "gate", "else", "else_task"], status: "completed" }),
      ],
      containers: [
        { id: "gate::then", nodeId: "gate", kind: "branch", label: "then", path: ["root", "gate", "then"], parentId: "gate", status: "not_started" },
        { id: "gate::else", nodeId: "gate", kind: "branch", label: "else", path: ["root", "gate", "else"], parentId: "gate", status: "completed" },
      ],
      runtimeStates: [
        { targetId: "gate", nodeId: "gate", status: "completed", selectors: [] },
        { targetId: "gate::else", nodeId: "gate", status: "completed", selectors: [] },
        { targetId: "else_task", nodeId: "else_task", status: "completed", selectors: [] },
      ],
    });

    const model = toRenderModel(graph);
    expect([...model.items.keys()]).toEqual(expect.arrayContaining(["gate::then", "then_task", "gate::else", "else_task"]));
    expect(model.items.get("then_task")?.status).toBe("skipped");
    expect(model.items.get("then_task")?.dimmed).toBe(true);
    expect(model.items.get("else_task")?.dimmed).toBe(false);
  });

  it("normalizes display statuses without globally converting failed-run downstream nodes to skipped", () => {
    expect(displayStatus("started")).toBe("running");
    expect(displayStatus("timed_out")).toBe("failed");
    expect(displayStatus("pending")).toBe("queued");
    expect(displayStatus("ready")).toBe("queued");
    expect(displayStatus("cancelled")).toBe("canceled");
    expect(displayStatus("canceled")).toBe("canceled");
    expect(displayStatus("awaiting")).toBe("awaiting");

    const graph = graphOf({
      workflow: { name: "failed-run", status: "failed" },
      nodes: [
        node({ id: "prepare", status: "failed" }),
        node({ id: "after", status: "not_started" }),
      ],
      edges: [{ id: "prepare->after", source: "prepare", target: "after", kind: "sequence" }],
    });

    const model = toRenderModel(graph);
    expect(model.items.get("after")?.status).toBe("not_started");
    expect(model.items.get("after")?.dimmed).toBe(true);
  });

  it("resolves selected fanout item runtime state without dropping static alternatives", () => {
    const graph = fanoutGraph();

    const alpha = toRenderModel(graph, { lanes: "lanes:item:0" });
    expect(alpha.items.get("auto_route")?.status).toBe("completed");
    expect(alpha.items.get("auto_route")?.dimmed).toBe(false);
    expect(alpha.items.get("manual_route")?.dimmed).toBe(true);

    const beta = toRenderModel(graph, { lanes: "lanes:item:1" });
    expect(beta.items.get("auto_route")?.dimmed).toBe(true);
    expect(beta.items.get("manual_route")?.status).toBe("completed");
    expect(beta.items.get("manual_route")?.dimmed).toBe(false);
  });

  it("normalizes selector defaults to current/latest valid options", () => {
    expect(normalizeSelections(fanoutGraph(), {})).toEqual({ lanes: "lanes:item:1", repair_loop: "repair_loop:beta:iteration:0" });
  });

  it("limits inspection selection context to ancestor selectors", () => {
    const graph = fanoutGraph();
    const model = toRenderModel(graph, { lanes: "lanes:item:1", repair_loop: "repair_loop:beta:iteration:0" });

    expect(selectionContext(graph, { lanes: "lanes:item:1", repair_loop: "repair_loop:beta:iteration:0" }, "auto_route", model.parentOf)).toEqual([
      { nodeId: "lanes", kind: "fanout", itemKey: "lane-beta", itemIndex: 1 },
    ]);
    expect(selectionContext(graph, { lanes: "lanes:item:1", repair_loop: "repair_loop:beta:iteration:0" }, "repair_loop", model.parentOf)).toEqual([
      { nodeId: "lanes", kind: "fanout", itemKey: "lane-beta", itemIndex: 1 },
      { nodeId: "repair_loop", kind: "loop", iteration: 0 },
    ]);
  });

  it("keeps only semantic edges whose endpoints exist", () => {
    const graph = graphOf({
      nodes: [node({ id: "a" }), node({ id: "b" })],
      edges: [
        { id: "a->b", source: "a", target: "b", kind: "sequence" },
        { id: "a->ghost", source: "a", target: "ghost", kind: "sequence" },
      ],
    });
    expect(toRenderModel(graph).edges.map(edge => edge.id)).toEqual(["a->b"]);
  });

  it("filters loop selectors by the selected ancestor fanout item", () => {
    const graph = fanoutGraph();

    const alpha = toRenderModel(graph, { lanes: "lanes:item:0" });
    expect(alpha.items.get("repair_loop")?.selector?.options.map(option => option.id)).toEqual(["repair_loop:alpha:iteration:0"]);

    const beta = toRenderModel(graph, { lanes: "lanes:item:1" });
    expect(beta.items.get("repair_loop")?.selector?.options.map(option => option.id)).toEqual(["repair_loop:beta:iteration:0"]);
  });

  it("exposes selector status summaries and active control-flow edges", () => {
    const graph = graphOf({
      workflow: { name: "running", status: "running" },
      nodes: [
        node({ id: "prepare", status: "completed" }),
        node({ id: "review", status: "running" }),
      ],
      edges: [{ id: "prepare->review", source: "prepare", target: "review", kind: "sequence" }],
      runtimeStates: [
        { targetId: "prepare", nodeId: "prepare", status: "completed", selectors: [] },
        { targetId: "review", nodeId: "review", status: "running", selectors: [] },
      ],
    });
    const model = toRenderModel(graph);
    expect(model.items.get("review")?.active).toBe(true);
    expect([...activeEdgeIds(model)]).toEqual(["prepare->review"]);

    const selector = fanoutGraph().selectors[0]!;
    expect(selectorStatusSummary(selector, "lanes:item:1")).toEqual({ status: "completed", label: "2/2" });
  });
});

describe("composite header metadata", () => {
  it("keeps the kind badge separate from parallel and fanout strategy", () => {
    expect(compositeBadge("parallel")).toBe("PARALLEL");
    expect(compositeStrategy({ kind: "parallel", branches: ["cache"], strategy: "race" })).toBe("RACE");
    expect(compositeBadge("fanout")).toBe("FANOUT");
    expect(compositeStrategy({ kind: "fanout", over: "input.items", strategy: "quorum" })).toBe("QUORUM");
    expect(compositeStrategy({ kind: "switch", cases: [], hasDefault: false })).toBeUndefined();
  });

  it("keeps loop headers compact", () => {
    const loopSelector = {
      nodeId: "repair_loop",
      kind: "loop" as const,
      targetId: "repair_loop::do",
      options: [{ id: "repair_loop:iteration:0", label: "iteration 0", status: "completed", iteration: 0, scopePath: [], parentSelections: [] }],
    };

    expect(compositeDescriptor({ kind: "loop", state: "state" })).toBeUndefined();
    expect(selectorOptionLabel(loopSelector, loopSelector.options[0]!)).toBe("iter 0");
  });

  it("keeps if branch labels separate from the condition metadata", () => {
    const graph = graphOf({
      nodes: [
        node({ id: "gate", kind: "if", detail: { kind: "if", condition: "input.runAgents" } }),
        node({ id: "run_agent", parentId: "gate::then", parentNodeId: "gate", path: ["root", "gate", "then", "run_agent"] }),
      ],
      containers: [
        { id: "gate::then", nodeId: "gate", kind: "branch", label: "then", path: ["root", "gate", "then"], parentId: "gate", status: "completed" },
      ],
    });

    const model = toRenderModel(graph);
    expect(model.items.get("gate::then")?.label).toBe("then");
    expect(compositeDescriptor(model.items.get("gate")?.node?.detail)).toBe("Condition: input.runAgents");
  });

  it("keeps empty loop body scopes visible in the render model", () => {
    const graph = graphOf({
      nodes: [
        node({ id: "repair_loop", kind: "loop", detail: { kind: "loop", state: "state" } }),
      ],
      containers: [
        { id: "repair_loop::do", nodeId: "repair_loop", kind: "scope", label: "do", path: ["root", "repair_loop", "do"], parentId: "repair_loop", status: "not_started" },
      ],
    });

    const model = toRenderModel(graph);
    expect(model.items.get("repair_loop")?.children).toEqual(["repair_loop::do"]);
    expect(model.items.get("repair_loop::do")?.children).toEqual([]);
  });
});

describe("graph viewport interaction helpers", () => {
  it("allows panning from graph boxes but not interactive controls", () => {
    expect(canStartPan({ closest: () => null })).toBe(true);
    expect(canStartPan({ closest: selector => selector.includes("button") ? {} : null })).toBe(false);
    expect(canStartPan({ closest: selector => selector.includes("select") ? {} : null })).toBe(false);
    expect(canStartPan({ closest: selector => selector.includes(".graph-toolbar") ? {} : null })).toBe(false);
    expect(canStartPan(null)).toBe(false);
  });

  it("suppresses clicks only after a real pan gesture", () => {
    expect(isPanPastThreshold(2, 2)).toBe(false);
    expect(isPanPastThreshold(4, 0)).toBe(true);
    expect(isPanPastThreshold(3, 3)).toBe(true);
  });
});

describe("graph layering helpers", () => {
  it("keeps graph items below toolbar/status layers even for deep workflows", () => {
    expect(graphItemZIndex(0)).toBe(1);
    expect(graphItemZIndex(8)).toBe(9);
    expect(graphItemZIndex(50)).toBe(18);
  });
});

function fanoutGraph(): WebGraph {
  return graphOf({
    nodes: [
      node({ id: "lanes", kind: "fanout", detail: { kind: "fanout", over: "input.lanes", strategy: "all" }, status: "completed" }),
      node({ id: "route", kind: "switch", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "lanes", "do", "route"], detail: { kind: "switch", cases: ["item.auto"], hasDefault: true }, status: "completed" }),
      node({ id: "auto_route", parentId: "route::case%3A0", parentNodeId: "route", path: ["root", "lanes", "do", "route", "case:0", "auto_route"], status: "completed" }),
      node({ id: "manual_route", parentId: "route::default", parentNodeId: "route", path: ["root", "lanes", "do", "route", "default", "manual_route"], status: "completed" }),
      node({ id: "repair_loop", kind: "loop", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "lanes", "do", "repair_loop"], detail: { kind: "loop", state: "state" }, status: "completed" }),
    ],
    containers: [
      { id: "lanes::do", nodeId: "lanes", kind: "scope", label: "do", path: ["root", "lanes", "do"], parentId: "lanes", status: "completed" },
      { id: "route::case%3A0", nodeId: "route", kind: "branch", label: "case: item.auto", path: ["root", "lanes", "do", "route", "case:0"], parentId: "route", status: "completed" },
      { id: "route::default", nodeId: "route", kind: "branch", label: "default", path: ["root", "lanes", "do", "route", "default"], parentId: "route", status: "completed" },
    ],
    selectors: [
      {
        nodeId: "lanes",
        kind: "fanout",
        targetId: "lanes::do",
        defaultOptionId: "lanes:item:1",
        options: [
          { id: "lanes:item:0", label: "item[0] lane-alpha", status: "completed", itemIndex: 0, itemKey: "lane-alpha", scopePath: ["root", "lanes", "do"], parentSelections: [] },
          { id: "lanes:item:1", label: "item[1] lane-beta", status: "completed", itemIndex: 1, itemKey: "lane-beta", scopePath: ["root", "lanes", "do"], parentSelections: [] },
        ],
      },
      {
        nodeId: "repair_loop",
        kind: "loop",
        targetId: "repair_loop",
        defaultOptionId: "repair_loop:beta:iteration:0",
        options: [
          { id: "repair_loop:alpha:iteration:0", label: "iteration 0", status: "completed", iteration: 0, scopePath: [], parentSelections: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0, itemKey: "lane-alpha" }] },
          { id: "repair_loop:beta:iteration:0", label: "iteration 0", status: "completed", iteration: 0, scopePath: [], parentSelections: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1, itemKey: "lane-beta" }] },
        ],
      },
    ],
    runtimeStates: [
      { targetId: "lanes", nodeId: "lanes", status: "completed", selectors: [] },
      { targetId: "route", nodeId: "route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0, itemKey: "lane-alpha" }] },
      { targetId: "route", nodeId: "route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1, itemKey: "lane-beta" }] },
      { targetId: "route::case%3A0", nodeId: "route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0, itemKey: "lane-alpha" }] },
      { targetId: "route::default", nodeId: "route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1, itemKey: "lane-beta" }] },
      { targetId: "auto_route", nodeId: "auto_route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0, itemKey: "lane-alpha" }] },
      { targetId: "manual_route", nodeId: "manual_route", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1, itemKey: "lane-beta" }] },
      { targetId: "repair_loop", nodeId: "repair_loop", status: "completed", selectors: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1, itemKey: "lane-beta" }] },
    ],
  });
}
