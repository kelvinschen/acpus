import type {
  NodeDetail,
  WebGraph,
  WebGraphContainer,
  WebGraphEdge,
  WebGraphNode,
  WebGraphSelection,
  WebGraphSelector,
  WebGraphSelectorOption,
} from "./graph-types.js";
import { displayNodeStatus, displayRunStatus, isActiveDisplayStatus, type DisplayStatus } from "./runtime-status.js";

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
const sequenceGap = 72;
const laneGap = 36;
const canvasPadding = 48;
const visualOverflowPadding = 24;
const minFitPadding = 12;
const maxFitPadding = 32;
const fitPaddingFactor = 0.045;
const minZoomFactor = 0.75;
const maxScale = 2;
const wheelZoomSensitivity = 0.0008;
const pinchZoomSensitivity = 1 / 100;
const selectedVisibilityMargin = 48;
const maxViewportBoundaryPadding = 80;
const viewportBoundaryPaddingFactor = 0.2;
const graphItemZIndexBase = 1;
const graphItemZIndexMax = 18;

export const graphCanvasPadding = canvasPadding;
export const graphMaxScale = maxScale;
export const graphSelectedVisibilityMargin = selectedVisibilityMargin;

export function graphItemZIndex(depth: number): number {
  return graphItemZIndexBase + Math.min(Math.max(0, depth), graphItemZIndexMax - graphItemZIndexBase);
}

export function graphEdgeZIndex(edge: WebGraphEdge, parentOf: ReadonlyMap<string, string>): number {
  const parentId = parentOf.get(edge.source);
  if (parentId === undefined || parentId !== parentOf.get(edge.target)) return 0;
  // Edge SVGs precede boxes in the DOM, so the sibling node layer still covers endpoints.
  return graphItemZIndex(depth(parentId, parentOf) + 1);
}

export type GraphSelections = Record<string, string>;
export type GraphViewport = { x: number; y: number; scale: number };

export type GraphNavigationIntent =
  | { type: "navigate-item"; renderId: string }
  | { type: "recenter"; point: { x: number; y: number } };

export type GraphNodeTarget = {
  renderId: string;
  target: string;
  nodeId: string;
  label: string;
  context: WebGraphSelection[];
  displayStatus: DisplayStatus;
  detail?: NodeDetail;
};

export type RenderItem = {
  id: string;
  type: "node" | "container";
  kind: string;
  label: string;
  status: DisplayStatus;
  rawStatus: string;
  dimmed: boolean;
  directActive: boolean;
  active: boolean;
  children: string[];
  path: string[];
  context: WebGraphSelection[];
  nodeId: string;
  target?: string;
  parentId?: string;
  node?: WebGraphNode;
  container?: WebGraphContainer;
  selector?: WebGraphSelector;
  selectedOptionId?: string;
  occurrence?: { id: string; kind: "fanout-item"; itemIndex: number };
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

export function selectorOptionLabel(_selector: WebGraphSelector, option: WebGraphSelectorOption): string {
  return `iter ${option.iteration}`;
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

  const normalizedSelections = normalizeSelections(graph, selections);
  const canonicalItems = new Map<string, WebGraphNode | WebGraphContainer>([
    ...graph.nodes.map(node => [node.id, node] as const),
    ...graph.containers.map(container => [container.id, container] as const),
  ]);
  const canonicalIds = new Set(canonicalItems.keys());
  const canonicalParentOf = safeParents([
    ...graph.containers.map(container => ({ id: container.id, parentId: container.parentId })),
    ...graph.nodes.map(node => parentRef(node.id, node.parentId)),
  ], canonicalIds);
  const canonicalChildrenByParent = new Map<string, string[]>();
  for (const id of canonicalItems.keys()) {
    const parentId = canonicalParentOf.get(id) ?? "";
    canonicalChildrenByParent.set(parentId, [...(canonicalChildrenByParent.get(parentId) ?? []), id]);
  }
  const canonicalRank = rankItems(graph);
  for (const [parentId, children] of canonicalChildrenByParent) {
    canonicalChildrenByParent.set(parentId, orderChildren(children, graph.edges, canonicalRank));
  }

  const items = new Map<string, RenderItem>();
  const parentOf = new Map<string, string>();
  const renderedChildrenByParent = new Map<string, string[]>();
  const renderedByCanonicalContext = new Map<string, string>();
  const renderRank = new Map<string, number>();
  let nextRank = 0;

  const addItem = (item: RenderItem, parentId: string | undefined) => {
    items.set(item.id, item);
    renderRank.set(item.id, nextRank++);
    if (parentId) parentOf.set(item.id, parentId);
    const key = parentId ?? "";
    renderedChildrenByParent.set(key, [...(renderedChildrenByParent.get(key) ?? []), item.id]);
  };

  const instantiate = (canonicalId: string, context: WebGraphSelection[], parentId?: string): void => {
    const canonical = canonicalItems.get(canonicalId);
    if (!canonical) return;
    const id = renderItemId(canonical.id, context);
    if (items.has(id)) return;
    const node = isWebGraphNode(canonical) ? canonical : undefined;
    const type = node ? "node" : "container";
    const runtimeState = runtimeStateFor(graph, canonical.id, context);
    const rawStatus = runtimeState?.status
      ?? (graph.mode === "runtime" && graph.runtimeStates.some(state => state.targetId === canonical.id)
        ? "not_started"
        : canonical.status);
    const status = displayNodeStatus(rawStatus);
    const selector = type === "node" ? selectorFor(graph, canonical.nodeId, context) : undefined;
    const selectedOptionId = selector ? normalizedSelections[selector.id] : undefined;
    const item: RenderItem = {
      id,
      type,
      kind: canonical.kind,
      label: canonical.label,
      status,
      rawStatus,
      dimmed: false,
      directActive: isActiveStatus(status),
      active: isActiveStatus(status),
      children: [],
      path: canonical.path,
      context,
      nodeId: canonical.nodeId,
      ...(node ? { target: runtimeState?.target ?? node.target } : {}),
      ...(type === "node" ? { node: { ...canonical, status } as WebGraphNode } : { container: { ...canonical, status } as WebGraphContainer }),
      ...(parentId ? { parentId } : {}),
      ...(selector ? { selector } : {}),
      ...(selectedOptionId ? { selectedOptionId } : {}),
    };
    addItem(item, parentId);
    renderedByCanonicalContext.set(canonicalContextKey(canonical.id, context), id);

    const children = canonicalChildrenByParent.get(canonical.id) ?? [];
    if (type === "container" && canonical.kind === "scope") {
      const owner = graph.nodes.find(node => node.id === canonical.nodeId);
      if (owner?.detail?.kind === "fanout") {
        const occurrence = graph.fanoutOccurrences.find(candidate =>
          candidate.nodeId === owner.nodeId
          && candidate.targetId === canonical.id
          && sameContext(candidate.context, context),
        );
        if (occurrence && occurrence.items.length > 0) {
          for (const fanoutItem of [...occurrence.items].sort((a, b) => a.itemIndex - b.itemIndex)) {
            const occurrenceId = fanoutItemId(fanoutItem.id, fanoutItem.context);
            const occurrenceStatus = displayNodeStatus(fanoutItem.status);
            addItem({
              id: occurrenceId,
              type: "container",
              kind: "fanout-item",
              label: fanoutItem.label,
              status: occurrenceStatus,
              rawStatus: fanoutItem.status,
              dimmed: false,
              directActive: isActiveStatus(occurrenceStatus),
              active: isActiveStatus(occurrenceStatus),
              children: [],
              path: [...canonical.path, fanoutItem.label],
              context: fanoutItem.context,
              nodeId: owner.nodeId,
              parentId: id,
              occurrence: { id: fanoutItem.id, kind: "fanout-item", itemIndex: fanoutItem.itemIndex },
            }, id);
            for (const childId of children) instantiate(childId, fanoutItem.context, occurrenceId);
          }
          return;
        }
      }
      if (owner?.detail?.kind === "loop") {
        const loopSelector = selectorFor(graph, owner.nodeId, context);
        const selected = loopSelector?.options.find(option => option.id === normalizedSelections[loopSelector.id]);
        const bodyContext = selected?.context ?? context;
        for (const childId of children) instantiate(childId, bodyContext, id);
        return;
      }
    }
    for (const childId of children) instantiate(childId, context, id);
  };

  for (const rootId of canonicalChildrenByParent.get("") ?? []) instantiate(rootId, []);

  const edges = graph.edges.flatMap(edge => {
    const rendered: WebGraphEdge[] = [];
    for (const source of items.values()) {
      if (source.occurrence || source.node?.id !== edge.source && source.container?.id !== edge.source) continue;
      const targetId = renderedByCanonicalContext.get(canonicalContextKey(edge.target, source.context));
      if (!targetId) continue;
      rendered.push({
        ...edge,
        id: source.context.length === 0 ? edge.id : `${edge.id}@${contextKey(source.context)}`,
        source: source.id,
        target: targetId,
      });
    }
    return rendered;
  });

  for (const [id, item] of items) {
    item.children = orderChildren(renderedChildrenByParent.get(id) ?? [], edges, renderRank);
  }
  applyDisplayRuntimeState(graph, items, parentOf);

  return {
    mode: graph.mode,
    items,
    rootIds: orderChildren(renderedChildrenByParent.get("") ?? [], edges, renderRank),
    edges,
    parentOf,
  };
}

export function normalizeSelections(graph: WebGraph, current: GraphSelections): GraphSelections {
  const next: GraphSelections = {};
  for (const selector of graph.selectors) {
    const option = selector.options.find(candidate => candidate.id === current[selector.id])
      ?? selector.options.find(candidate => candidate.id === selector.defaultOptionId)
      ?? selector.options.at(-1);
    if (option) next[selector.id] = option.id;
  }
  return next;
}

export function selectionsForActiveRuntime(graph: WebGraph, current: GraphSelections): GraphSelections {
  const next = normalizeSelections(graph, current);
  if (graph.mode !== "runtime") return next;
  const activeContexts = graph.runtimeStates
    .filter(state => isActiveStatus(displayNodeStatus(state.status)))
    .map(state => state.context);

  for (const selector of graph.selectors) {
    const option = selector.options
      .filter(candidate => activeContexts.some(context => isContextPrefix(candidate.context, context)))
      .sort((left, right) => left.iteration - right.iteration)
      .at(-1);
    if (option) next[selector.id] = option.id;
  }
  return next;
}

export function graphNodeTarget(item: RenderItem | undefined): GraphNodeTarget | undefined {
  if (!item || item.type !== "node" || item.target === undefined) return undefined;
  return {
    renderId: item.id,
    target: item.target,
    nodeId: item.nodeId,
    label: item.label,
    context: item.context,
    displayStatus: item.status,
    ...(item.node?.detail === undefined ? {} : { detail: item.node.detail }),
  };
}

export function graphContextLabel(context: readonly WebGraphSelection[]): string | undefined {
  if (context.length === 0) return undefined;
  return context.map(selection => selection.kind === "fanout"
    ? `${selection.nodeId} item[${selection.itemIndex}]`
    : `${selection.nodeId} iter ${selection.iteration}`).join(" / ");
}

export type ActiveFocus = {
  reason: "single-active" | "multiple-active";
  targetId?: string;
  activeRenderIds: string[];
};

export function activeFocus(model: RenderModel): ActiveFocus | undefined {
  const candidates = [...model.items.values()].filter(item => item.directActive);
  const frontier = candidates.filter(candidate =>
    !candidates.some(other => other.id !== candidate.id && isAncestor(candidate.id, other.id, model.parentOf)),
  );
  if (frontier.length === 0) return undefined;
  if (frontier.length === 1) {
    return { reason: "single-active", targetId: frontier[0]!.id, activeRenderIds: [frontier[0]!.id] };
  }
  const targetId = deepestCommonAncestor(frontier.map(item => item.id), model.parentOf);
  return {
    reason: "multiple-active",
    ...(targetId ? { targetId } : {}),
    activeRenderIds: frontier.map(item => item.id),
  };
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
    if (item.occurrence) return padding;
    return item.container?.kind === "scope" ? scopeContainerPadding : branchContainerPadding;
  }

  const measureChildren = (ids: string[], items: ReadonlyMap<string, RenderItem>): Size => {
    if (ids.length === 0) return { width: 0, height: 0 };
    const layout = childLayout(ids, items);
    const childSizes = ids.map(measureItem);
    if (layout === "horizontal") {
      return {
        width: childSizes.reduce((sum, size) => sum + size.width, 0) + sequenceGap * (childSizes.length - 1),
        height: Math.max(...childSizes.map(size => size.height)),
      };
    }
    return {
      width: Math.max(...childSizes.map(size => size.width)),
      height: childSizes.reduce((sum, size) => sum + size.height, 0) + laneGap * (childSizes.length - 1),
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
      childrenSize,
    );
  };

  const placeChildren = (ids: string[], x: number, y: number, group: Size) => {
    const layout = childLayout(ids, model.items);
    if (layout === "horizontal") {
      let cursor = x;
      for (const id of ids) {
        const size = measureItem(id);
        placeItem(id, cursor, y + (group.height - size.height) / 2);
        cursor += size.width + sequenceGap;
      }
      return;
    }
    let cursor = y;
    for (const id of ids) {
      const size = measureItem(id);
      placeItem(id, x + (group.width - size.width) / 2, cursor);
      cursor += size.height + laneGap;
    }
  };

  placeChildren(model.rootIds, canvasPadding, canvasPadding, rootSize);

  const width = rootSize.width + canvasPadding * 2;
  const height = rootSize.height + canvasPadding * 2;
  return {
    boxes,
    edgePaths: buildEdgePaths(model.edges, boxes, model.parentOf, activeEdgeIds(model)),
    width,
    height,
  };
}

function buildEdgePaths(
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

    const start = { x: source.x + source.width, y: source.y + source.height / 2 };
    const end = { x: target.x, y: target.y + target.height / 2 };
    const d = edge.kind === "loop" || end.x < start.x
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
  const start = projectPoint({ x: source.x + source.width, y: source.y + source.height / 2 }, viewport);
  const end = projectPoint({ x: target.x, y: target.y + target.height / 2 }, viewport);
  const d = edge.kind === "loop" || end.x < start.x
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

export function clampViewport(
  viewport: GraphViewport,
  layout: Pick<RenderLayout, "width" | "height">,
  rect: RectLike,
): GraphViewport {
  if (viewport.scale <= 0 || layout.width <= 0 || layout.height <= 0 || rect.width <= 0 || rect.height <= 0) return viewport;
  const bounds = visualBoundsForLayout(layout);
  const x = clampViewportAxis(viewport.x, viewport.scale, bounds.x, bounds.width, rect.width);
  const y = clampViewportAxis(viewport.y, viewport.scale, bounds.y, bounds.height, rect.height);
  return x === viewport.x && y === viewport.y ? viewport : { ...viewport, x, y };
}

function clampViewportAxis(offset: number, scale: number, start: number, size: number, viewportSize: number): number {
  const contentSize = size * scale;
  const projectedStart = start * scale;
  const padding = Math.min(maxViewportBoundaryPadding, viewportSize * viewportBoundaryPaddingFactor);
  if (contentSize + padding * 2 <= viewportSize) return (viewportSize - contentSize) / 2 - projectedStart;
  return clamp(
    offset,
    viewportSize - padding - (start + size) * scale,
    padding - projectedStart,
  );
}

export function focusView(box: PlacedBox | undefined, rect: RectLike, padding = 56): GraphViewport | undefined {
  if (!box || box.width <= 0 || box.height <= 0 || rect.width <= 0 || rect.height <= 0) return undefined;
  const availableWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2);
  const scale = clamp(Math.min(availableWidth / box.width, availableHeight / box.height, 1.15), 0.05, maxScale);
  return {
    x: rect.width / 2 - (box.x + box.width / 2) * scale,
    y: rect.height / 2 - (box.y + box.height / 2) * scale,
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

export function wheelZoomScale(
  currentScale: number,
  wheel: { deltaY: number; ctrlKey: boolean },
  minScale: number,
  maxScaleValue: number,
): number {
  const sensitivity = wheel.ctrlKey ? pinchZoomSensitivity : wheelZoomSensitivity;
  return clamp(currentScale * Math.exp(-wheel.deltaY * sensitivity), minScale, maxScaleValue);
}

export function zoomViewport(viewport: GraphViewport, scale: number, px: number, py: number): GraphViewport {
  return {
    x: px - ((px - viewport.x) / viewport.scale) * scale,
    y: py - ((py - viewport.y) / viewport.scale) * scale,
    scale,
  };
}

export function centerViewportAt(viewport: GraphViewport, rect: RectLike, point: Point): GraphViewport {
  if (viewport.scale <= 0 || rect.width <= 0 || rect.height <= 0) return viewport;
  return {
    ...viewport,
    x: rect.width / 2 - point.x * viewport.scale,
    y: rect.height / 2 - point.y * viewport.scale,
  };
}

export function planGraphNavigation(
  model: Pick<RenderModel, "items">,
  layout: Pick<RenderLayout, "boxes">,
  viewport: GraphViewport,
  rect: RectLike,
  intent: GraphNavigationIntent,
): { viewport?: GraphViewport; inspectionTarget?: GraphNodeTarget } | undefined {
  if (intent.type === "recenter") {
    return { viewport: centerViewportAt(viewport, rect, intent.point) };
  }

  const item = model.items.get(intent.renderId);
  if (!item) return undefined;
  const nextViewport = focusView(layout.boxes.get(item.id), rect);
  const inspectionTarget = graphNodeTarget(item);
  if (!nextViewport && !inspectionTarget) return undefined;
  return {
    ...(nextViewport === undefined ? {} : { viewport: nextViewport }),
    ...(inspectionTarget === undefined ? {} : { inspectionTarget }),
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

function runtimeStateFor(
  graph: WebGraph,
  targetId: string,
  context: readonly WebGraphSelection[],
): WebGraph["runtimeStates"][number] | undefined {
  if (graph.mode === "static") return undefined;
  const states = graph.runtimeStates.filter(state => state.targetId === targetId);
  if (states.length === 0) return undefined;
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index]!;
    if (sameContext(state.context, context)) return state;
  }
  return undefined;
}

function selectorFor(graph: WebGraph, nodeId: string, context: readonly WebGraphSelection[]): WebGraphSelector | undefined {
  return graph.selectors.find(selector => selector.nodeId === nodeId && sameContext(selector.context, context));
}

function sameContext(left: readonly WebGraphSelection[], right: readonly WebGraphSelection[]): boolean {
  return left.length === right.length && left.every((selection, index) => sameSelection(selection, right[index]!));
}

function isContextPrefix(prefix: readonly WebGraphSelection[], context: readonly WebGraphSelection[]): boolean {
  return prefix.length <= context.length && prefix.every((selection, index) => sameSelection(selection, context[index]!));
}

function sameSelection(left: WebGraphSelection, right: WebGraphSelection): boolean {
  if (left.kind !== right.kind || left.nodeId !== right.nodeId) return false;
  return left.kind === "fanout"
    ? left.itemIndex === (right as Extract<WebGraphSelection, { kind: "fanout" }>).itemIndex
    : left.iteration === (right as Extract<WebGraphSelection, { kind: "loop" }>).iteration;
}

function isWebGraphNode(item: WebGraphNode | WebGraphContainer): item is WebGraphNode {
  return item.parentId === undefined || "detail" in item || item.kind !== "branch" && item.kind !== "scope";
}

function renderItemId(canonicalId: string, context: readonly WebGraphSelection[]): string {
  return context.length === 0 ? canonicalId : `${canonicalId}@${contextKey(context)}`;
}

function fanoutItemId(id: string, context: readonly WebGraphSelection[]): string {
  return `fanout-item:${encodeURIComponent(id)}@${contextKey(context)}`;
}

function canonicalContextKey(canonicalId: string, context: readonly WebGraphSelection[]): string {
  return `${canonicalId}\0${contextKey(context)}`;
}

function contextKey(context: readonly WebGraphSelection[]): string {
  return context.map(selection => selection.kind === "fanout"
    ? `f:${encodeURIComponent(selection.nodeId)}:${selection.itemIndex}`
    : `l:${encodeURIComponent(selection.nodeId)}:${selection.iteration}`).join("/");
}

function deepestCommonAncestor(ids: string[], parentOf: ReadonlyMap<string, string>): string | undefined {
  const paths = ids.map(id => {
    const path = [id];
    const visited = new Set(path);
    let current = parentOf.get(id);
    while (current && !visited.has(current)) {
      path.push(current);
      visited.add(current);
      current = parentOf.get(current);
    }
    return path.reverse();
  });
  const shortest = Math.min(...paths.map(path => path.length));
  let common: string | undefined;
  for (let index = 0; index < shortest; index += 1) {
    const candidate = paths[0]?.[index];
    if (!candidate || paths.some(path => path[index] !== candidate)) break;
    common = candidate;
  }
  return common;
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

function childLayout(ids: string[], items: ReadonlyMap<string, RenderItem>): "horizontal" | "vertical" {
  if (ids.length <= 1) return "horizontal";
  const allLanes = ids.every(id => {
    const item = items.get(id);
    return item?.type === "container" && (item.container?.kind === "branch" || item.occurrence?.kind === "fanout-item");
  });
  return allLanes ? "vertical" : "horizontal";
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
  if (Math.abs(ty - sy) < 1) return `M ${sx} ${sy} H ${tx - 1}`;
  const midX = sx + Math.max(24, (tx - sx) / 2);
  return `M ${sx} ${sy} H ${midX} V ${ty} H ${tx - 1}`;
}

function loopPath(sx: number, sy: number, tx: number, ty: number, source: PlacedBox, target: PlacedBox): string {
  const sideX = Math.max(source.x + source.width, target.x + target.width) + 22;
  const lowerY = Math.max(source.y + source.height, target.y + target.height) + 22;
  return `M ${sx} ${sy} H ${sideX} V ${lowerY} H ${tx - 24} V ${ty} H ${tx - 1}`;
}
