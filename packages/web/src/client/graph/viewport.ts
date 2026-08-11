import type { WebGraphEdge } from "../../graph-types.js";
import { graphNodeTarget, type GraphNodeTarget, type RenderModel } from "./model.js";
import {
  edgePathForBoxes,
  renderableEdges,
  type EdgePath,
  type PlacedBox,
  type RenderLayout,
} from "./layout.js";

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

export const graphMaxScale = maxScale;
export const graphSelectedVisibilityMargin = selectedVisibilityMargin;

export type GraphViewport = { x: number; y: number; scale: number };

export type GraphNavigationIntent =
  | { type: "navigate-item"; renderId: string }
  | { type: "recenter"; point: { x: number; y: number } };

type Point = { x: number; y: number };
type Bounds = { x: number; y: number; width: number; height: number };
type RectLike = { width: number; height: number };
type ClosestLike = { closest(selector: string): unknown };

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

function projectEdgePath(
  edge: WebGraphEdge,
  boxes: ReadonlyMap<string, PlacedBox>,
  viewport: GraphViewport,
): EdgePath | undefined {
  const source = boxes.get(edge.source);
  const target = boxes.get(edge.target);
  if (!source || !target) return undefined;
  const sourceBox = projectBox(source, viewport);
  const targetBox = projectBox(target, viewport);
  const start = projectPoint({ x: source.x + source.width, y: source.y + source.flowY }, viewport);
  const end = projectPoint({ x: target.x, y: target.y + target.flowY }, viewport);
  return edgePathForBoxes(edge, sourceBox, targetBox, start, end);
}

export function projectBoxes(
  boxes: ReadonlyMap<string, PlacedBox>,
  viewport: GraphViewport,
): Map<string, PlacedBox> {
  return new Map([...boxes].map(([id, box]) => [id, projectBox(box, viewport)]));
}

function projectBox(box: PlacedBox, viewport: GraphViewport): PlacedBox {
  return {
    id: box.id,
    x: viewport.x + box.x * viewport.scale,
    y: viewport.y + box.y * viewport.scale,
    width: box.width * viewport.scale,
    height: box.height * viewport.scale,
    flowY: box.flowY * viewport.scale,
  };
}

function projectPoint(point: Point, viewport: GraphViewport): Point {
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
  if (viewport.scale <= 0 || layout.width <= 0 || layout.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    return viewport;
  }
  const bounds = visualBoundsForLayout(layout);
  const x = clampViewportAxis(viewport.x, viewport.scale, bounds.x, bounds.width, rect.width);
  const y = clampViewportAxis(viewport.y, viewport.scale, bounds.y, bounds.height, rect.height);
  return x === viewport.x && y === viewport.y ? viewport : { ...viewport, x, y };
}

function clampViewportAxis(
  offset: number,
  scale: number,
  start: number,
  size: number,
  viewportSize: number,
): number {
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

function fitViewportPadding(rect: RectLike): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  return clamp(Math.min(rect.width, rect.height) * fitPaddingFactor, minFitPadding, maxFitPadding);
}

function visualBoundsForLayout(layout: Pick<RenderLayout, "width" | "height">): Bounds {
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

export function zoomViewport(
  viewport: GraphViewport,
  scale: number,
  px: number,
  py: number,
): GraphViewport {
  return {
    x: px - ((px - viewport.x) / viewport.scale) * scale,
    y: py - ((py - viewport.y) / viewport.scale) * scale,
    scale,
  };
}

function centerViewportAt(viewport: GraphViewport, rect: RectLike, point: Point): GraphViewport {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
