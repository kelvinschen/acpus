import { describe, expect, it } from "vitest";
import { activeEdgeIds, activeFocus, canStartPan, compositeBadge, compositeStrategy, graphItemZIndex, graphNodeTarget, isPanPastThreshold, normalizeSelections, planGraphNavigation, safeParents, selectionsForActiveRuntime, selectorOptionLabel, toRenderModel } from "../src/graph-renderer.js";
import type { WebGraph, WebGraphNode } from "../src/client/api.js";
import type { WebGraphRuntimeState } from "../src/graph-types.js";

type GraphInput = Omit<Partial<WebGraph>, "runtimeStates"> & {
  nodes: WebGraphNode[];
  runtimeStates?: Array<Omit<WebGraphRuntimeState, "target"> & { target?: string }>;
};

function node(partial: Partial<WebGraphNode> & { id: string }): WebGraphNode {
  const { id, ...rest } = partial;
  return {
    ...rest,
    id,
    nodeId: partial.nodeId ?? id,
    target: partial.target ?? partial.nodeId ?? id,
    kind: partial.kind ?? "task",
    label: partial.label ?? id,
    path: partial.path ?? ["root", id],
    status: partial.status ?? "completed",
  };
}

function graphOf(partial: GraphInput): WebGraph {
  const { nodes, ...rest } = partial;
  return {
    ...rest,
    workflow: partial.workflow ?? { name: "test" },
    mode: "runtime",
    nodes,
    containers: partial.containers ?? [],
    edges: partial.edges ?? [],
    fanoutOccurrences: partial.fanoutOccurrences ?? [],
    selectors: partial.selectors ?? [],
    runtimeStates: (partial.runtimeStates ?? []).map(state => ({
      ...state,
      target: state.target ?? state.targetId,
    })),
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
        node({ id: "cache_hit", parentId: "exec::branch%3Acache", path: ["root", "exec", "branch:cache", "cache_hit"] }),
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
        node({ id: "then_task", parentId: "gate::then", path: ["root", "gate", "then", "then_task"], status: "not_started" }),
        node({ id: "else_task", parentId: "gate::else", path: ["root", "gate", "else", "else_task"], status: "completed" }),
      ],
      containers: [
        { id: "gate::then", nodeId: "gate", kind: "branch", label: "then", path: ["root", "gate", "then"], parentId: "gate", status: "not_started" },
        { id: "gate::else", nodeId: "gate", kind: "branch", label: "else", path: ["root", "gate", "else"], parentId: "gate", status: "completed" },
      ],
      runtimeStates: [
        { targetId: "gate", status: "completed", context: [] },
        { targetId: "gate::else", status: "completed", context: [] },
        { targetId: "else_task", status: "completed", context: [] },
      ],
    });

    const model = toRenderModel(graph);
    expect([...model.items.keys()]).toEqual(expect.arrayContaining(["gate::then", "then_task", "gate::else", "else_task"]));
    expect(model.items.get("then_task")?.status).toBe("skipped");
    expect(model.items.get("then_task")?.dimmed).toBe(true);
    expect(model.items.get("else_task")?.dimmed).toBe(false);
  });

  it("keeps failed-run downstream nodes not-started", () => {
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

  it("expands every materialized fanout item inside one authored do scope", () => {
    const model = toRenderModel(fanoutGraph());
    const scope = model.items.get("lanes::do")!;
    const occurrences = scope.children.map(id => model.items.get(id)!);
    const routes = [...model.items.values()].filter(item => item.type === "node" && item.nodeId === "route");

    expect(occurrences.map(item => item.label)).toEqual(["item[0]", "item[1]"]);
    expect(occurrences.every(item => item.occurrence?.kind === "fanout-item")).toBe(true);
    expect(routes.map(item => item.context)).toEqual([
      [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }],
      [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }],
    ]);
    expect([...model.items.values()].filter(item => item.kind === "scope" && item.nodeId === "lanes")).toHaveLength(1);
  });

  it("keeps loop selection local to each rendered fanout occurrence", () => {
    const graph = fanoutGraph();
    expect(normalizeSelections(graph, {})).toEqual({
      "repair.alpha": "repair_loop:alpha:iteration:0",
      "repair.beta": "repair_loop:beta:iteration:0",
    });

    const model = toRenderModel(graph);
    const loops = [...model.items.values()].filter(item => item.type === "node" && item.nodeId === "repair_loop");
    expect(loops.map(item => item.selector?.id)).toEqual(["repair.alpha", "repair.beta"]);
    expect(loops.map(item => graphNodeTarget(item))).toEqual([
      expect.objectContaining({
        target: "@repair-alpha",
        context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }],
      }),
      expect.objectContaining({
        target: "@repair-beta",
        context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }],
      }),
    ]);
  });

  it("uses the fanout do scope as the common focus when several items are active", () => {
    const graph = fanoutGraph();
    graph.workflow.status = "running";
    for (const item of graph.fanoutOccurrences[0]!.items) item.status = "running";
    const model = toRenderModel(graph);
    const focus = activeFocus(model);

    expect(focus?.reason).toBe("multiple-active");
    expect(focus?.targetId).toBe("lanes::do");
    expect(focus?.activeRenderIds.map(id => model.items.get(id)?.label)).toEqual(["item[0]", "item[1]"]);
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

  it("expands nested fanout items against their exact outer context", () => {
    const model = toRenderModel(nestedFanoutGraph());
    const leaves = [...model.items.values()].filter(item => item.type === "node" && item.nodeId === "leaf");

    expect(leaves.map(item => item.context)).toEqual([
      [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }, { nodeId: "items", kind: "fanout", itemIndex: 0 }],
      [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }, { nodeId: "items", kind: "fanout", itemIndex: 1 }],
      [{ nodeId: "groups", kind: "fanout", itemIndex: 1 }, { nodeId: "items", kind: "fanout", itemIndex: 0 }],
    ]);
    expect(new Set(leaves.map(item => item.id)).size).toBe(3);
  });

  it("marks active control-flow edges", () => {
    const graph = graphOf({
      workflow: { name: "running", status: "running" },
      nodes: [
        node({ id: "prepare", status: "completed" }),
        node({ id: "review", status: "running" }),
      ],
      edges: [{ id: "prepare->review", source: "prepare", target: "review", kind: "sequence" }],
      runtimeStates: [
        { targetId: "prepare", status: "completed", context: [] },
        { targetId: "review", status: "running", context: [] },
      ],
    });
    const model = toRenderModel(graph);
    expect(model.items.get("review")?.active).toBe(true);
    expect([...activeEdgeIds(model)]).toEqual(["prepare->review"]);
    expect(activeFocus(model)).toEqual({ reason: "single-active", targetId: "review", activeRenderIds: ["review"] });

  });

  it("locates the deepest common ancestor when several nodes are active", () => {
    const graph = graphOf({
      workflow: { name: "parallel", status: "running" },
      nodes: [
        node({ id: "work", kind: "parallel", status: "running", detail: { kind: "parallel", branches: ["a", "b"], strategy: "all" } }),
        node({ id: "a", parentId: "work::a", status: "running" }),
        node({ id: "b", parentId: "work::b", status: "awaiting" }),
      ],
      containers: [
        { id: "work::a", nodeId: "work", kind: "branch", label: "a", path: ["root", "work", "a"], parentId: "work", status: "running" },
        { id: "work::b", nodeId: "work", kind: "branch", label: "b", path: ["root", "work", "b"], parentId: "work", status: "awaiting" },
      ],
      runtimeStates: [
        { targetId: "work", status: "running", context: [] },
        { targetId: "a", status: "running", context: [] },
        { targetId: "b", status: "awaiting", context: [] },
      ],
    });

    expect(activeFocus(toRenderModel(graph))).toEqual({
      reason: "multiple-active",
      targetId: "work",
      activeRenderIds: ["a", "b"],
    });
  });

  it("reveals the active loop iteration before locating its running descendant", () => {
    const iteration = (value: number) => [{ nodeId: "repeat", kind: "loop" as const, iteration: value }];
    const graph = graphOf({
      workflow: { name: "loop", status: "running" },
      nodes: [
        node({ id: "repeat", kind: "loop", status: "running", detail: { kind: "loop", state: "state" } }),
        node({ id: "round", parentId: "repeat::do", status: "running" }),
      ],
      containers: [
        { id: "repeat::do", nodeId: "repeat", kind: "scope", label: "do", path: ["root", "repeat", "do"], parentId: "repeat", status: "running" },
      ],
      selectors: [{
        id: "repeat-frame",
        nodeId: "repeat",
        kind: "loop",
        targetId: "repeat::do",
        context: [],
        defaultOptionId: "iter-1",
        options: [
          { id: "iter-0", iteration: 0, context: iteration(0) },
          { id: "iter-1", iteration: 1, context: iteration(1) },
        ],
      }],
      runtimeStates: [
        { targetId: "repeat", status: "running", context: [] },
        { targetId: "round", status: "completed", context: iteration(0) },
        { targetId: "round", status: "running", context: iteration(1) },
      ],
    });

    const selections = selectionsForActiveRuntime(graph, { "repeat-frame": "iter-0" });
    expect(selections).toEqual({ "repeat-frame": "iter-1" });
    const model = toRenderModel(graph, selections);
    const runningRound = [...model.items.values()].find(item => item.nodeId === "round");
    expect(activeFocus(model)?.targetId).toBe(runningRound?.id);
    expect(runningRound?.context).toEqual(iteration(1));
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
      id: "repair_loop",
      nodeId: "repair_loop",
      kind: "loop" as const,
      targetId: "repair_loop::do",
      context: [],
      options: [{ id: "repair_loop:iteration:0", iteration: 0, context: [{ nodeId: "repair_loop", kind: "loop" as const, iteration: 0 }] }],
    };

    expect(selectorOptionLabel(loopSelector, loopSelector.options[0]!)).toBe("iter 0");
  });

  it("keeps if branch labels separate from the Inspector definition", () => {
    const graph = graphOf({
      nodes: [
        node({ id: "gate", kind: "if", detail: { kind: "if", condition: "input.runAgents" } }),
        node({ id: "run_agent", parentId: "gate::then", path: ["root", "gate", "then", "run_agent"] }),
      ],
      containers: [
        { id: "gate::then", nodeId: "gate", kind: "branch", label: "then", path: ["root", "gate", "then"], parentId: "gate", status: "completed" },
      ],
    });

    const model = toRenderModel(graph);
    expect(model.items.get("gate::then")?.label).toBe("then");
    expect(graphNodeTarget(model.items.get("gate"))?.detail).toEqual({ kind: "if", condition: "input.runAgents" });
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
  const model = toRenderModel(graphOf({
    nodes: [
      node({ id: "task", status: "running" }),
      node({
        id: "group",
        kind: "parallel",
        detail: { kind: "parallel", branches: [], strategy: "all" },
        status: "running",
      }),
    ],
    containers: [{
      id: "scope",
      nodeId: "group",
      kind: "scope",
      label: "scope",
      path: ["root", "scope"],
      parentId: "group",
      status: "running",
    }],
  }));
  const layout = {
    boxes: new Map([
      ["task", { id: "task", x: 56, y: 150, width: 488, height: 100, flowY: 50 }],
      ["scope", { id: "scope", x: 106, y: 56, width: 488, height: 288, flowY: 144 }],
    ]),
  };
  const viewport = { x: 7, y: 9, scale: 0.5 };
  const rect = { width: 600, height: 400 };
  const taskTarget = {
    renderId: "task",
    target: "task",
    nodeId: "task",
    kind: "task",
    label: "task",
    context: [],
    displayStatus: "running",
  };

  it("plans item navigation with one viewport rule and node-only inspection", () => {
    expect(planGraphNavigation(model, layout, viewport, rect, {
      type: "navigate-item",
      renderId: "task",
    })).toEqual({
      viewport: { x: 0, y: 0, scale: 1 },
      inspectionTarget: taskTarget,
    });
    expect(planGraphNavigation(model, layout, viewport, rect, {
      type: "navigate-item",
      renderId: "scope",
    })).toEqual({
      viewport: { x: -50, y: 0, scale: 1 },
    });
  });

  it("keeps exact inspection available when layout is missing", () => {
    const missingLayout = { boxes: new Map() };
    expect(planGraphNavigation(model, missingLayout, viewport, rect, {
      type: "navigate-item",
      renderId: "task",
    })).toEqual({ inspectionTarget: taskTarget });
    expect(planGraphNavigation(model, layout, viewport, rect, {
      type: "navigate-item",
      renderId: "missing",
    })).toBeUndefined();
  });

  it("recenters overview navigation without changing zoom", () => {
    expect(planGraphNavigation(model, layout, viewport, rect, {
      type: "recenter",
      point: { x: 100, y: 50 },
    })).toEqual({
      viewport: { x: 250, y: 175, scale: 0.5 },
    });
  });

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
      node({ id: "route", kind: "switch", parentId: "lanes::do", path: ["root", "lanes", "do", "route"], detail: { kind: "switch", cases: ["item.auto"], hasDefault: true }, status: "completed" }),
      node({ id: "auto_route", parentId: "route::case%3A0", path: ["root", "lanes", "do", "route", "case:0", "auto_route"], status: "completed" }),
      node({ id: "manual_route", parentId: "route::default", path: ["root", "lanes", "do", "route", "default", "manual_route"], status: "completed" }),
      node({ id: "repair_loop", kind: "loop", parentId: "lanes::do", path: ["root", "lanes", "do", "repair_loop"], detail: { kind: "loop", state: "state" }, status: "completed" }),
    ],
    containers: [
      { id: "lanes::do", nodeId: "lanes", kind: "scope", label: "do", path: ["root", "lanes", "do"], parentId: "lanes", status: "completed" },
      { id: "route::case%3A0", nodeId: "route", kind: "branch", label: "case 0", path: ["root", "lanes", "do", "route", "case:0"], parentId: "route", status: "completed" },
      { id: "route::default", nodeId: "route", kind: "branch", label: "default", path: ["root", "lanes", "do", "route", "default"], parentId: "route", status: "completed" },
      { id: "repair_loop::do", nodeId: "repair_loop", kind: "scope", label: "do", path: ["root", "lanes", "do", "repair_loop", "do"], parentId: "repair_loop", status: "completed" },
    ],
    fanoutOccurrences: [{
      id: "lanes",
      nodeId: "lanes",
      targetId: "lanes::do",
      context: [],
      status: "completed",
      items: [
        { id: "lanes.alpha", itemIndex: 0, label: "item[0]", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }] },
        { id: "lanes.beta", itemIndex: 1, label: "item[1]", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }] },
      ],
    }],
    selectors: [
      {
        id: "repair.alpha",
        nodeId: "repair_loop",
        kind: "loop",
        targetId: "repair_loop::do",
        context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }],
        defaultOptionId: "repair_loop:alpha:iteration:0",
        options: [{
          id: "repair_loop:alpha:iteration:0",
          iteration: 0,
          context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }, { nodeId: "repair_loop", kind: "loop", iteration: 0 }],
        }],
      },
      {
        id: "repair.beta",
        nodeId: "repair_loop",
        kind: "loop",
        targetId: "repair_loop::do",
        context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }],
        defaultOptionId: "repair_loop:beta:iteration:0",
        options: [{
          id: "repair_loop:beta:iteration:0",
          iteration: 0,
          context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }, { nodeId: "repair_loop", kind: "loop", iteration: 0 }],
        }],
      },
    ],
    runtimeStates: [
      { targetId: "lanes", target: "lanes", status: "completed", context: [] },
      { targetId: "route", target: "@route-alpha", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }] },
      { targetId: "route", target: "@route-beta", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }] },
      { targetId: "route::case%3A0", target: "@route-alpha", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }] },
      { targetId: "route::default", target: "@route-beta", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }] },
      { targetId: "auto_route", target: "@auto-route-alpha", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }] },
      { targetId: "manual_route", target: "@manual-route-beta", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }] },
      { targetId: "repair_loop", target: "@repair-alpha", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 0 }] },
      { targetId: "repair_loop", target: "@repair-beta", status: "completed", context: [{ nodeId: "lanes", kind: "fanout", itemIndex: 1 }] },
    ],
  });
}

function nestedFanoutGraph(): WebGraph {
  return graphOf({
    nodes: [
      node({ id: "groups", kind: "fanout", detail: { kind: "fanout", over: "input.groups", strategy: "all" } }),
      node({ id: "items", kind: "fanout", parentId: "groups::do", path: ["root", "groups", "do", "items"], detail: { kind: "fanout", over: "groups.item.items", strategy: "all" } }),
      node({ id: "leaf", parentId: "items::do", path: ["root", "groups", "do", "items", "do", "leaf"] }),
    ],
    containers: [
      { id: "groups::do", nodeId: "groups", kind: "scope", label: "do", path: ["root", "groups", "do"], parentId: "groups", status: "running" },
      { id: "items::do", nodeId: "items", kind: "scope", label: "do", path: ["root", "groups", "do", "items", "do"], parentId: "items", status: "running" },
    ],
    fanoutOccurrences: [
      {
        id: "groups",
        nodeId: "groups",
        targetId: "groups::do",
        context: [],
        status: "running",
        items: [
          { id: "groups.0", label: "item[0]", itemIndex: 0, status: "completed", context: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }] },
          { id: "groups.1", label: "item[1]", itemIndex: 1, status: "running", context: [{ nodeId: "groups", kind: "fanout", itemIndex: 1 }] },
        ],
      },
      {
        id: "items.0",
        nodeId: "items",
        targetId: "items::do",
        context: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }],
        status: "completed",
        items: [
          { id: "items.0.0", label: "item[0]", itemIndex: 0, status: "completed", context: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }, { nodeId: "items", kind: "fanout", itemIndex: 0 }] },
          { id: "items.0.1", label: "item[1]", itemIndex: 1, status: "completed", context: [{ nodeId: "groups", kind: "fanout", itemIndex: 0 }, { nodeId: "items", kind: "fanout", itemIndex: 1 }] },
        ],
      },
      {
        id: "items.1",
        nodeId: "items",
        targetId: "items::do",
        context: [{ nodeId: "groups", kind: "fanout", itemIndex: 1 }],
        status: "running",
        items: [
          { id: "items.1.0", label: "item[0]", itemIndex: 0, status: "running", context: [{ nodeId: "groups", kind: "fanout", itemIndex: 1 }, { nodeId: "items", kind: "fanout", itemIndex: 0 }] },
        ],
      },
    ],
  });
}
