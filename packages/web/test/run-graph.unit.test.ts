import { readFileSync } from "node:fs";
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

    expect(compositeDescriptor({ kind: "loop", maxIterations: 3, stopWhen: "done" })).toBeUndefined();
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
        node({ id: "repair_loop", kind: "loop", detail: { kind: "loop", maxIterations: 2, stopWhen: "done" } }),
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

describe("runtime status rendering contract", () => {
  const runGraphSource = readFileSync(new URL("../src/client/ui/RunGraph.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("uses a structured graph empty state", () => {
    const emptyStateSource = runGraphSource.slice(
      runGraphSource.indexOf("function GraphEmptyState"),
      runGraphSource.indexOf("export function RunGraph"),
    );
    const emptyStyle = styles.slice(
      styles.indexOf(".graph-empty {"),
      styles.indexOf(".graph-box.node {"),
    );
    expect(runGraphSource).toContain("function GraphEmptyState");
    expect(emptyStateSource).toContain('role="group"');
    expect(emptyStateSource).toContain("aria-labelledby");
    expect(emptyStateSource).toContain("aria-describedby");
    expect(emptyStyle).toContain(".graph-empty strong");
    expect(emptyStyle).toContain(".graph-empty p");
  });

  it("renders status glyphs only for graph nodes, not branch or scope containers", () => {
    const containerContent = runGraphSource.slice(
      runGraphSource.indexOf("function ContainerContent"),
      runGraphSource.indexOf("function clamp"),
    );
    expect(runGraphSource).toContain("function StatusGlyph");
    expect(containerContent).toContain("branch-pill");
  });

  it("uses graph-specific container classes", () => {
    expect(runGraphSource).toContain('item.type === "container" ? "graph-container" : "node"');
    expect(styles).toContain(".graph-box.graph-container");
    expect(styles).toContain(".graph-box.graph-container.scope");
  });

  it("keeps node status glyphs inline and selector labels free of runtime status text", () => {
    const leafContent = runGraphSource.slice(
      runGraphSource.indexOf("function LeafContent"),
      runGraphSource.indexOf("function CompositeContent"),
    );
    const compositeContent = runGraphSource.slice(
      runGraphSource.indexOf("function CompositeContent"),
      runGraphSource.indexOf("function ContainerContent"),
    );
    expect(leafContent.indexOf("<strong>{item.label}</strong>")).toBeLessThan(leafContent.indexOf("<StatusGlyph status={item.status} />"));
    expect(compositeContent.indexOf("{strategy && <span className=\"strategy-badge\">{strategy}</span>}")).toBeLessThan(compositeContent.indexOf("<StatusGlyph status={item.status} />"));
    expect(compositeContent).toContain("{selectorOptionLabel(item.selector!, option)}</SelectItem>");
  });

  it("passes graph display status through node selection for inspector consistency", () => {
    expect(runGraphSource).toContain("displayStatusForTarget");
    expect(runGraphSource).toContain("model.items.get(targetId)?.status");
    expect(runGraphSource).toContain("onSelectNode(id, contextForTarget(id), displayStatusForTarget(id))");
    expect(runGraphSource).toContain("nextModel.items.get(selectedNodeId)?.status");
  });

  it("uses circle status icons for the visible runtime status enum", () => {
    const iconSource = runGraphSource.slice(
      runGraphSource.indexOf("const STATUS_ICONS"),
      runGraphSource.indexOf("function StatusGlyph"),
    );
    expect(iconSource).toContain("queued: CircleDashed");
    expect(iconSource).toContain("running: CirclePlay");
    expect(iconSource).toContain("awaiting: CircleEllipsis");
    expect(iconSource).toContain("paused: CirclePause");
    expect(iconSource).toContain("completed: CircleCheck");
    expect(iconSource).toContain("failed: CircleX");
    expect(iconSource).toContain("canceled: Ban");
    expect(iconSource).toContain("skipped: SkipForward");
    expect(runGraphSource).toContain('if (display === "not_started") return null');
  });

  it("styles runtime status glyphs as inline icons", () => {
    const glyphRule = styles.slice(
      styles.indexOf(".runtime-status-glyph {"),
      styles.indexOf(".runtime-status-glyph svg"),
    );
    expect(glyphRule).toContain("flex: 0 0 auto");
    expect(styles).toContain(".graph-selector.loop");
    expect(styles).toContain("width: 78px");
    expect(styles).toContain(".graph-box.node.loop .composite-title");
  });

  it("gives graph toolbar buttons and selectors explicit accessible names", () => {
    const runGraphSource = readFileSync(new URL("../src/client/ui/RunGraph.tsx", import.meta.url), "utf8");
    const workflowButton = runGraphSource.slice(
      runGraphSource.indexOf('className="graph-tool-button workflow-io"'),
      runGraphSource.indexOf("<Scan", runGraphSource.indexOf('className="graph-tool-button workflow-io"')),
    );
    expect(workflowButton).toContain('aria-label="Workflow I/O: open workflow input and output"');
    expect(workflowButton).toContain("<span>Workflow I/O</span>");
    expect(runGraphSource).toContain('aria-label="Fit graph to view"');
    expect(runGraphSource).toContain('aria-label="Zoom graph out"');
    expect(runGraphSource).toContain('aria-label="Zoom graph in"');
    expect(runGraphSource).toContain('aria-label={`${item.selector.kind === "loop" ? "Loop iteration" : "Fanout item"} for ${item.label}`}');
  });

  it("makes graph boxes keyboard selectable without stealing nested control keys", () => {
    const graphBoxSource = runGraphSource.slice(
      runGraphSource.indexOf("const GraphBox = memo"),
      runGraphSource.indexOf("function LeafContent"),
    );
    expect(graphBoxSource).toContain('role="button"');
    expect(graphBoxSource).toContain("tabIndex={0}");
    expect(graphBoxSource).toContain("onKeyDown={event =>");
    expect(graphBoxSource).toContain("event.currentTarget !== event.target");
    expect(graphBoxSource).toContain('event.key !== "Enter" && event.key !== " "');
    expect(graphBoxSource).toContain("onSelectNode(item.type === \"node\" ? item.id : item.nodeId)");
  });
});

describe("graph viewport interaction helpers", () => {
  const runGraphSource = readFileSync(new URL("../src/client/ui/RunGraph.tsx", import.meta.url), "utf8");

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

  it("uses a non-passive wheel listener so graph zoom does not bubble into page zoom", () => {
    expect(runGraphSource).toContain('addEventListener("wheel", onWheel, { passive: false })');
    expect(runGraphSource).toContain("event.preventDefault()");
    expect(runGraphSource).toContain("wheelZoomScale");
  });
});

describe("graph layering helpers", () => {
  it("keeps graph items below toolbar/status layers even for deep workflows", () => {
    expect(graphItemZIndex(0)).toBe(1);
    expect(graphItemZIndex(8)).toBe(9);
    expect(graphItemZIndex(50)).toBe(18);
  });
});

describe("graph kind theme styles", () => {
  const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  it("assigns each graph node kind a distinct theme color", () => {
    expect(styles).toContain(".graph-box.node.task");
    expect(styles).toContain("--graph-kind: #6f8a6a");
    expect(styles).toContain("--graph-kind-pill-text: #42583f");
    expect(styles).toContain("--graph-kind-surface: rgb(111 138 106 / 0.05)");
    expect(styles).toContain(".graph-box.node.agent");
    expect(styles).toContain("--graph-kind: #6e82a3");
    expect(styles).toContain(".graph-box.node.signal");
    expect(styles).toContain("--graph-kind: #a8845d");
    expect(styles).toContain(".graph-box.node.assert");
    expect(styles).toContain("--graph-kind: #8c789f");
    expect(styles).toContain(".graph-box.node.if");
    expect(styles).toContain("--graph-kind: #a07862");
    expect(styles).toContain(".graph-box.node.switch");
    expect(styles).toContain("--graph-kind: #8a7aae");
    expect(styles).toContain(".graph-box.node.parallel");
    expect(styles).toContain("--graph-kind: #6a928a");
    expect(styles).toContain(".graph-box.node.fanout");
    expect(styles).toContain("--graph-kind: #6c9ba6");
    expect(styles).toContain(".graph-box.node.loop");
    expect(styles).toContain("--graph-kind: #7a83a6");
  });

  it("uses kind colors for badges and does not let runtime status override node borders", () => {
    expect(styles).toContain("border-color: var(--graph-kind-border)");
    expect(styles).toContain("color: var(--graph-kind, var(--color-sera-muted))");
    expect(styles).toContain("color: var(--graph-kind-pill-text, var(--graph-kind, var(--color-sera-muted)))");
    expect(styles).toContain("background: var(--graph-kind-pill-bg, var(--color-sera-surfaceMuted))");
    expect(styles).toContain(".graph-box.runtime-status-running");
    expect(styles).toContain(".runtime-status-glyph");
    expect(styles).toContain("--runtime-status-color: #2563eb");
    expect(styles).toContain("--runtime-status-color: #1f7a45");
    expect(styles).toContain("--runtime-status-color: #b42318");
    expect(styles).toContain("--runtime-status-color: #8a6a24");
    const runtimeStatusRules = styles.slice(
      styles.indexOf(".graph-box.runtime-status-not_started"),
      styles.indexOf(".runtime-status-glyph {"),
    );
    expect(runtimeStatusRules).not.toContain("--graph-kind");
  });

  it("gives real graph nodes stronger hover elevation than structural containers", () => {
    expect(styles).toContain(".graph-box.node:hover");
    expect(styles).toContain("transform: translateY(-1px)");
    expect(styles).toContain("border-color: var(--graph-kind, var(--color-sera-primary))");
    expect(styles).toContain("0 18px 34px rgb(10 10 10 / 0.16)");
    expect(styles).toContain(".graph-box.node.parallel:hover");
    expect(styles).toContain("0 14px 28px rgb(10 10 10 / 0.12)");
    expect(styles).toContain(".graph-box.selected:hover");
    expect(styles).toContain(".graph-box.node.runtime-active:hover");
    expect(styles).toContain(".graph-box:hover {\n    transform: none;");
  });

  it("has motion-aware run and graph runtime status hooks", () => {
    expect(styles).toContain(".run-status-indicator");
    expect(styles).toContain("@keyframes graph-shell-shimmer");
    expect(styles).toContain(".graph-edge.active");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".graph-flow-shell.run-status-running::before");
  });
});

function fanoutGraph(): WebGraph {
  return graphOf({
    nodes: [
      node({ id: "lanes", kind: "fanout", detail: { kind: "fanout", over: "input.lanes", strategy: "all" }, status: "completed" }),
      node({ id: "route", kind: "switch", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "lanes", "do", "route"], detail: { kind: "switch", cases: ["item.auto"], hasDefault: true }, status: "completed" }),
      node({ id: "auto_route", parentId: "route::case%3A0", parentNodeId: "route", path: ["root", "lanes", "do", "route", "case:0", "auto_route"], status: "completed" }),
      node({ id: "manual_route", parentId: "route::default", parentNodeId: "route", path: ["root", "lanes", "do", "route", "default", "manual_route"], status: "completed" }),
      node({ id: "repair_loop", kind: "loop", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "lanes", "do", "repair_loop"], detail: { kind: "loop", maxIterations: 3, stopWhen: "done" }, status: "completed" }),
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
