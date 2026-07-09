import { describe, expect, it } from "vitest";
import { fitScale, fitView, fitViewportPadding, isLosslessZoom, keepBoxInViewport, layoutWorkflow, minZoomScale, projectBox, projectEdgePath, projectPoint, renderableEdges, toRenderModel, visualBoundsForLayout, wheelZoomScale } from "../src/graph-renderer.js";
import type { WebGraph, WebGraphNode } from "../src/client/api.js";

describe("workflow graph layout", () => {
  it("places every graph item without leaf overlap and keeps children inside parents", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);

    expect(layout.boxes.size).toBe(model.items.size);
    const leaves = [...model.items.values()].filter(item => item.children.length === 0);
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const a = layout.boxes.get(leaves[i]!.id)!;
        const b = layout.boxes.get(leaves[j]!.id)!;
        const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        expect(overlapX > 1 && overlapY > 1, `${leaves[i]!.id} overlaps ${leaves[j]!.id}`).toBe(false);
      }
    }

    for (const item of model.items.values()) {
      if (!item.parentId) continue;
      const child = layout.boxes.get(item.id)!;
      const parent = layout.boxes.get(item.parentId)!;
      expect(child.x).toBeGreaterThanOrEqual(parent.x - 1);
      expect(child.y).toBeGreaterThanOrEqual(parent.y - 1);
      expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
      expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height + 1);
    }
  });

  it("keeps the top-level workflow as a vertical control-flow spine", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);
    const execution = layout.boxes.get("execution")!;
    const operatorGate = layout.boxes.get("operator_gate")!;
    const finalGate = layout.boxes.get("final_gate")!;

    expect(model.rootIds).toEqual(["execution", "operator_gate", "final_gate"]);
    expect(execution.y).toBeLessThan(operatorGate.y);
    expect(operatorGate.y).toBeLessThan(finalGate.y);
    expect(Math.abs(centerX(execution) - centerX(operatorGate))).toBeLessThan(1);
    expect(Math.abs(centerX(operatorGate) - centerX(finalGate))).toBeLessThan(1);
  });

  it("lays every branch set horizontally without stacking", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);
    const laneMatrix = layout.boxes.get("execution::branch%3Alane_matrix")!;
    const agentPreview = layout.boxes.get("execution::branch%3Aagent_preview")!;
    const racePreview = layout.boxes.get("execution::branch%3Arace_preview")!;
    const agentThen = layout.boxes.get("agent_gate::then")!;
    const agentElse = layout.boxes.get("agent_gate::else")!;
    const raceCache = layout.boxes.get("race::branch%3Acache")!;
    const raceCompute = layout.boxes.get("race::branch%3Acompute")!;

    expect(laneMatrix.x).toBeLessThan(agentPreview.x);
    expect(agentPreview.x).toBeLessThan(racePreview.x);
    expect(Math.abs(laneMatrix.y - agentPreview.y)).toBeLessThan(1);
    expect(Math.abs(agentPreview.y - racePreview.y)).toBeLessThan(1);
    expect(agentThen.x).toBeLessThan(agentElse.x);
    expect(Math.abs(agentThen.y - agentElse.y)).toBeLessThan(1);
    expect(raceCache.x).toBeLessThan(raceCompute.x);
    expect(Math.abs(raceCache.y - raceCompute.y)).toBeLessThan(1);
  });

  it("keeps branch lanes wide enough for truncated labels", () => {
    const model = toRenderModel(longBranchLabelGraph());
    const layout = layoutWorkflow(model);
    const caseBranch = layout.boxes.get("route::case%3A0")!;
    const defaultBranch = layout.boxes.get("route::default")!;

    expect(caseBranch.width).toBeGreaterThanOrEqual(220);
    expect(defaultBranch.width).toBeGreaterThanOrEqual(220);
    expect(defaultBranch.x - (caseBranch.x + caseBranch.width)).toBeGreaterThanOrEqual(36);
  });

  it("keeps loop composites wide enough for their id and compact iteration selector", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);

    expect(layout.boxes.get("repair_loop")?.width).toBeGreaterThanOrEqual(340);
  });

  it("gives fanout do scopes enough structural padding around wide nested composites", () => {
    const model = toRenderModel(wideFanoutSwitchGraph());
    const layout = layoutWorkflow(model);
    const scope = layout.boxes.get("candidate_matrix::do")!;
    const route = layout.boxes.get("route_candidate")!;

    expect(route.x).toBeGreaterThanOrEqual(scope.x + 56);
    expect(route.x + route.width).toBeLessThanOrEqual(scope.x + scope.width - 56);
    expect(route.y).toBeGreaterThan(scope.y);
    expect(route.y + route.height).toBeLessThan(scope.y + scope.height);

    for (const item of model.items.values()) {
      if (!item.parentId) continue;
      const child = layout.boxes.get(item.id)!;
      const parent = layout.boxes.get(item.parentId)!;
      expect(child.x, `${item.id} escapes ${item.parentId} on the left`).toBeGreaterThanOrEqual(parent.x - 1);
      expect(child.x + child.width, `${item.id} escapes ${item.parentId} on the right`).toBeLessThanOrEqual(parent.x + parent.width + 1);
      expect(child.y, `${item.id} escapes ${item.parentId} on the top`).toBeGreaterThanOrEqual(parent.y - 1);
      expect(child.y + child.height, `${item.id} escapes ${item.parentId} on the bottom`).toBeLessThanOrEqual(parent.y + parent.height + 1);
    }
  });

  it("keeps composite children near the header", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);
    const execution = layout.boxes.get("execution")!;
    const laneMatrix = layout.boxes.get("execution::branch%3Alane_matrix")!;

    expect(laneMatrix.y - execution.y).toBeLessThan(80);
    expect(execution.height).toBeLessThan(1180);
  });

  it("renders arrows for sibling control flow but not containment", () => {
    const model = toRenderModel(compositeGraph());
    const layout = layoutWorkflow(model);

    expect(layout.edgePaths.map(edge => edge.id)).toEqual(expect.arrayContaining([
      "execution->operator_gate",
      "operator_gate->final_gate",
      "route->repair_loop",
      "repair_loop->score_gate",
    ]));
    expect(layout.edgePaths.map(edge => edge.id)).not.toEqual(expect.arrayContaining([
      "execution->lane_matrix",
      "execution->agent_preview",
      "execution->race_preview",
    ]));
    expect(renderableEdges(model.edges, model.parentOf).map(edge => edge.id)).toEqual(layout.edgePaths.map(edge => edge.id));
    expect(model.items.get("execution::branch%3Alane_matrix")?.parentId).toBe("execution");
    expect(model.items.get("lanes")?.parentId).toBe("execution::branch%3Alane_matrix");
  });

  it("fits the canvas inside a viewport with clamped zoom", () => {
    expect(fitView({ width: 1000, height: 500 }, { width: 600, height: 360 })).toEqual({
      x: 16.19999999999999,
      y: 38.099999999999994,
      scale: 0.5676,
    });
    expect(fitView({ width: 100, height: 80 }, { width: 600, height: 360 }).scale).toBe(1);
    expect(fitView({ width: 10_000, height: 10_000 }, { width: 600, height: 360 }).scale).toBeCloseTo(0.03276);
    expect(fitScale({ width: 1000, height: 500 }, { width: 600, height: 360 })).toBe(0.5676);
    expect(fitViewportPadding({ width: 600, height: 360 })).toBe(16.2);
    expect(fitViewportPadding({ width: 200, height: 160 })).toBe(12);
    expect(fitViewportPadding({ width: 2000, height: 1200 })).toBe(32);
    expect(minZoomScale(0.5676)).toBeCloseTo(0.4257);
  });

  it("uses precise wheel zoom and preserves clamp boundaries", () => {
    expect(wheelZoomScale(1, -100, 0.2, 2)).toBeGreaterThan(1);
    expect(wheelZoomScale(1, -100, 0.2, 2)).toBeLessThan(1.1);
    expect(wheelZoomScale(1, 100, 0.2, 2)).toBeLessThan(1);
    expect(wheelZoomScale(1, 100, 0.2, 2)).toBeGreaterThan(0.9);
    expect(wheelZoomScale(2, -1000, 0.2, 2)).toBe(2);
    expect(wheelZoomScale(0.2, 1000, 0.2, 2)).toBe(0.2);
  });

  it("keeps selected boxes visible without moving an already visible viewport", () => {
    const viewport = { x: 0, y: 0, scale: 1 };
    const rect = { width: 500, height: 300 };
    const visible = { id: "a", x: 100, y: 80, width: 120, height: 80 };
    expect(keepBoxInViewport(viewport, rect, visible, 48)).toEqual(viewport);

    const clipped = { id: "b", x: 430, y: 250, width: 120, height: 80 };
    expect(keepBoxInViewport(viewport, rect, clipped, 48)).toEqual({
      x: -98,
      y: -78,
      scale: 1,
    });
  });

  it("expands visual fit bounds for labels, borders, shadows, and arrows", () => {
    expect(visualBoundsForLayout({ width: 1000, height: 500 })).toEqual({
      x: -24,
      y: -24,
      width: 1048,
      height: 548,
    });
  });

  it("projects boxes and edge paths for lossless zoom-in", () => {
    const viewport = { x: 10, y: 20, scale: 1.5 };
    const box = { id: "a", x: 100, y: 80, width: 200, height: 72 };
    const boxes = new Map([
      ["a", box],
      ["b", { id: "b", x: 100, y: 220, width: 200, height: 72 }],
    ]);

    expect(isLosslessZoom(0.99)).toBe(false);
    expect(isLosslessZoom(1)).toBe(true);
    expect(projectPoint({ x: 20, y: 30 }, viewport)).toEqual({ x: 40, y: 65 });
    expect(projectBox(box, viewport)).toEqual({ id: "a", x: 160, y: 140, width: 300, height: 108 });
    expect(projectEdgePath({ id: "a->b", source: "a", target: "b", kind: "sequence" }, boxes, viewport)?.d)
      .toBe("M 310 248 V 299 H 310 V 349");
  });
});

function centerX(box: { x: number; width: number }): number {
  return box.x + box.width / 2;
}

function node(partial: Partial<WebGraphNode> & { id: string; kind?: string; path?: string[] }): WebGraphNode {
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

function longBranchLabelGraph(): WebGraph {
  return {
    workflow: { name: "long-label" },
    mode: "runtime",
    nodes: [
      node({ id: "route", kind: "switch", detail: { kind: "switch", cases: ['fanout.lanes.item.mode == "auto" && input.reallyLongDecisionExpression'], hasDefault: true } }),
      node({ id: "auto_route", parentId: "route::case%3A0", parentNodeId: "route", path: ["root", "route", "case:0", "auto_route"] }),
      node({ id: "manual_route", parentId: "route::default", parentNodeId: "route", path: ["root", "route", "default", "manual_route"] }),
    ],
    containers: [
      { id: "route::case%3A0", nodeId: "route", kind: "branch", label: 'case: fanout.lanes.item.mode == "auto" && input.reallyLongDecisionExpression', path: ["root", "route", "case:0"], parentId: "route", status: "completed" },
      { id: "route::default", nodeId: "route", kind: "branch", label: "default", path: ["root", "route", "default"], parentId: "route", status: "completed" },
    ],
    edges: [],
    selectors: [],
    runtimeStates: [],
    groups: [],
  };
}

function wideFanoutSwitchGraph(): WebGraph {
  return {
    workflow: { name: "wide-fanout-switch" },
    mode: "runtime",
    nodes: [
      node({ id: "candidate_matrix", kind: "fanout", detail: { kind: "fanout", over: "input.candidates", strategy: "all" } }),
      node({ id: "route_candidate", kind: "switch", parentId: "candidate_matrix::do", parentNodeId: "candidate_matrix", path: ["root", "candidate_matrix", "do", "route_candidate"], detail: { kind: "switch", cases: ["candidate.kind == research", "candidate.ready && candidate.score >= minScore"], hasDefault: true } }),
      node({ id: "research_lane", kind: "parallel", parentId: "route_candidate::case%3A0", parentNodeId: "route_candidate", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane"], detail: { kind: "parallel", branches: ["scorecard", "convergence"], strategy: "all" } }),
      node({ id: "research_scorecard", parentId: "research_lane::branch%3Ascorecard", parentNodeId: "research_lane", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:scorecard", "research_scorecard"] }),
      node({ id: "research_convergence", kind: "loop", parentId: "research_lane::branch%3Aconvergence", parentNodeId: "research_lane", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:convergence", "research_convergence"], detail: { kind: "loop", state: "state" } }),
      node({ id: "research_pass", parentId: "research_convergence::do", parentNodeId: "research_convergence", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:convergence", "research_convergence", "do", "research_pass"] }),
      node({ id: "standard_lane", kind: "if", parentId: "route_candidate::case%3A1", parentNodeId: "route_candidate", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1", "standard_lane"], detail: { kind: "if", condition: "candidate.priority > 1" } }),
      node({ id: "urgent_score", parentId: "standard_lane::then", parentNodeId: "standard_lane", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1", "standard_lane", "then", "urgent_score"] }),
      node({ id: "normal_score", parentId: "standard_lane::else", parentNodeId: "standard_lane", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1", "standard_lane", "else", "normal_score"] }),
      node({ id: "skip_candidate", parentId: "route_candidate::default", parentNodeId: "route_candidate", path: ["root", "candidate_matrix", "do", "route_candidate", "default", "skip_candidate"] }),
    ],
    containers: [
      { id: "candidate_matrix::do", nodeId: "candidate_matrix", kind: "scope", label: "do", path: ["root", "candidate_matrix", "do"], parentId: "candidate_matrix", status: "completed" },
      { id: "route_candidate::case%3A0", nodeId: "route_candidate", kind: "branch", label: 'case: candidate.kind == "research"', path: ["root", "candidate_matrix", "do", "route_candidate", "case:0"], parentId: "route_candidate", status: "completed" },
      { id: "route_candidate::case%3A1", nodeId: "route_candidate", kind: "branch", label: "case: candidate.ready && candidate.score >= minScore", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1"], parentId: "route_candidate", status: "completed" },
      { id: "route_candidate::default", nodeId: "route_candidate", kind: "branch", label: "default", path: ["root", "candidate_matrix", "do", "route_candidate", "default"], parentId: "route_candidate", status: "completed" },
      { id: "research_lane::branch%3Ascorecard", nodeId: "research_lane", kind: "branch", label: "branch: scorecard", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:scorecard"], parentId: "research_lane", status: "completed" },
      { id: "research_lane::branch%3Aconvergence", nodeId: "research_lane", kind: "branch", label: "branch: convergence", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:convergence"], parentId: "research_lane", status: "completed" },
      { id: "research_convergence::do", nodeId: "research_convergence", kind: "scope", label: "do", path: ["root", "candidate_matrix", "do", "route_candidate", "case:0", "research_lane", "branch:convergence", "research_convergence", "do"], parentId: "research_convergence", status: "completed" },
      { id: "standard_lane::then", nodeId: "standard_lane", kind: "branch", label: "then", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1", "standard_lane", "then"], parentId: "standard_lane", status: "completed" },
      { id: "standard_lane::else", nodeId: "standard_lane", kind: "branch", label: "else", path: ["root", "candidate_matrix", "do", "route_candidate", "case:1", "standard_lane", "else"], parentId: "standard_lane", status: "completed" },
    ],
    edges: [],
    selectors: [],
    runtimeStates: [],
    groups: [],
  };
}

function compositeGraph(): WebGraph {
  return {
    workflow: { name: "web-composite-agent" },
    mode: "runtime",
    nodes: [
      node({ id: "execution", kind: "parallel", detail: { kind: "parallel", branches: ["lane_matrix", "agent_preview", "race_preview"], strategy: "all" } }),
      node({ id: "lanes", kind: "fanout", parentId: "execution::branch%3Alane_matrix", parentNodeId: "execution", path: ["root", "execution", "branch:lane_matrix", "lanes"], detail: { kind: "fanout", over: "input.lanes", strategy: "all" } }),
      node({ id: "route", kind: "switch", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "route"], detail: { kind: "switch", cases: ["item.mode == auto"], hasDefault: true } }),
      node({ id: "auto_route", parentId: "route::case%3A0", parentNodeId: "route", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "case:0", "auto_route"] }),
      node({ id: "manual_route", parentId: "route::default", parentNodeId: "route", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "default", "manual_route"] }),
      node({ id: "repair_loop", kind: "loop", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "repair_loop"], detail: { kind: "loop", state: "state" } }),
      node({ id: "score_gate", kind: "assert", parentId: "lanes::do", parentNodeId: "lanes", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "score_gate"], detail: { kind: "assert", condition: "score >= min" } }),
      node({ id: "agent_gate", kind: "if", parentId: "execution::branch%3Aagent_preview", parentNodeId: "execution", path: ["root", "execution", "branch:agent_preview", "agent_gate"], detail: { kind: "if", condition: "input.runAgents" } }),
      node({ id: "reviewer_agent", kind: "agent", parentId: "agent_gate::then", parentNodeId: "agent_gate", path: ["root", "execution", "branch:agent_preview", "agent_gate", "then", "reviewer_agent"], detail: { kind: "agent", agent: "reviewer", use: "codex" } }),
      node({ id: "skip_agent", parentId: "agent_gate::else", parentNodeId: "agent_gate", path: ["root", "execution", "branch:agent_preview", "agent_gate", "else", "skip_agent"] }),
      node({ id: "race", kind: "parallel", parentId: "execution::branch%3Arace_preview", parentNodeId: "execution", path: ["root", "execution", "branch:race_preview", "race"], detail: { kind: "parallel", branches: ["cache", "compute"], strategy: "race" } }),
      node({ id: "cache_hit", parentId: "race::branch%3Acache", parentNodeId: "race", path: ["root", "execution", "branch:race_preview", "race", "branch:cache", "cache_hit"] }),
      node({ id: "compute_value", parentId: "race::branch%3Acompute", parentNodeId: "race", path: ["root", "execution", "branch:race_preview", "race", "branch:compute", "compute_value"] }),
      node({ id: "operator_gate", kind: "if", detail: { kind: "if", condition: "input.requireSignal" } }),
      node({ id: "operator_signal", kind: "signal", parentId: "operator_gate::then", parentNodeId: "operator_gate", path: ["root", "operator_gate", "then", "operator_signal"], detail: { kind: "signal", outputSchema: "{ ok }" } }),
      node({ id: "auto_operator_gate", parentId: "operator_gate::else", parentNodeId: "operator_gate", path: ["root", "operator_gate", "else", "auto_operator_gate"] }),
      node({ id: "final_gate", kind: "assert", detail: { kind: "assert", condition: "nodes.operator_gate.output.ok" } }),
    ],
    containers: [
      { id: "execution::branch%3Alane_matrix", nodeId: "execution", kind: "branch", label: "branch: lane_matrix", path: ["root", "execution", "branch:lane_matrix"], parentId: "execution", status: "completed" },
      { id: "execution::branch%3Aagent_preview", nodeId: "execution", kind: "branch", label: "branch: agent_preview", path: ["root", "execution", "branch:agent_preview"], parentId: "execution", status: "completed" },
      { id: "execution::branch%3Arace_preview", nodeId: "execution", kind: "branch", label: "branch: race_preview", path: ["root", "execution", "branch:race_preview"], parentId: "execution", status: "completed" },
      { id: "lanes::do", nodeId: "lanes", kind: "scope", label: "do", path: ["root", "execution", "branch:lane_matrix", "lanes", "do"], parentId: "lanes", status: "completed" },
      { id: "route::case%3A0", nodeId: "route", kind: "branch", label: "case: auto", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "case:0"], parentId: "route", status: "completed" },
      { id: "route::default", nodeId: "route", kind: "branch", label: "default", path: ["root", "execution", "branch:lane_matrix", "lanes", "do", "route", "default"], parentId: "route", status: "completed" },
      { id: "agent_gate::then", nodeId: "agent_gate", kind: "branch", label: "then", path: ["root", "execution", "branch:agent_preview", "agent_gate", "then"], parentId: "agent_gate", status: "not_started" },
      { id: "agent_gate::else", nodeId: "agent_gate", kind: "branch", label: "else", path: ["root", "execution", "branch:agent_preview", "agent_gate", "else"], parentId: "agent_gate", status: "completed" },
      { id: "race::branch%3Acache", nodeId: "race", kind: "branch", label: "branch: cache", path: ["root", "execution", "branch:race_preview", "race", "branch:cache"], parentId: "race", status: "cancelled" },
      { id: "race::branch%3Acompute", nodeId: "race", kind: "branch", label: "branch: compute", path: ["root", "execution", "branch:race_preview", "race", "branch:compute"], parentId: "race", status: "completed" },
      { id: "operator_gate::then", nodeId: "operator_gate", kind: "branch", label: "then", path: ["root", "operator_gate", "then"], parentId: "operator_gate", status: "not_started" },
      { id: "operator_gate::else", nodeId: "operator_gate", kind: "branch", label: "else", path: ["root", "operator_gate", "else"], parentId: "operator_gate", status: "completed" },
    ],
    edges: [
      { id: "execution->operator_gate", source: "execution", target: "operator_gate", kind: "sequence" },
      { id: "operator_gate->final_gate", source: "operator_gate", target: "final_gate", kind: "sequence" },
      { id: "route->repair_loop", source: "route", target: "repair_loop", kind: "sequence" },
      { id: "repair_loop->score_gate", source: "repair_loop", target: "score_gate", kind: "sequence" },
      { id: "execution->lane_matrix", source: "execution", target: "execution::branch%3Alane_matrix", kind: "branch" },
      { id: "execution->agent_preview", source: "execution", target: "execution::branch%3Aagent_preview", kind: "branch" },
      { id: "execution->race_preview", source: "execution", target: "execution::branch%3Arace_preview", kind: "branch" },
    ],
    selectors: [],
    runtimeStates: [],
    groups: [],
  };
}
