import type {
  NodeDetail,
  WebGraph,
  WebGraphContainer,
  WebGraphEdge,
  WebGraphNode,
  WebGraphRuntimeState,
  WebGraphSelection,
  WebGraphSelector,
  WebGraphSelectorOption,
} from "./client/api.js";
import { displayNodeStatus, displayRunStatus, isActiveDisplayStatus, normalizeRuntimeStatus, type DisplayStatus } from "./runtime-status.js";

const leafWidth = 200;
const leafHeight = 72;
const compositeMinWidth = 260;
const loopCompositeMinWidth = 340;
const compositeMinHeight = 78;
const containerMinWidth = 220;
const emptyContainerHeight = 64;
const headerHeight = 46;
const padding = 18;
const branchContainerPadding = 32;
const scopeContainerPadding = 56;
const verticalGap = 36;
const branchGap = 36;
const canvasPadding = 48;
const visualOverflowPadding = 24;
const minFitPadding = 12;
const maxFitPadding = 32;
const fitPaddingFactor = 0.045;
const minZoomFactor = 0.75;
const maxScale = 2;
const wheelZoomSensitivity = 0.0008;
const selectedVisibilityMargin = 48;
const graphItemZIndexBase = 1;
const graphItemZIndexMax = 18;

export const graphCanvasPadding = canvasPadding;
export const graphMaxScale = maxScale;
export const graphSelectedVisibilityMargin = selectedVisibilityMargin;

export function graphItemZIndex(depth: number): number {
  return graphItemZIndexBase + Math.min(Math.max(0, depth), graphItemZIndexMax - graphItemZIndexBase);
}

export type GraphSelections = Record<string, string>;
export type GraphViewport = { x: number; y: number; scale: number };

export type RenderItem = {
  id: string;
  type: "node" | "container";
  kind: string;
  label: string;
  status: DisplayStatus;
  rawStatus: string;
  dimmed: boolean;
  active: boolean;
  children: string[];
  path: string[];
  nodeId: string;
  parentId?: string;
  node?: WebGraphNode;
  container?: WebGraphContainer;
  selector?: WebGraphSelector;
  selectedOptionId?: string;
};

export type RenderModel = {
  mode: WebGraph["mode"];
  items: Map<string, RenderItem>;
  rootIds: string[];
  edges: WebGraphEdge[];
  parentOf: Map<string, string>;
};

export type PlacedBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EdgePath = {
  id: string;
  kind: WebGraphEdge["kind"];
  d: string;
  active?: boolean;
};

export type RenderLayout = {
  boxes: Map<string, PlacedBox>;
  edgePaths: EdgePath[];
  width: number;
  height: number;
};

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Bounds = { x: number; y: number; width: number; height: number };
type RectLike = { width: number; height: number };
type ClosestLike = { closest(selector: string): unknown };

export function leafSubtitle(detail: NodeDetail | undefined): string | undefined {
  if (!detail) return undefined;
  switch (detail.kind) {
    case "assert":
      return detail.condition;
    case "signal":
      return detail.outputSchema;
    case "agent":
      return [`use: ${detail.use ?? detail.command ?? detail.agent}`, detail.model].filter(Boolean).join(" · ");
    case "task":
      return detail.inputs.length > 0 ? `input: ${detail.inputs.join(", ")}` : undefined;
    default:
      return undefined;
  }
}

export function compositeDescriptor(detail: NodeDetail | undefined): string | undefined {
  if (!detail) return undefined;
  switch (detail.kind) {
    case "parallel":
      return `${detail.branches.length} branch(es)`;
    case "switch":
      return `${detail.cases.length + (detail.hasDefault ? 1 : 0)} branch(es)`;
    case "if":
      return `Condition: ${detail.condition}`;
    case "fanout":
      return detail.over;
    case "loop":
      return undefined;
    default:
      return undefined;
  }
}

export function selectorOptionLabel(selector: WebGraphSelector, option: WebGraphSelectorOption): string {
  if (selector.kind === "loop" && "iteration" in option) return `iter ${option.iteration}`;
  return option.label;
}

export function selectorStatusSummary(selector: WebGraphSelector, selectedOptionId: string | undefined): { status: DisplayStatus; label: string } | undefined {
  const option = selector.options.find(candidate => candidate.id === selectedOptionId)
    ?? selector.options.find(candidate => candidate.id === selector.defaultOptionId)
    ?? selector.options[0];
  if (!option) return undefined;
  if (selector.kind === "fanout") {
    const completed = selector.options.filter(candidate => normalizeRuntimeStatus(candidate.status) === "completed").length;
    return { status: displayStatus(option.status), label: `${completed}/${selector.options.length}` };
  }
  return { status: displayStatus(option.status), label: displayStatus(option.status).replaceAll("_", " ") };
}

export function compositeBadge(kind: string): string {
  return kind.toUpperCase();
}

export function compositeStrategy(detail: NodeDetail | undefined): string | undefined {
  if (detail?.kind === "parallel" || detail?.kind === "fanout") return detail.strategy.toUpperCase();
  return undefined;
}

export function toRenderModel(graph: WebGraph | undefined, selections: GraphSelections = {}): RenderModel {
  if (!graph) return { mode: "static", items: new Map(), rootIds: [], edges: [], parentOf: new Map() };

  const { selectors, selectedOptions } = resolveGraphSelections(graph, selections);
  const selectorByNodeId = new Map(selectors.map(selector => [selector.nodeId, selector]));
  const ids = new Set([...graph.nodes.map(node => node.id), ...graph.containers.map(container => container.id)]);
  const parentOf = safeParents([
    ...graph.containers.map(container => ({ id: container.id, parentId: container.parentId })),
    ...graph.nodes.map(node => parentRef(node.id, node.parentId ?? node.parentNodeId)),
  ], ids);
  const items = new Map<string, RenderItem>();

  for (const container of graph.containers) {
    const rawStatus = targetStatus(graph, container.id, container.status, selectedOptions);
    const status = displayNodeStatus(rawStatus);
    const parentId = parentOf.get(container.id);
    items.set(container.id, {
      id: container.id,
      type: "container",
      kind: container.kind,
      label: container.label,
      status,
      rawStatus,
      dimmed: false,
      active: isActiveStatus(status),
      children: [],
      path: container.path,
      nodeId: container.nodeId,
      container: { ...container, status },
      ...(parentId ? { parentId } : {}),
    });
  }

  for (const node of graph.nodes) {
    const rawStatus = targetStatus(graph, node.id, node.status, selectedOptions);
    const status = displayNodeStatus(rawStatus);
    const selector = selectorByNodeId.get(node.id);
    const selectedOptionId = selector ? selectedOptions.get(selector.nodeId)?.id ?? selector.defaultOptionId : undefined;
    const parentId = parentOf.get(node.id);
    items.set(node.id, {
      id: node.id,
      type: "node",
      kind: node.kind,
      label: node.label,
      status,
      rawStatus,
      dimmed: false,
      active: isActiveStatus(status),
      children: [],
      path: node.path,
      nodeId: node.nodeId,
      node: { ...node, status },
      ...(parentId ? { parentId } : {}),
      ...(selector ? { selector } : {}),
      ...(selectedOptionId ? { selectedOptionId } : {}),
    });
  }

  const childrenByParent = new Map<string, string[]>();
  for (const id of items.keys()) {
    const parentId = parentOf.get(id) ?? "";
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), id]);
  }
  const rank = rankItems(graph);
  for (const [id, item] of items) {
    item.children = orderChildren(childrenByParent.get(id) ?? [], graph.edges, rank);
  }
  applyDisplayRuntimeState(graph, items, parentOf);

  return {
    mode: graph.mode,
    items,
    rootIds: orderChildren(childrenByParent.get("") ?? [], graph.edges, rank),
    edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    parentOf,
  };
}

export function normalizeSelections(graph: WebGraph, current: GraphSelections): GraphSelections {
  const next: GraphSelections = {};
  const { selectors, selectedOptions } = resolveGraphSelections(graph, current);
  for (const selector of selectors) {
    const option = selectedOptions.get(selector.nodeId);
    if (option) next[selector.nodeId] = option.id;
  }
  return next;
}

export function selectionContext(
  graph: WebGraph | undefined,
  selections: GraphSelections,
  targetId?: string,
  parentOf?: ReadonlyMap<string, string>,
): WebGraphSelection[] {
  if (!graph || graph.mode === "static") return [];
  const resolved = resolveGraphSelections(graph, selections);
  return resolved.selectors.flatMap(selector => {
    if (targetId && parentOf && targetId !== selector.targetId && !isAncestor(selector.targetId, targetId, parentOf)) return [];
    const option = resolved.selectedOptions.get(selector.nodeId);
    return option ? [selectionFromOption(selector, option)] : [];
  });
}

export function safeParents(nodes: Array<{ id: string; parentId?: string }>, ids: Set<string>): Map<string, string> {
  const parentOf = new Map<string, string>();
  const reaches = (from: string, target: string): boolean => {
    const visited = new Set<string>();
    let current: string | undefined = from;
    while (current && !visited.has(current)) {
      if (current === target) return true;
      visited.add(current);
      current = parentOf.get(current);
    }
    return false;
  };
  for (const node of nodes) {
    const parent = node.parentId;
    if (parent === undefined || parent === node.id || !ids.has(parent)) continue;
    if (reaches(parent, node.id)) continue;
    parentOf.set(node.id, parent);
  }
  return parentOf;
}

export function layoutWorkflow(model: RenderModel): RenderLayout {
  const boxes = new Map<string, PlacedBox>();
  const sizes = new Map<string, Size>();
  const measureItem = (id: string): Size => {
    const cached = sizes.get(id);
    if (cached) return cached;
    const item = model.items.get(id);
    if (!item) return { width: 0, height: 0 };

    let size: Size;
    if (item.children.length === 0) {
      if (item.type === "container") size = { width: containerMinWidth, height: emptyContainerHeight };
      else if (isCompositeKind(item.kind)) size = { width: compositeMinWidthFor(item), height: compositeMinHeight };
      else size = { width: leafWidth, height: leafHeight };
    } else {
      const children = measureChildren(item.children, model.items);
      const minWidth = item.type === "container" ? containerMinWidth : compositeMinWidthFor(item);
      const innerPadding = innerPaddingFor(item);
      size = {
        width: Math.max(minWidth, children.width + innerPadding * 2),
        height: headerHeight + innerPadding + children.height + innerPadding,
      };
    }
    sizes.set(id, size);
    return size;
  };

  function compositeMinWidthFor(item: RenderItem): number {
    return item.kind === "loop" ? loopCompositeMinWidth : compositeMinWidth;
  }

  function innerPaddingFor(item: RenderItem): number {
    if (item.type !== "container") return padding;
    return item.container?.kind === "scope" ? scopeContainerPadding : branchContainerPadding;
  }

  const measureChildren = (ids: string[], items: ReadonlyMap<string, RenderItem>): Size => {
    if (ids.length === 0) return { width: 0, height: 0 };
    const layout = branchLayout(ids, items);
    const childSizes = ids.map(measureItem);
    if (layout === "horizontal") {
      return {
        width: childSizes.reduce((sum, size) => sum + size.width, 0) + branchGap * (childSizes.length - 1),
        height: Math.max(...childSizes.map(size => size.height)),
      };
    }
    return {
      width: Math.max(...childSizes.map(size => size.width)),
      height: childSizes.reduce((sum, size) => sum + size.height, 0) + verticalGap * (childSizes.length - 1),
    };
  };

  const rootSize = measureChildren(model.rootIds, model.items);
  const placeItem = (id: string, x: number, y: number) => {
    const item = model.items.get(id);
    if (!item) return;
    const size = measureItem(id);
    boxes.set(id, { id, x, y, width: size.width, height: size.height });
    if (item.children.length === 0) return;
    const childrenSize = measureChildren(item.children, model.items);
    const innerPadding = innerPaddingFor(item);
    placeChildren(
      item.children,
      x + (size.width - childrenSize.width) / 2,
      y + headerHeight + innerPadding,
      childrenSize.width,
      "center",
    );
  };

  const placeChildren = (ids: string[], x: number, y: number, groupWidth: number, align: "left" | "center") => {
    const layout = branchLayout(ids, model.items);
    if (layout === "horizontal") {
      let cursor = x;
      for (const id of ids) {
        const size = measureItem(id);
        placeItem(id, cursor, y);
        cursor += size.width + branchGap;
      }
      return;
    }
    let cursor = y;
    for (const id of ids) {
      const size = measureItem(id);
      placeItem(id, align === "center" ? x + (groupWidth - size.width) / 2 : x, cursor);
      cursor += size.height + verticalGap;
    }
  };

  placeChildren(model.rootIds, canvasPadding, canvasPadding, rootSize.width, "center");

  const width = Math.max(rootSize.width + canvasPadding * 2, 960);
  const height = Math.max(rootSize.height + canvasPadding * 2, 540);
  return {
    boxes,
    edgePaths: buildEdgePaths(model.edges, boxes, model.parentOf, activeEdgeIds(model)),
    width,
    height,
  };
}

export function buildEdgePaths(
  edges: WebGraphEdge[],
  boxes: ReadonlyMap<string, PlacedBox>,
  parentOf: ReadonlyMap<string, string>,
  activeEdgeIds: ReadonlySet<string> = new Set(),
): EdgePath[] {
  const paths: EdgePath[] = [];
  for (const edge of renderableEdges(edges, parentOf)) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;

    const start = { x: source.x + source.width / 2, y: source.y + source.height };
    const end = { x: target.x + target.width / 2, y: target.y };
    const d = edge.kind === "loop" || end.y < start.y
      ? loopPath(start.x, start.y, end.x, end.y, source, target)
      : flowPath(start.x, start.y, end.x, end.y);

    paths.push({ id: edge.id, kind: edge.kind, d, ...(activeEdgeIds.has(edge.id) ? { active: true } : {}) });
  }
  return paths;
}

export function buildProjectedEdgePaths(
  edges: WebGraphEdge[],
  boxes: ReadonlyMap<string, PlacedBox>,
  parentOf: ReadonlyMap<string, string>,
  viewport: GraphViewport,
  activeEdgeIds: ReadonlySet<string> = new Set(),
): EdgePath[] {
  return renderableEdges(edges, parentOf).flatMap(edge => {
    const path = projectEdgePath(edge, boxes, viewport);
    return path ? [{ ...path, ...(activeEdgeIds.has(edge.id) ? { active: true } : {}) }] : [];
  });
}

export function projectEdgePath(
  edge: WebGraphEdge,
  boxes: ReadonlyMap<string, PlacedBox>,
  viewport: GraphViewport,
): EdgePath | undefined {
  const source = boxes.get(edge.source);
  const target = boxes.get(edge.target);
  if (!source || !target) return undefined;
  const sourceBox = projectBox(source, viewport);
  const targetBox = projectBox(target, viewport);
  const start = projectPoint({ x: source.x + source.width / 2, y: source.y + source.height }, viewport);
  const end = projectPoint({ x: target.x + target.width / 2, y: target.y }, viewport);
  const d = edge.kind === "loop" || end.y < start.y
    ? loopPath(start.x, start.y, end.x, end.y, sourceBox, targetBox)
    : flowPath(start.x, start.y, end.x, end.y);
  return { id: edge.id, kind: edge.kind, d };
}

export function renderableEdges(
  edges: WebGraphEdge[],
  parentOf: ReadonlyMap<string, string>,
): WebGraphEdge[] {
  return edges.filter(edge =>
    parentOf.get(edge.source) === parentOf.get(edge.target)
    && !isAncestor(edge.source, edge.target, parentOf)
    && !isAncestor(edge.target, edge.source, parentOf),
  );
}

export function activeEdgeIds(model: RenderModel): Set<string> {
  const ids = new Set<string>();
  for (const edge of renderableEdges(model.edges, model.parentOf)) {
    const source = model.items.get(edge.source);
    const target = model.items.get(edge.target);
    if (!source || !target) continue;
    if (isActiveStatus(source.status) || isActiveStatus(target.status)) ids.add(edge.id);
  }
  return ids;
}

export function projectBoxes(boxes: ReadonlyMap<string, PlacedBox>, viewport: GraphViewport): Map<string, PlacedBox> {
  return new Map([...boxes].map(([id, box]) => [id, projectBox(box, viewport)]));
}

export function projectBox(box: PlacedBox, viewport: GraphViewport): PlacedBox {
  return {
    id: box.id,
    x: viewport.x + box.x * viewport.scale,
    y: viewport.y + box.y * viewport.scale,
    width: box.width * viewport.scale,
    height: box.height * viewport.scale,
  };
}

export function projectPoint(point: Point, viewport: GraphViewport): Point {
  return {
    x: viewport.x + point.x * viewport.scale,
    y: viewport.y + point.y * viewport.scale,
  };
}

export function isLosslessZoom(scale: number): boolean {
  return scale >= 1;
}

export function fitView(
  layout: Pick<RenderLayout, "width" | "height">,
  rect: RectLike,
): GraphViewport {
  if (layout.width <= 0 || layout.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const scale = fitScale(layout, rect);
  return {
    x: (rect.width - layout.width * scale) / 2,
    y: (rect.height - layout.height * scale) / 2,
    scale,
  };
}

export function fitScale(
  layout: Pick<RenderLayout, "width" | "height">,
  rect: RectLike,
): number {
  if (layout.width <= 0 || layout.height <= 0 || rect.width <= 0 || rect.height <= 0) return 1;
  const padding = fitViewportPadding(rect);
  const availableWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2);
  return clamp(Math.min(availableWidth / layout.width, availableHeight / layout.height, 1), 0, maxScale);
}

export function fitViewportPadding(rect: RectLike): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  return clamp(Math.min(rect.width, rect.height) * fitPaddingFactor, minFitPadding, maxFitPadding);
}

export function visualBoundsForLayout(layout: Pick<RenderLayout, "width" | "height">): Bounds {
  return {
    x: -visualOverflowPadding,
    y: -visualOverflowPadding,
    width: layout.width + visualOverflowPadding * 2,
    height: layout.height + visualOverflowPadding * 2,
  };
}

export function minZoomScale(fitScaleValue: number): number {
  return fitScaleValue * minZoomFactor;
}

export function wheelZoomScale(currentScale: number, deltaY: number, minScale: number, maxScaleValue: number): number {
  return clamp(currentScale * Math.exp(-deltaY * wheelZoomSensitivity), minScale, maxScaleValue);
}

export function zoomViewport(viewport: GraphViewport, scale: number, px: number, py: number): GraphViewport {
  return {
    x: px - ((px - viewport.x) / viewport.scale) * scale,
    y: py - ((py - viewport.y) / viewport.scale) * scale,
    scale,
  };
}

export function keepBoxInViewport(
  viewport: GraphViewport,
  rect: RectLike,
  box: PlacedBox | undefined,
  margin = selectedVisibilityMargin,
): GraphViewport {
  if (!box || rect.width <= 0 || rect.height <= 0) return viewport;
  const projected = projectBox(box, viewport);
  const next = { ...viewport };

  const availableWidth = rect.width - margin * 2;
  const availableHeight = rect.height - margin * 2;

  if (projected.width >= availableWidth) {
    next.x += (rect.width - projected.width) / 2 - projected.x;
  } else if (projected.x < margin) {
    next.x += margin - projected.x;
  } else if (projected.x + projected.width > rect.width - margin) {
    next.x -= projected.x + projected.width - (rect.width - margin);
  }

  const adjusted = projectBox(box, next);
  if (adjusted.height >= availableHeight) {
    next.y += (rect.height - adjusted.height) / 2 - adjusted.y;
  } else if (adjusted.y < margin) {
    next.y += margin - adjusted.y;
  } else if (adjusted.y + adjusted.height > rect.height - margin) {
    next.y -= adjusted.y + adjusted.height - (rect.height - margin);
  }

  return next;
}

export function canStartPan(target: ClosestLike | null): boolean {
  if (!target || typeof target.closest !== "function") return false;
  return !target.closest(".graph-toolbar, button, input, select, textarea, a");
}

export function isPanPastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= 4;
}

export function depth(id: string, parentOf: ReadonlyMap<string, string>): number {
  let value = 0;
  const visited = new Set<string>();
  let current = parentOf.get(id);
  while (current && !visited.has(current)) {
    visited.add(current);
    value += 1;
    current = parentOf.get(current);
  }
  return value;
}

export function isCompositeKind(kind: string): boolean {
  return kind === "if" || kind === "switch" || kind === "parallel" || kind === "fanout" || kind === "loop";
}

function parentRef(id: string, parentId: string | undefined): { id: string; parentId?: string } {
  return parentId === undefined ? { id } : { id, parentId };
}

export function displayStatus(status: string): DisplayStatus {
  return normalizeRuntimeStatus(status);
}

function targetStatus(
  graph: WebGraph,
  targetId: string,
  fallback: string,
  selectedOptions: ReadonlyMap<string, WebGraphSelectorOption>,
): string {
  if (graph.mode === "static") return fallback;
  const states = graph.runtimeStates.filter(state => state.targetId === targetId);
  if (states.length === 0) return fallback;
  return states.find(state => runtimeStateMatches(state, selectedOptions))?.status ?? "not_started";
}

function runtimeStateMatches(
  state: WebGraphRuntimeState,
  selectedOptions: ReadonlyMap<string, WebGraphSelectorOption>,
): boolean {
  return state.selectors.every(selection => {
    const option = selectedOptions.get(selection.nodeId);
    return option !== undefined && sameSelection(selection, option);
  });
}

function sameSelection(selection: WebGraphSelection, option: WebGraphSelectorOption): boolean {
  if (selection.kind === "fanout") {
    return "itemIndex" in option && selection.itemIndex === option.itemIndex;
  }
  return "iteration" in option && selection.iteration === option.iteration;
}

function selectionFromOption(selector: WebGraphSelector, option: WebGraphSelectorOption): WebGraphSelection {
  if ("itemIndex" in option) {
    return {
      nodeId: selector.nodeId,
      kind: "fanout",
      itemIndex: option.itemIndex,
    };
  }
  return {
    nodeId: selector.nodeId,
    kind: "loop",
    iteration: option.iteration,
  };
}

function resolveGraphSelections(
  graph: WebGraph,
  selections: GraphSelections,
): { selectors: WebGraphSelector[]; selectedOptions: Map<string, WebGraphSelectorOption> } {
  const pending = [...graph.selectors];
  const selectors: WebGraphSelector[] = [];
  const selectedOptions = new Map<string, WebGraphSelectorOption>();

  while (pending.length > 0) {
    const index = pending.findIndex(selector =>
      selector.options.every(option => option.parentSelections.every(parent => selectedOptions.has(parent.nodeId))),
    );
    if (index < 0) break;
    const selector = pending.splice(index, 1)[0]!;
    const options = selector.options.filter(option => option.parentSelections.every(parent => {
      const selected = selectedOptions.get(parent.nodeId);
      return selected !== undefined && sameSelection(parent, selected);
    }));
    const option = options.find(candidate => candidate.id === selections[selector.nodeId])
      ?? options.find(candidate => candidate.id === selector.defaultOptionId)
      ?? options.at(-1)
      ?? options[0];
    if (!option) continue;
    const defaultOptionId = options.some(candidate => candidate.id === selector.defaultOptionId)
      ? selector.defaultOptionId
      : options.at(-1)?.id;
    selectors.push({
      nodeId: selector.nodeId,
      kind: selector.kind,
      targetId: selector.targetId,
      options,
      ...(defaultOptionId === undefined ? {} : { defaultOptionId }),
    });
    selectedOptions.set(selector.nodeId, option);
  }

  return { selectors, selectedOptions };
}

function rankItems(graph: WebGraph): Map<string, number> {
  const rank = new Map<string, number>();
  let index = 0;
  for (const container of graph.containers) rank.set(container.id, index++);
  for (const node of graph.nodes) rank.set(node.id, index++);
  return rank;
}

function orderChildren(ids: string[], edges: WebGraphEdge[], rank: ReadonlyMap<string, number>): string[] {
  const idSet = new Set(ids);
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const byRank = (a: string, b: string) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
  const ready = ids.filter(id => (indegree.get(id) ?? 0) === 0).sort(byRank);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort(byRank);
      }
    }
  }
  return ordered.length === ids.length ? ordered : [...ids].sort(byRank);
}

function branchLayout(ids: string[], items: ReadonlyMap<string, RenderItem>): "horizontal" | "vertical" {
  if (ids.length <= 1) return "vertical";
  const allBranches = ids.every(id => {
    const item = items.get(id);
    return item?.type === "container" && item.container?.kind === "branch";
  });
  return allBranches ? "horizontal" : "vertical";
}

function applyDisplayRuntimeState(graph: WebGraph, items: Map<string, RenderItem>, parentOf: ReadonlyMap<string, string>): void {
  deriveSkippedDisplayStatus(graph, items, parentOf);
  const hasActiveDescendant = (id: string): boolean => {
    const item = items.get(id);
    if (!item) return false;
    if (isActiveStatus(item.status)) return true;
    return item.children.some(hasActiveDescendant);
  };
  for (const item of items.values()) {
    item.active = hasActiveDescendant(item.id);
    item.dimmed = graph.mode === "runtime" && (item.status === "not_started" || item.status === "skipped");
  }
}

function deriveSkippedDisplayStatus(graph: WebGraph, items: Map<string, RenderItem>, parentOf: ReadonlyMap<string, string>): void {
  if (graph.mode !== "runtime" || !isCompletedTerminalRun(graph.workflow.status)) return;
  const markSkippedTree = (id: string) => {
    const item = items.get(id);
    if (!item || item.status !== "not_started") return;
    item.status = "skipped";
    for (const child of item.children) markSkippedTree(child);
  };

  const childrenByParent = new Map<string, string[]>();
  for (const id of items.keys()) {
    const parent = parentOf.get(id);
    if (!parent) continue;
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), id]);
  }

  for (const siblings of childrenByParent.values()) {
    if (siblings.length < 2) continue;
    const hasExecutedSibling = siblings.some(id => {
      const status = items.get(id)?.status;
      return status !== undefined && status !== "not_started" && status !== "skipped";
    });
    if (!hasExecutedSibling) continue;
    for (const id of siblings) markSkippedTree(id);
  }
}

function isCompletedTerminalRun(status: string | undefined): boolean {
  const display = displayRunStatus(status);
  return display === "completed" || display === "canceled";
}

function isActiveStatus(status: string | undefined): boolean {
  return isActiveDisplayStatus(status);
}

function isAncestor(ancestor: string, id: string, parentOf: ReadonlyMap<string, string>): boolean {
  const visited = new Set<string>();
  let current = parentOf.get(id);
  while (current && !visited.has(current)) {
    if (current === ancestor) return true;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function flowPath(sx: number, sy: number, tx: number, ty: number): string {
  const midY = sy + Math.max(24, (ty - sy) / 2);
  return `M ${sx} ${sy} V ${midY} H ${tx} V ${ty - 1}`;
}

function loopPath(sx: number, sy: number, tx: number, ty: number, source: PlacedBox, target: PlacedBox): string {
  const sideX = Math.max(source.x + source.width, target.x + target.width) + 22;
  return `M ${sx} ${sy} V ${sy + 24} H ${sideX} V ${ty - 24} H ${tx} V ${ty - 1}`;
}
