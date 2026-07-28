// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebGraph } from "../src/graph-types.js";
import { RunGraph } from "../src/client/ui/RunGraph.js";
import { installReactActEnvironment } from "./support/react-act-environment.js";

const context = [{ nodeId: "jobs", kind: "fanout" as const, itemIndex: 0 }];

const graph: WebGraph = {
  workflow: { name: "fanout", runId: "run-1", status: "running" },
  mode: "runtime",
  nodes: [
    { id: "jobs", nodeId: "jobs", kind: "fanout", label: "jobs", path: ["root", "jobs"], detail: { kind: "fanout", over: "input.jobs", strategy: "all" }, status: "running" },
    { id: "work", nodeId: "work", kind: "task", label: "work", path: ["root", "jobs", "do", "work"], parentId: "jobs::do", detail: { kind: "task", input: "input.jobs", target: "inline" }, status: "running" },
  ],
  containers: [
    { id: "jobs::do", nodeId: "jobs", kind: "scope", label: "do", path: ["root", "jobs", "do"], parentId: "jobs", status: "running" },
  ],
  edges: [],
  fanoutOccurrences: [{
    id: "jobs",
    nodeId: "jobs",
    targetId: "jobs::do",
    context: [],
    status: "running",
    items: [{ id: "jobs.0", itemIndex: 0, label: "item[0]", status: "running", context }],
  }],
  selectors: [],
  runtimeStates: [
    { targetId: "jobs", status: "running", context: [] },
    { targetId: "work", status: "running", context },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let restoreReactActEnvironment = () => {};

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  vi.spyOn(console, "error");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 900,
    bottom: 600,
    left: 0,
    width: 900,
    height: 600,
    toJSON: () => ({}),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  const consoleErrors = [...vi.mocked(console.error).mock.calls];
  container.remove();
  vi.restoreAllMocks();
  restoreReactActEnvironment();
  expect(consoleErrors).toEqual([]);
});

describe("RunGraph interaction semantics", () => {
  it("keeps structures non-interactive and returns an exact node occurrence target", async () => {
    const onSelectNode = vi.fn();
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode })));

    const structures = [...container.querySelectorAll<HTMLElement>(".graph-container")];
    expect(structures).toHaveLength(2);
    expect(structures.map(item => [item.getAttribute("role"), item.getAttribute("tabindex")])).toEqual([
      ["group", null],
      ["group", null],
    ]);
    const current = container.querySelector<HTMLButtonElement>(".locate-active")!;
    const navigator = container.querySelector<HTMLButtonElement>(".graph-navigator-trigger")!;
    expect(current.disabled).toBe(false);
    expect(current.textContent).toBe("");
    expect(current.title).toBe("Locate current work");
    expect(navigator.textContent).toBe("");
    expect(navigator.title).toBe("Navigate graph nodes");
    expect(container.querySelector(".node-detail, .composite-descriptor")).toBeNull();
    expect(container.textContent).not.toContain("input.jobs");

    const work = [...container.querySelectorAll<HTMLElement>(".graph-box.node")]
      .find(item => item.textContent?.includes("work"))!;
    expect(work.getAttribute("aria-label")).toBe("Node work · jobs item[0] · running");
    await act(async () => work.click());

    expect(onSelectNode).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: "work",
      label: "work",
      context,
      displayStatus: "running",
      detail: { kind: "task", input: "input.jobs", target: "inline" },
    }));
    expect(onSelectNode.mock.lastCall?.[0].renderId).not.toBe("work");
  });

  it("keeps a loop selector beside, rather than inside, its inspect button", async () => {
    const loopGraph: WebGraph = {
      workflow: { name: "loop", runId: "run-loop", status: "running" },
      mode: "runtime",
      nodes: [
        { id: "repeat", nodeId: "repeat", kind: "loop", label: "repeat", path: ["root", "repeat"], detail: { kind: "loop", state: "state" }, status: "running" },
      ],
      containers: [
        { id: "repeat::do", nodeId: "repeat", kind: "scope", label: "do", path: ["root", "repeat", "do"], parentId: "repeat", status: "running" },
      ],
      edges: [],
      fanoutOccurrences: [],
      selectors: [{
        id: "repeat-frame",
        nodeId: "repeat",
        kind: "loop",
        targetId: "repeat::do",
        context: [],
        defaultOptionId: "iter-0",
        options: [{ id: "iter-0", iteration: 0, context: [{ nodeId: "repeat", kind: "loop", iteration: 0 }] }],
      }],
      runtimeStates: [{ targetId: "repeat", status: "running", context: [] }],
    };

    await act(async () => root.render(React.createElement(RunGraph, { graph: loopGraph, onSelectNode: vi.fn() })));

    const loop = container.querySelector<HTMLElement>(".graph-box.node.loop")!;
    const inspect = loop.querySelector<HTMLButtonElement>("button.composite-open")!;
    const selector = loop.querySelector<HTMLButtonElement>("button.graph-selector")!;
    expect(loop.getAttribute("role")).toBe("group");
    expect(inspect.getAttribute("aria-label")).toBe("Node repeat · running");
    expect(inspect.contains(selector)).toBe(false);
  });

  it("does not announce runtime status for a static graph node", async () => {
    const staticGraph: WebGraph = {
      workflow: { name: "static" },
      mode: "static",
      nodes: [
        { id: "prepare", nodeId: "prepare", kind: "task", label: "prepare", path: ["root", "prepare"], status: "not_started" },
      ],
      containers: [],
      edges: [],
      fanoutOccurrences: [],
      selectors: [],
      runtimeStates: [],
    };

    await act(async () => root.render(React.createElement(RunGraph, { graph: staticGraph, onSelectNode: vi.fn() })));

    expect(container.querySelector<HTMLElement>(".graph-box.node")?.getAttribute("aria-label")).toBe("Node prepare");
    expect(container.querySelector(".runtime-status-stamp")).toBeNull();
    expect(container.querySelector("nav[aria-label='Graph path']")).toBeNull();
  });

  it("uses one semantic status stamp in the shared top-right node slot", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const nodes = [...container.querySelectorAll<HTMLElement>(".graph-box.node")];
    const stamps = [...container.querySelectorAll<HTMLElement>(".runtime-status-stamp")];

    expect(stamps).toHaveLength(nodes.length);
    for (const stamp of stamps) {
      expect(stamp.parentElement?.classList.contains("graph-box")).toBe(true);
      expect(stamp.parentElement?.classList.contains("node")).toBe(true);
      expect(stamp.classList.contains("running")).toBe(true);
      expect(stamp.getAttribute("role")).toBe("img");
      expect(stamp.title).toBe("running");
      expect(stamp.querySelector("svg")?.getAttribute("width")).toBe("20");
      expect(stamp.closest(".node-card-head, .composite-title")).toBeNull();
    }
    expect(container.querySelector(".graph-container .runtime-status-stamp")).toBeNull();
  });

  it("makes composite headers inspectable without making structural containers interactive", async () => {
    const onSelectNode = vi.fn();
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode })));

    const composite = container.querySelector<HTMLButtonElement>(".graph-box.node.fanout .composite-open")!;
    await act(async () => composite.click());

    expect(onSelectNode).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: "jobs",
      detail: { kind: "fanout", over: "input.jobs", strategy: "all" },
    }));
    expect(container.querySelector<HTMLElement>(".graph-container")?.getAttribute("role")).toBe("group");
  });

  it("provides a breadcrumb, node finder, and clickable overview for graph navigation", async () => {
    const onSelectNode = vi.fn();
    await act(async () => root.render(React.createElement(RunGraph, {
      graph,
      selectedRenderId: "work@f:jobs:0",
      onSelectNode,
    })));

    expect(container.querySelector("nav[aria-label='Graph path']")?.textContent).toContain("item[0]");
    expect(container.querySelector("nav[aria-label='Graph path'] button")?.textContent).not.toBe("Workflow");
    expect(container.querySelectorAll("[aria-label='Fit graph to view']")).toHaveLength(1);
    const minimap = container.querySelector<HTMLButtonElement>("[aria-label='Navigate graph overview']")!;
    expect(minimap).not.toBeNull();

    const structuralPathItem = [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Graph path'] button")]
      .find(item => item.textContent === "item[0]")!;
    const selectionCount = onSelectNode.mock.calls.length;
    const viewportState = () => {
      const canvas = container.querySelector<HTMLElement>(".graph-canvas")!;
      const workBox = [...container.querySelectorAll<HTMLElement>(".graph-box.node")]
        .find(item => item.textContent?.includes("work"))!;
      return [canvas.style.transform, workBox.style.left, workBox.style.top].join("|");
    };
    const initialViewport = viewportState();
    await act(async () => structuralPathItem.click());
    const structuralViewport = viewportState();
    expect(structuralViewport).not.toBe(initialViewport);
    await act(async () => minimap.click());
    expect(viewportState()).not.toBe(structuralViewport);
    expect(onSelectNode).toHaveBeenCalledTimes(selectionCount);

    const trigger = container.querySelector<HTMLButtonElement>("[aria-label='Open graph navigator']")!;
    await act(async () => trigger.click());

    const finder = document.querySelector<HTMLInputElement>("[aria-label='Find graph node']");
    expect(finder).not.toBeNull();
    const work = [...document.querySelectorAll<HTMLButtonElement>("[data-graph-node]")]
      .find(item => item.dataset.graphNode?.startsWith("work@"))!;
    await act(async () => work.click());

    expect(onSelectNode).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: "work",
      context,
    }));
  });

  it("keeps structural container outlines out of the minimap", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    expect(container.querySelectorAll(".graph-minimap-item.container")).toHaveLength(0);
    expect(container.querySelectorAll(".graph-minimap-item.node").length).toBeGreaterThan(0);
  });

  it("uses a filled, un-stroked marker for sequence arrows", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const arrow = container.querySelector("marker#graph-arrow path");
    expect(arrow?.getAttribute("fill")).toBe("currentColor");
    expect(arrow?.getAttribute("stroke")).toBe("none");
  });

  it("layers a fanout item's pipeline edge above its structural background", async () => {
    const pipelineGraph: WebGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "gate", nodeId: "gate", kind: "if", label: "gate", path: ["root", "jobs", "do", "gate"], parentId: "jobs::do", detail: { kind: "if", condition: "item.ready" }, status: "running" },
      ],
      edges: [{ id: "work->gate", source: "work", target: "gate", kind: "sequence" }],
      runtimeStates: [
        ...graph.runtimeStates,
        { targetId: "gate", status: "running", context },
      ],
    };

    await act(async () => root.render(React.createElement(RunGraph, { graph: pipelineGraph, onSelectNode: vi.fn() })));

    const edge = container.querySelector<SVGPathElement>(".graph-edge.sequence")!;
    const layer = edge.closest<SVGSVGElement>("svg.graph-edges")!;
    const item = container.querySelector<HTMLElement>(".graph-container.fanout-item")!;
    const child = container.querySelector<HTMLElement>(".graph-box.node.task")!;

    expect(layer.dataset.edgeLayer).toBe("4");
    expect(Number(layer.style.zIndex)).toBeGreaterThan(Number(item.style.zIndex));
    expect(Number(layer.style.zIndex)).toBe(Number(child.style.zIndex));
  });
});
