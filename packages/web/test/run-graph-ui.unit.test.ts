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
    { id: "jobs", nodeId: "jobs", target: "jobs", kind: "fanout", label: "jobs", path: ["root", "jobs"], detail: { kind: "fanout", over: "input.jobs", strategy: "all" }, status: "running" },
    { id: "work", nodeId: "work", target: "work", kind: "task", label: "work", path: ["root", "jobs", "do", "work"], parentId: "jobs::do", detail: { kind: "task", input: "input.jobs", target: "inline" }, status: "running" },
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
    { targetId: "jobs", target: "jobs", status: "running", context: [] },
    { targetId: "work", target: "@1a2b3c4d5e6f", status: "running", context },
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
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 176,
    bottom: 56,
    left: 0,
    width: 176,
    height: 56,
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
  it("gives a leaf node label its own row and combines kind icon with the kind badge", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const leaf = [...container.querySelectorAll<HTMLElement>(".graph-box.node.task")]
      .find(item => item.textContent?.includes("work"))!;
    const meta = leaf.querySelector<HTMLElement>(".node-card-meta")!;
    const badge = meta.querySelector<HTMLElement>(".type-badge")!;
    const label = leaf.querySelector<HTMLElement>(".node-card-label")!;

    expect(badge.textContent).toBe("TASK");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(meta.contains(label)).toBe(false);
    expect(label.textContent).toBe("work");
    expect(label.title).toBe("work");
  });

  it("labels the workflow-level inspector as Workflow", async () => {
    const onSelectWorkflow = vi.fn();
    await act(async () => root.render(React.createElement(RunGraph, {
      graph,
      onSelectNode: vi.fn(),
      onSelectWorkflow,
    })));

    const workflow = container.querySelector<HTMLButtonElement>(".workflow-io")!;
    expect(workflow.textContent).toBe("Workflow");
    expect(workflow.title).toBe("Inspect workflow");
    expect(workflow.getAttribute("aria-label")).toBe("Inspect workflow");
    await act(async () => workflow.click());
    expect(onSelectWorkflow).toHaveBeenCalledOnce();
  });

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
      target: "@1a2b3c4d5e6f",
      kind: "task",
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
        { id: "repeat", nodeId: "repeat", target: "repeat", kind: "loop", label: "repeat", path: ["root", "repeat"], detail: { kind: "loop", state: "state" }, status: "running" },
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
      runtimeStates: [{ targetId: "repeat", target: "repeat", status: "running", context: [] }],
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
        { id: "prepare", nodeId: "prepare", target: "prepare", kind: "task", label: "prepare", path: ["root", "prepare"], status: "not_started" },
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
      expect(stamp.closest(".node-card-meta, .composite-title")).toBeNull();
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
      target: "jobs",
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
    const fitView = container.querySelector<HTMLButtonElement>("[aria-label='Fit graph to view']")!;
    expect(fitView.querySelector("svg.lucide-shrink")).not.toBeNull();
    expect(container.querySelector("[aria-label='Zoom graph out']")).toBeNull();
    expect(container.querySelector("[aria-label='Zoom graph in']")).toBeNull();
    const locateCurrent = container.querySelector<HTMLButtonElement>(".locate-active")!;
    const focusSelected = container.querySelector<HTMLButtonElement>("[aria-label='Focus selected graph node']")!;
    expect(locateCurrent.querySelector("svg.lucide-locate-fixed")).not.toBeNull();
    expect(focusSelected.querySelector("svg.lucide-focus")).not.toBeNull();
    expect(focusSelected.querySelector("svg.lucide-locate-fixed")).toBeNull();
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
      target: "@1a2b3c4d5e6f",
      context,
    }));
  });

  it("preserves the scale encoded by a trackpad pinch wheel event", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const shell = container.querySelector<HTMLElement>(".graph-flow-shell")!;
    const work = [...container.querySelectorAll<HTMLElement>(".graph-box.node")]
      .find(item => item.textContent?.includes("work"))!;
    const initialWidth = Number.parseFloat(work.style.width);
    const gestureScale = 1.1;
    const pinch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 450,
      clientY: 300,
      ctrlKey: true,
      deltaY: -100 * Math.log(gestureScale),
    });

    await act(async () => shell.dispatchEvent(pinch));

    expect(pinch.defaultPrevented).toBe(true);
    expect(Number.parseFloat(work.style.width) / initialWidth).toBeCloseTo(gestureScale);
  });

  it("keeps graph content in range after an extreme pan gesture", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const shell = container.querySelector<HTMLElement>(".graph-flow-shell")!;
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 300 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      return event;
    };
    const panPastBoundary = async () => act(async () => {
      shell.dispatchEvent(pointer("pointerdown", 450));
      shell.dispatchEvent(pointer("pointermove", 10_450));
      shell.dispatchEvent(pointer("pointerup", 10_450));
    });
    const boxPositions = () => [...container.querySelectorAll<HTMLElement>(".graph-box.node")]
      .map(box => `${box.style.left},${box.style.top}`);

    await panPastBoundary();
    const boundaryPositions = boxPositions();
    await panPastBoundary();

    expect(boxPositions()).toEqual(boundaryPositions);
  });

  it("renders topology, composite outlines, and leaf nodes without structural containers", async () => {
    const topologyGraph: WebGraph = {
      ...graph,
      nodes: [
        { id: "prepare", nodeId: "prepare", target: "prepare", kind: "task", label: "prepare", path: ["root", "prepare"], detail: { kind: "task", input: "input", target: "inline" }, status: "completed" },
        ...graph.nodes,
      ],
      edges: [{ id: "prepare->jobs", source: "prepare", target: "jobs", kind: "sequence" }],
    };
    await act(async () => root.render(React.createElement(RunGraph, {
      graph: topologyGraph,
      onSelectNode: vi.fn(),
    })));

    expect(container.querySelectorAll(".graph-minimap-item.container")).toHaveLength(0);
    expect(container.querySelectorAll(".graph-minimap-edge").length).toBeGreaterThan(0);
    const composite = container.querySelector<SVGRectElement>(".graph-minimap-item.node.composite.fanout")!;
    const leaf = container.querySelector<SVGRectElement>(".graph-minimap-item.node.leaf.task")!;
    expect(composite).not.toBeNull();
    expect(composite.getAttribute("rx")).toBe("0");
    expect(leaf).not.toBeNull();
    expect(leaf.getAttribute("rx")).toBe("4");
    expect(composite.compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("omits the duplicate fit frame and keeps a partial viewport closed inside the minimap", async () => {
    const fitGraph: WebGraph = { ...graph, mode: "static", runtimeStates: [], fanoutOccurrences: [] };
    await act(async () => root.render(React.createElement(RunGraph, { graph: fitGraph, onSelectNode: vi.fn() })));

    const svg = container.querySelector<SVGSVGElement>(".graph-minimap svg")!;
    expect(svg.querySelector(".graph-minimap-viewport")).toBeNull();
    expect(svg.querySelector(".graph-minimap-viewport-shade")).toBeNull();

    const shell = container.querySelector<HTMLElement>(".graph-flow-shell")!;
    const zoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 450,
      clientY: 300,
      ctrlKey: true,
      deltaY: -100 * Math.log(2),
    });
    await act(async () => shell.dispatchEvent(zoom));

    const viewport = svg.querySelector<SVGRectElement>(".graph-minimap-viewport")!;
    const [, , graphWidth, graphHeight] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    const x = Number(viewport.getAttribute("x"));
    const y = Number(viewport.getAttribute("y"));
    const width = Number(viewport.getAttribute("width"));
    const height = Number(viewport.getAttribute("height"));

    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(graphWidth!);
    expect(y + height).toBeLessThanOrEqual(graphHeight!);
    expect(svg.querySelector(".graph-minimap-viewport-shade")).not.toBeNull();
  });

  it("uses a filled, un-stroked marker for sequence arrows", async () => {
    await act(async () => root.render(React.createElement(RunGraph, { graph, onSelectNode: vi.fn() })));

    const arrow = container.querySelector("marker#graph-arrow path");
    expect(arrow?.getAttribute("fill")).toBe("currentColor");
    expect(arrow?.getAttribute("stroke")).toBe("none");
  });

  it("renders a directional arrowhead on Loop return edges", async () => {
    const loopGraph: WebGraph = {
      workflow: { name: "loop-return" },
      mode: "static",
      nodes: [
        { id: "repeat", nodeId: "repeat", target: "repeat", kind: "loop", label: "repeat", path: ["root", "repeat"], detail: { kind: "loop", state: "state" }, status: "not_started" },
        { id: "first", nodeId: "first", target: "first", kind: "task", label: "first", path: ["root", "repeat", "do", "first"], parentId: "repeat::do", status: "not_started" },
        { id: "last", nodeId: "last", target: "last", kind: "task", label: "last", path: ["root", "repeat", "do", "last"], parentId: "repeat::do", status: "not_started" },
      ],
      containers: [
        { id: "repeat::do", nodeId: "repeat", kind: "scope", label: "do", path: ["root", "repeat", "do"], parentId: "repeat", status: "not_started" },
      ],
      edges: [
        { id: "first->last", source: "first", target: "last", kind: "sequence" },
        { id: "last->first", source: "last", target: "first", kind: "loop" },
      ],
      fanoutOccurrences: [],
      selectors: [],
      runtimeStates: [],
    };

    await act(async () => root.render(React.createElement(RunGraph, { graph: loopGraph, onSelectNode: vi.fn() })));

    const marker = container.querySelector<SVGPathElement>(".graph-edge.loop")?.getAttribute("marker-end");
    expect(marker).not.toBeNull();
    expect(marker).toMatch(/^url\(#graph-arrow/);
  });

  it("layers a fanout item's pipeline edge above its structural background", async () => {
    const pipelineGraph: WebGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "gate", nodeId: "gate", target: "gate", kind: "if", label: "gate", path: ["root", "jobs", "do", "gate"], parentId: "jobs::do", detail: { kind: "if", condition: "item.ready" }, status: "running" },
      ],
      edges: [{ id: "work->gate", source: "work", target: "gate", kind: "sequence" }],
      runtimeStates: [
        ...graph.runtimeStates,
        { targetId: "gate", target: "@gate-in-item-0", status: "running", context },
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
