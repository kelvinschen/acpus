import type { WebGraphEdge } from "../../graph-types.js";
import { isActiveDisplayStatus } from "../../runtime-status.js";
import {
  depth,
  isAncestor,
  isCompositeKind,
  type RenderItem,
  type RenderModel,
} from "./model.js";

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
const scopeContainerPadding = 48;
const sequenceGap = 72;
const laneGap = 36;
const canvasPadding = 48;
const graphItemZIndexBase = 1;
const graphItemZIndexMax = 18;

export const graphCanvasPadding = canvasPadding;

export type PlacedBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  flowY: number;
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

type Size = { width: number; height: number; flowY: number };
type ChildGroup = { width: number; height: number; flowY: number };
type Point = { x: number; y: number };

export function graphItemZIndex(itemDepth: number): number {
  return graphItemZIndexBase
    + Math.min(Math.max(0, itemDepth), graphItemZIndexMax - graphItemZIndexBase);
}

export function graphEdgeZIndex(edge: WebGraphEdge, parentOf: ReadonlyMap<string, string>): number {
  const parentId = parentOf.get(edge.source);
  if (parentId === undefined || parentId !== parentOf.get(edge.target)) return 0;
  // Edge SVGs precede boxes in the DOM, so the sibling node layer still covers endpoints.
  return graphItemZIndex(depth(parentId, parentOf) + 1);
}

export function layoutWorkflow(model: RenderModel): RenderLayout {
  const boxes = new Map<string, PlacedBox>();
  const sizes = new Map<string, Size>();
  const measureItem = (id: string): Size => {
    const cached = sizes.get(id);
    if (cached) return cached;
    const item = model.items.get(id);
    if (!item) return { width: 0, height: 0, flowY: 0 };

    let size: Size;
    if (item.children.length === 0) {
      if (item.type === "container") {
        size = { width: containerMinWidth, height: emptyContainerHeight, flowY: emptyContainerHeight / 2 };
      } else if (isCompositeKind(item.kind)) {
        size = { width: compositeMinWidthFor(item), height: compositeMinHeight, flowY: compositeMinHeight / 2 };
      } else {
        size = { width: leafWidth, height: leafHeight, flowY: leafHeight / 2 };
      }
    } else {
      const children = measureChildren(item.children, model.items, item.container?.kind !== "scope");
      const minWidth = item.type === "container" ? containerMinWidth : compositeMinWidthFor(item);
      const innerPadding = innerPaddingFor(item);
      const height = headerHeight + innerPadding + children.height + innerPadding;
      const exposesDoFlow = item.type === "node"
        && (item.kind === "loop" || item.kind === "fanout");
      const exposesScopeFlow = item.container?.kind === "scope";
      size = {
        width: Math.max(minWidth, children.width + innerPadding * 2),
        height,
        flowY: exposesScopeFlow || exposesDoFlow
          ? headerHeight + innerPadding + children.flowY
          : height / 2,
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

  const measureChildren = (
    ids: string[],
    items: ReadonlyMap<string, RenderItem>,
    alignFlow: boolean,
  ): ChildGroup => {
    if (ids.length === 0) return { width: 0, height: 0, flowY: 0 };
    const layout = childLayout(ids, items);
    const childSizes = ids.map(measureItem);
    if (layout === "horizontal") {
      const childFlows = childSizes.map(size => alignFlow ? size.flowY : size.height / 2);
      const flowY = Math.max(...childFlows);
      return {
        width: childSizes.reduce((sum, size) => sum + size.width, 0) + sequenceGap * (childSizes.length - 1),
        height: flowY + Math.max(...childSizes.map((size, index) => size.height - childFlows[index]!)),
        flowY,
      };
    }
    const height = childSizes.reduce((sum, size) => sum + size.height, 0) + laneGap * (childSizes.length - 1);
    return {
      width: Math.max(...childSizes.map(size => size.width)),
      height,
      flowY: height / 2,
    };
  };

  const rootSize = measureChildren(model.rootIds, model.items, true);
  const placeItem = (id: string, x: number, y: number, flowY: number) => {
    const item = model.items.get(id);
    if (!item) return;
    const size = measureItem(id);
    boxes.set(id, {
      id,
      x,
      y,
      width: size.width,
      height: size.height,
      flowY,
    });
    if (item.children.length === 0) return;
    const alignFlow = item.container?.kind !== "scope";
    const childrenSize = measureChildren(item.children, model.items, alignFlow);
    const innerPadding = innerPaddingFor(item);
    placeChildren(
      item.children,
      x + (size.width - childrenSize.width) / 2,
      y + headerHeight + innerPadding,
      childrenSize,
      alignFlow,
    );
  };

  const placeChildren = (ids: string[], x: number, y: number, group: ChildGroup, alignFlow: boolean) => {
    const layout = childLayout(ids, model.items);
    if (layout === "horizontal") {
      let cursor = x;
      for (const id of ids) {
        const size = measureItem(id);
        const flowY = alignFlow ? size.flowY : size.height / 2;
        placeItem(id, cursor, y + group.flowY - flowY, flowY);
        cursor += size.width + sequenceGap;
      }
      return;
    }
    let cursor = y;
    for (const id of ids) {
      const size = measureItem(id);
      placeItem(id, x + (group.width - size.width) / 2, cursor, size.height / 2);
      cursor += size.height + laneGap;
    }
  };

  placeChildren(model.rootIds, canvasPadding, canvasPadding, rootSize, true);

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
  activeIds: ReadonlySet<string> = new Set(),
): EdgePath[] {
  const paths: EdgePath[] = [];
  for (const edge of renderableEdges(edges, parentOf)) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;

    const start = { x: source.x + source.width, y: boxFlowY(source) };
    const end = { x: target.x, y: boxFlowY(target) };
    paths.push(edgePathForBoxes(edge, source, target, start, end, activeIds.has(edge.id)));
  }
  return paths;
}

export function edgePathForBoxes(
  edge: WebGraphEdge,
  source: PlacedBox,
  target: PlacedBox,
  start: Point,
  end: Point,
  active = false,
): EdgePath {
  const d = edge.kind === "loop" || end.x < start.x
    ? loopPath(start.x, start.y, end.x, end.y, source, target)
    : flowPath(start.x, start.y, end.x, end.y);
  return { id: edge.id, kind: edge.kind, d, ...(active ? { active: true } : {}) };
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
    if (isActiveDisplayStatus(source.status) || isActiveDisplayStatus(target.status)) ids.add(edge.id);
  }
  return ids;
}

function childLayout(ids: string[], items: ReadonlyMap<string, RenderItem>): "horizontal" | "vertical" {
  if (ids.length <= 1) return "horizontal";
  const allLanes = ids.every(id => {
    const item = items.get(id);
    return item?.type === "container"
      && (item.container?.kind === "branch" || item.occurrence?.kind === "fanout-item");
  });
  return allLanes ? "vertical" : "horizontal";
}

function flowPath(sx: number, sy: number, tx: number, ty: number): string {
  if (Math.abs(ty - sy) < 1) return `M ${sx} ${sy} H ${tx - 1}`;
  const midX = sx + Math.max(24, (tx - sx) / 2);
  return `M ${sx} ${sy} H ${midX} V ${ty} H ${tx - 1}`;
}

function loopPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  source: PlacedBox,
  target: PlacedBox,
): string {
  const sideX = Math.max(source.x + source.width, target.x + target.width) + 22;
  const lowerY = Math.max(source.y + source.height, target.y + target.height) + 22;
  return `M ${sx} ${sy} H ${sideX} V ${lowerY} H ${tx - 24} V ${ty} H ${tx - 1}`;
}

function boxFlowY(box: PlacedBox): number {
  return box.y + box.flowY;
}
