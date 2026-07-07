import { memo, useEffect, useMemo, useRef, useState } from "react";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import Braces from "lucide-react/dist/esm/icons/braces.js";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check.js";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed.js";
import CircleEllipsis from "lucide-react/dist/esm/icons/circle-ellipsis.js";
import CirclePause from "lucide-react/dist/esm/icons/circle-pause.js";
import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import GitFork from "lucide-react/dist/esm/icons/git-fork.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import Repeat from "lucide-react/dist/esm/icons/repeat.js";
import Rows3 from "lucide-react/dist/esm/icons/rows-3.js";
import Scan from "lucide-react/dist/esm/icons/scan.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SkipForward from "lucide-react/dist/esm/icons/skip-forward.js";
import Split from "lucide-react/dist/esm/icons/split.js";
import Terminal from "lucide-react/dist/esm/icons/terminal.js";
import type { WebGraph, WebGraphSelection } from "../api.js";
import {
  activeEdgeIds,
  buildProjectedEdgePaths,
  canStartPan,
  compositeBadge,
  compositeDescriptor,
  compositeStrategy,
  depth,
  fitScale,
  fitView,
  graphCanvasPadding,
  graphItemZIndex,
  graphMaxScale,
  graphSelectedVisibilityMargin,
  isCompositeKind,
  isLosslessZoom,
  isPanPastThreshold,
  keepBoxInViewport,
  layoutWorkflow,
  leafSubtitle,
  minZoomScale,
  normalizeSelections,
  projectBoxes,
  selectionContext,
  selectorOptionLabel,
  toRenderModel,
  wheelZoomScale,
  zoomViewport,
  type GraphSelections,
  type GraphViewport,
  type PlacedBox,
  type RenderItem,
} from "../../graph-renderer.js";
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";
import type { DisplayStatus } from "../../runtime-status.js";
import { Button } from "./shadcn/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shadcn/select.js";

type LucideIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
}>;

type DragState = { pointerId: number; startX: number; startY: number; viewport: GraphViewport; moved: boolean; selectNodeId?: string };

const KIND_ICONS: Record<string, LucideIcon> = {
  task: Terminal,
  agent: Bot,
  signal: Radio,
  assert: ShieldCheck,
  if: GitFork,
  switch: GitBranch,
  parallel: Rows3,
  fanout: Split,
  loop: Repeat,
};

function KindIcon({ kind, size }: { kind: string; size: number }) {
  const Icon = KIND_ICONS[kind] ?? Terminal;
  return <Icon size={size} strokeWidth={1.75} />;
}

const STATUS_ICONS: Record<string, LucideIcon> = {
  queued: CircleDashed,
  running: LoaderCircle,
  awaiting: CircleEllipsis,
  paused: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  canceled: Ban,
  skipped: SkipForward,
};

function StatusGlyph({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  if (display === "not_started") return null;
  const Icon = STATUS_ICONS[display] ?? CircleDashed;
  const emphatic = display === "completed" || display === "failed";
  return (
    <span className={`runtime-status-glyph ${display}`} title={runtimeStatusLabel(display)} aria-label={runtimeStatusLabel(display)}>
      <Icon size={emphatic ? 15 : 14} strokeWidth={emphatic ? 3 : 2.15} />
    </span>
  );
}

function GraphEmptyState() {
  return (
    <div className="graph-empty" role="group" aria-labelledby="graph-empty-title" aria-describedby="graph-empty-detail">
      <Rows3 size={22} strokeWidth={1.75} aria-hidden="true" />
      <strong id="graph-empty-title">Graph view is empty</strong>
      <p id="graph-empty-detail">Open a run with workflow structure; if the run just loaded, the graph will appear when details arrive.</p>
    </div>
  );
}

export function RunGraph({
  graph,
  selectedNodeId,
  onSelectNode,
  onSelectWorkflow,
}: {
  graph: WebGraph | undefined;
  selectedNodeId?: string;
  onSelectNode(id: string | undefined, context?: WebGraphSelection[], displayStatus?: DisplayStatus): void;
  onSelectWorkflow?(): void;
}) {
  const [selections, setSelections] = useState<GraphSelections>({});
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, scale: 1 });
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const selectionsRef = useRef<GraphSelections>({});
  const viewportRef = useRef<GraphViewport>({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const userViewportRef = useRef(false);
  const viewportAnimationTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!graph) return;
    setSelections(current => normalizeSelections(graph, current));
  }, [graph]);

  useEffect(() => {
    selectionsRef.current = selections;
  }, [selections]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const model = useMemo(() => toRenderModel(graph, selections), [graph, selections]);
  const contextForTarget = (targetId: string | undefined) => targetId ? selectionContext(graph, selections, targetId, model.parentOf) : [];
  const displayStatusForTarget = (targetId: string | undefined): DisplayStatus | undefined => targetId ? model.items.get(targetId)?.status : undefined;
  const layout = useMemo(() => layoutWorkflow(model), [model]);
  const layoutKey = `${graph?.mode ?? "none"}:${graph?.workflow.runId ?? graph?.workflow.name ?? "graph"}:${layout.width}x${layout.height}`;
  const activeEdges = useMemo(() => activeEdgeIds(model), [model]);
  const losslessZoom = isLosslessZoom(viewport.scale);
  const renderedBoxes = useMemo(() => losslessZoom ? projectBoxes(layout.boxes, viewport) : layout.boxes, [layout.boxes, losslessZoom, viewport]);
  const renderedEdgePaths = useMemo(
    () => losslessZoom ? buildProjectedEdgePaths(model.edges, layout.boxes, model.parentOf, viewport, activeEdges) : layout.edgePaths,
    [activeEdges, layout.boxes, layout.edgePaths, losslessZoom, model.edges, model.parentOf, viewport],
  );
  const canvasWidth = losslessZoom ? Math.max(layout.width * viewport.scale + Math.abs(viewport.x) + graphCanvasPadding, 960) : layout.width;
  const canvasHeight = losslessZoom ? Math.max(layout.height * viewport.scale + Math.abs(viewport.y) + graphCanvasPadding, 540) : layout.height;

  const setViewportWithOptionalAnimation = (next: GraphViewport, animate: boolean) => {
    if (viewportAnimationTimerRef.current !== undefined) window.clearTimeout(viewportAnimationTimerRef.current);
    setViewport(next);
    viewportRef.current = next;
    if (!animate) {
      setViewportAnimating(false);
      return;
    }
    setViewportAnimating(true);
    viewportAnimationTimerRef.current = window.setTimeout(() => {
      setViewportAnimating(false);
      viewportAnimationTimerRef.current = undefined;
    }, 230);
  };

  const applyFit = (animate = false) => {
    const shell = shellRef.current;
    if (!shell) return;
    setViewportWithOptionalAnimation(fitView(layout, shell.getBoundingClientRect()), animate);
  };

  const zoomLowerBound = () => {
    const shell = shellRef.current;
    return minZoomScale(shell ? fitScale(layout, shell.getBoundingClientRect()) : viewport.scale);
  };

  useEffect(() => {
    userViewportRef.current = false;
    requestAnimationFrame(() => applyFit(false));
  }, [layoutKey]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => {
      const rect = shell.getBoundingClientRect();
      if (!userViewportRef.current) {
        setViewportWithOptionalAnimation(fitView(layout, rect), true);
        return;
      }
      if (selectedNodeId) {
        setViewportWithOptionalAnimation(
          keepBoxInViewport(viewportRef.current, rect, layout.boxes.get(selectedNodeId), graphSelectedVisibilityMargin),
          true,
        );
      }
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [layout, selectedNodeId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !selectedNodeId) return;
    const frame = requestAnimationFrame(() => {
      setViewportWithOptionalAnimation(
        keepBoxInViewport(viewportRef.current, shell.getBoundingClientRect(), layout.boxes.get(selectedNodeId), graphSelectedVisibilityMargin),
        true,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    onSelectNode(selectedNodeId, contextForTarget(selectedNodeId), displayStatusForTarget(selectedNodeId));
  }, [model, selectedNodeId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = shell.getBoundingClientRect();
      const current = viewportRef.current;
      const scale = wheelZoomScale(current.scale, event.deltaY, zoomLowerBound(), graphMaxScale);
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      userViewportRef.current = true;
      setViewportWithOptionalAnimation(zoomViewport(current, scale, px, py), false);
    };
    shell.addEventListener("wheel", onWheel, { passive: false });
    return () => shell.removeEventListener("wheel", onWheel);
  }, [layout]);

  useEffect(() => () => {
    if (viewportAnimationTimerRef.current !== undefined) window.clearTimeout(viewportAnimationTimerRef.current);
  }, []);

  if (!graph) return <GraphEmptyState />;

  return (
    <div
      className={`graph-flow-shell run-status-${graph.workflow.status ? normalizeRuntimeStatus(graph.workflow.status) : "static"} ${viewportAnimating ? "viewport-animating" : ""}`}
      ref={shellRef}
      onClickCapture={event => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={() => onSelectNode(undefined)}
      onPointerDown={event => {
        if (!canStartPan(event.target as unknown as { closest(selector: string): unknown } | null)) return;
        const box = (event.target as Element).closest<HTMLElement>(".graph-box");
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          viewport,
          moved: false,
          ...(box?.dataset.selectNodeId === undefined ? {} : { selectNodeId: box.dataset.selectNodeId }),
        };
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && !isPanPastThreshold(dx, dy)) return;
        event.preventDefault();
        if (!drag.moved) event.currentTarget.setPointerCapture(event.pointerId);
        drag.moved = true;
        userViewportRef.current = true;
        setViewport({
          ...drag.viewport,
          x: drag.viewport.x + dx,
          y: drag.viewport.y + dy,
        });
      }}
      onPointerUp={event => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        suppressClickRef.current = drag.moved || Boolean(drag.selectNodeId);
        if (!drag.moved && drag.selectNodeId) onSelectNode(drag.selectNodeId, contextForTarget(drag.selectNodeId), displayStatusForTarget(drag.selectNodeId));
        dragRef.current = undefined;
      }}
      onPointerCancel={() => {
        dragRef.current = undefined;
      }}
    >
      <div className="graph-toolbar" onClick={event => event.stopPropagation()}>
        {onSelectWorkflow && (
          <Button type="button" variant="tool" className="graph-tool-button workflow-io" title="Workflow I/O" aria-label="Workflow I/O: open workflow input and output" onClick={onSelectWorkflow}>
            <Braces size={14} />
            <span>Workflow I/O</span>
          </Button>
        )}
        <Button type="button" variant="tool" className="graph-tool-button" title="Fit view" aria-label="Fit graph to view" onClick={() => applyFit(true)}>
          <Scan size={14} />
        </Button>
        <Button
          type="button"
          variant="tool"
          className="graph-tool-button"
          title="Zoom out"
          aria-label="Zoom graph out"
          onClick={() => {
            userViewportRef.current = true;
            const current = viewportRef.current;
            setViewportWithOptionalAnimation({ ...current, scale: clamp(current.scale * 0.85, zoomLowerBound(), graphMaxScale) }, false);
          }}
        >
          <Minus size={14} />
        </Button>
        <Button
          type="button"
          variant="tool"
          className="graph-tool-button"
          title="Zoom in"
          aria-label="Zoom graph in"
          onClick={() => {
            userViewportRef.current = true;
            const current = viewportRef.current;
            setViewportWithOptionalAnimation({ ...current, scale: clamp(current.scale * 1.15, zoomLowerBound(), graphMaxScale) }, false);
          }}
        >
          <Plus size={14} />
        </Button>
      </div>
      <div
        className="graph-canvas"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          transform: losslessZoom ? undefined : `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        <svg className="graph-edges" width={canvasWidth} height={canvasHeight} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}>
          <defs>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {renderedEdgePaths.map(edge => (
            <path key={edge.id} className={`graph-edge ${edge.kind} ${edge.active ? "active" : ""}`} d={edge.d} markerEnd={edge.kind === "loop" ? undefined : "url(#graph-arrow)"} />
          ))}
        </svg>
        {[...renderedBoxes.values()]
          .sort((a, b) => depth(a.id, model.parentOf) - depth(b.id, model.parentOf))
          .map(box => {
            const item = model.items.get(box.id);
            if (!item) return null;
            return (
              <GraphBox
                key={item.id}
                box={box}
                item={item}
                selected={selectedNodeId === item.id || (item.type === "container" && selectedNodeId === item.nodeId)}
                depth={depth(item.id, model.parentOf)}
                onSelectNode={id => onSelectNode(id, contextForTarget(id), displayStatusForTarget(id))}
                onSelectOption={(nodeId, optionId) => {
                  const next = { ...selectionsRef.current, [nodeId]: optionId };
                  selectionsRef.current = next;
                  setSelections(next);
                  const nextModel = toRenderModel(graph, next);
                  if (selectedNodeId) onSelectNode(selectedNodeId, selectionContext(graph, next, selectedNodeId, nextModel.parentOf), nextModel.items.get(selectedNodeId)?.status);
                }}
              />
            );
          })}
      </div>
    </div>
  );
}

const GraphBox = memo(function GraphBox({
  box,
  item,
  selected,
  depth,
  onSelectNode,
  onSelectOption,
}: {
  box: PlacedBox;
  item: RenderItem;
  selected: boolean;
  depth: number;
  onSelectNode(id: string | undefined): void;
  onSelectOption(nodeId: string, optionId: string): void;
}) {
  const className = [
    "graph-box",
    item.type === "container" ? "graph-container" : "node",
    item.kind,
    item.status,
    `runtime-status-${item.status}`,
    item.active ? "runtime-active" : "",
    item.dimmed ? "runtime-dimmed" : "",
    selected ? "selected" : "",
    item.children.length === 0 ? "empty" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={className}
      data-select-node-id={item.type === "node" ? item.id : item.nodeId}
      role="button"
      tabIndex={0}
      aria-label={`${item.type === "node" ? "Node" : "Container"} ${item.label}`}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height, zIndex: graphItemZIndex(depth) }}
      onClick={event => {
        event.stopPropagation();
        onSelectNode(item.type === "node" ? item.id : item.nodeId);
      }}
      onKeyDown={event => {
        if (event.currentTarget !== event.target) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSelectNode(item.type === "node" ? item.id : item.nodeId);
      }}
    >
      {item.type === "container" ? (
        <ContainerContent item={item} />
      ) : item.children.length > 0 || isCompositeKind(item.kind) ? (
        <CompositeContent item={item} onSelectOption={onSelectOption} />
      ) : (
        <LeafContent item={item} />
      )}
    </div>
  );
});

function LeafContent({ item }: { item: RenderItem }) {
  const subtitle = leafSubtitle(item.node?.detail);
  return (
    <div className="node-card">
      <div className="node-card-head">
        <span className={`type-badge ${item.kind}`}>{item.kind.toUpperCase()}</span>
        <KindIcon kind={item.kind} size={14} />
        <strong>{item.label}</strong>
        <StatusGlyph status={item.status} />
      </div>
      {subtitle && <div className="node-detail">{subtitle}</div>}
    </div>
  );
}

function CompositeContent({
  item,
  onSelectOption,
}: {
  item: RenderItem;
  onSelectOption(nodeId: string, optionId: string): void;
}) {
  const descriptor = compositeDescriptor(item.node?.detail);
  const strategy = compositeStrategy(item.node?.detail);
  return (
    <div className="graph-box-header">
      <span className="composite-title">
        <KindIcon kind={item.kind} size={14} />
        <strong>{item.label}</strong>
        <span className={`type-badge ${item.kind}`}>{compositeBadge(item.kind)}</span>
        {strategy && <span className="strategy-badge">{strategy}</span>}
        <StatusGlyph status={item.status} />
        {descriptor && <span className="composite-descriptor">{descriptor}</span>}
      </span>
      {item.selector && item.selector.options.length > 0 && (
        <span className={`graph-selector-wrap ${item.selector.kind}`}>
          <Select
            value={item.selectedOptionId ?? item.selector.defaultOptionId ?? item.selector.options[0]?.id ?? ""}
            onValueChange={optionId => onSelectOption(item.selector!.nodeId, optionId)}
          >
            <SelectTrigger
              className={`graph-selector ${item.selector.kind}`}
              aria-label={`${item.selector.kind === "loop" ? "Loop iteration" : "Fanout item"} for ${item.label}`}
              onClick={event => event.stopPropagation()}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {item.selector.options.map(option => (
                <SelectItem key={option.id} value={option.id}>{selectorOptionLabel(item.selector!, option)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      )}
    </div>
  );
}

function ContainerContent({ item }: { item: RenderItem }) {
  return (
    <>
      <span className="branch-pill">{item.label}</span>
      {item.children.length === 0 && <div className="empty-branch">{item.kind === "scope" ? "empty scope" : "empty branch"}</div>}
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
