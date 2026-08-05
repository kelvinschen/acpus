import { memo, useEffect, useMemo, useRef, useState } from "react";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check.js";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed.js";
import CircleEllipsis from "lucide-react/dist/esm/icons/circle-ellipsis.js";
import CirclePause from "lucide-react/dist/esm/icons/circle-pause.js";
import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import Focus from "lucide-react/dist/esm/icons/focus.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import GitFork from "lucide-react/dist/esm/icons/git-fork.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LocateFixed from "lucide-react/dist/esm/icons/locate-fixed.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import Repeat from "lucide-react/dist/esm/icons/repeat.js";
import Rows3 from "lucide-react/dist/esm/icons/rows-3.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Shrink from "lucide-react/dist/esm/icons/shrink.js";
import SkipForward from "lucide-react/dist/esm/icons/skip-forward.js";
import Split from "lucide-react/dist/esm/icons/split.js";
import Terminal from "lucide-react/dist/esm/icons/terminal.js";
import WorkflowIcon from "lucide-react/dist/esm/icons/workflow.js";
import type { WebGraph } from "../api.js";
import {
  activeFocus,
  activeEdgeIds,
  buildProjectedEdgePaths,
  canStartPan,
  clampViewport,
  compositeBadge,
  compositeStrategy,
  depth,
  fitScale,
  fitView,
  focusView,
  graphCanvasPadding,
  graphContextLabel,
  graphEdgeZIndex,
  graphItemZIndex,
  graphNodeTarget,
  graphMaxScale,
  graphSelectedVisibilityMargin,
  isCompositeKind,
  isLosslessZoom,
  isPanPastThreshold,
  keepBoxInViewport,
  layoutWorkflow,
  minZoomScale,
  normalizeSelections,
  planGraphNavigation,
  projectBoxes,
  selectionsForActiveRuntime,
  selectorOptionLabel,
  toRenderModel,
  wheelZoomScale,
  zoomViewport,
  type GraphSelections,
  type GraphNavigationIntent,
  type GraphNodeTarget,
  type EdgePath,
  type GraphViewport,
  type PlacedBox,
  type RenderItem,
} from "../../graph-renderer.js";
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";
import { GraphMinimap, GraphNodeNavigator, GraphPathBreadcrumb } from "./GraphNavigation.js";
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

type DragState = { pointerId: number; startX: number; startY: number; viewport: GraphViewport; moved: boolean; selectRenderId?: string };

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

function StatusStamp({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  if (display === "not_started") return null;
  const Icon = STATUS_ICONS[display] ?? CircleDashed;
  const emphatic = display === "completed" || display === "failed";
  return (
    <span className={`runtime-status-stamp ${display}`} role="img" title={runtimeStatusLabel(display)} aria-label={runtimeStatusLabel(display)}>
      <Icon size={20} strokeWidth={emphatic ? 2.8 : 2.15} />
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
  selectedRenderId,
  onSelectNode,
  onSelectWorkflow,
}: {
  graph: WebGraph | undefined;
  selectedRenderId?: string;
  onSelectNode(target: GraphNodeTarget | undefined): void;
  onSelectWorkflow?(): void;
}) {
  const [selections, setSelections] = useState<GraphSelections>({});
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, scale: 1 });
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
  const shellRef = useRef<HTMLDivElement | null>(null);
  const selectionsRef = useRef<GraphSelections>({});
  const viewportRef = useRef<GraphViewport>({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const initializedGraphKeyRef = useRef<string | undefined>(undefined);
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
  const layout = useMemo(() => layoutWorkflow(model), [model]);
  const runningSelections = useMemo(
    () => graph ? selectionsForActiveRuntime(graph, selections) : selections,
    [graph, selections],
  );
  const runningModel = useMemo(() => toRenderModel(graph, runningSelections), [graph, runningSelections]);
  const runningLayout = useMemo(() => layoutWorkflow(runningModel), [runningModel]);
  const graphKey = `${graph?.mode ?? "none"}:${graph?.workflow.runId ?? graph?.workflow.name ?? "graph"}`;
  const currentFocus = useMemo(() => activeFocus(runningModel), [runningModel]);
  const activeEdges = useMemo(() => activeEdgeIds(model), [model]);
  const losslessZoom = isLosslessZoom(viewport.scale);
  const renderedBoxes = useMemo(() => losslessZoom ? projectBoxes(layout.boxes, viewport) : layout.boxes, [layout.boxes, losslessZoom, viewport]);
  const renderedEdgePaths = useMemo(
    () => losslessZoom ? buildProjectedEdgePaths(model.edges, layout.boxes, model.parentOf, viewport, activeEdges) : layout.edgePaths,
    [activeEdges, layout.boxes, layout.edgePaths, losslessZoom, model.edges, model.parentOf, viewport],
  );
  const renderedEdgeLayers = useMemo(() => {
    const edgeById = new Map(model.edges.map(edge => [edge.id, edge]));
    const pathsByLayer = new Map<number, EdgePath[]>([[0, []]]);
    for (const path of renderedEdgePaths) {
      const edge = edgeById.get(path.id);
      const layer = edge ? graphEdgeZIndex(edge, model.parentOf) : 0;
      const paths = pathsByLayer.get(layer) ?? [];
      paths.push(path);
      pathsByLayer.set(layer, paths);
    }
    return [...pathsByLayer].sort(([left], [right]) => left - right);
  }, [model.edges, model.parentOf, renderedEdgePaths]);
  const canvasWidth = losslessZoom ? Math.max(layout.width * viewport.scale + Math.abs(viewport.x) + graphCanvasPadding, 960) : layout.width;
  const canvasHeight = losslessZoom ? Math.max(layout.height * viewport.scale + Math.abs(viewport.y) + graphCanvasPadding, 540) : layout.height;

  const setViewportWithOptionalAnimation = (next: GraphViewport, animate: boolean, targetLayout = layout) => {
    if (viewportAnimationTimerRef.current !== undefined) window.clearTimeout(viewportAnimationTimerRef.current);
    const shell = shellRef.current;
    const constrained = shell ? clampViewport(next, targetLayout, shell.getBoundingClientRect()) : next;
    const changed = constrained.x !== viewportRef.current.x
      || constrained.y !== viewportRef.current.y
      || constrained.scale !== viewportRef.current.scale;
    if (changed) setViewport(constrained);
    viewportRef.current = constrained;
    if (!animate || !changed) {
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

  const navigateGraph = (intent: GraphNavigationIntent) => {
    const shell = shellRef.current;
    if (!shell) return;
    const plan = planGraphNavigation(model, layout, viewportRef.current, shell.getBoundingClientRect(), intent);
    if (plan?.viewport) setViewportWithOptionalAnimation(plan.viewport, true);
    if (plan?.inspectionTarget) onSelectNode(plan.inspectionTarget);
  };

  const focusRenderedItem = (id: string) => {
    const shell = shellRef.current;
    if (!shell) return;
    const next = focusView(layout.boxes.get(id), shell.getBoundingClientRect());
    if (next) setViewportWithOptionalAnimation(next, true);
  };

  const applyActiveFocus = (animate = false) => {
    const shell = shellRef.current;
    if (!shell || !currentFocus) return;
    selectionsRef.current = runningSelections;
    setSelections(runningSelections);
    const next = currentFocus.targetId
      ? focusView(runningLayout.boxes.get(currentFocus.targetId), shell.getBoundingClientRect())
      : fitView(runningLayout, shell.getBoundingClientRect());
    if (next) setViewportWithOptionalAnimation(next, animate, runningLayout);
  };

  const zoomLowerBound = () => {
    const shell = shellRef.current;
    return minZoomScale(shell ? fitScale(layout, shell.getBoundingClientRect()) : viewport.scale);
  };

  useEffect(() => {
    if (!graph || initializedGraphKeyRef.current === graphKey) return;
    const frame = requestAnimationFrame(() => {
      initializedGraphKeyRef.current = graphKey;
      if (currentFocus) applyActiveFocus(false);
      else applyFit(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [currentFocus, graph, graphKey, layout, runningLayout, runningSelections]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const updateShell = () => {
      const rect = shell.getBoundingClientRect();
      setShellSize(current => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height });
      const next = selectedRenderId
        ? keepBoxInViewport(viewportRef.current, rect, layout.boxes.get(selectedRenderId), graphSelectedVisibilityMargin)
        : viewportRef.current;
      setViewportWithOptionalAnimation(next, Boolean(selectedRenderId));
    };
    const observer = new ResizeObserver(updateShell);
    observer.observe(shell);
    updateShell();
    return () => observer.disconnect();
  }, [layout, selectedRenderId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !selectedRenderId) return;
    const frame = requestAnimationFrame(() => {
      setViewportWithOptionalAnimation(
        keepBoxInViewport(viewportRef.current, shell.getBoundingClientRect(), layout.boxes.get(selectedRenderId), graphSelectedVisibilityMargin),
        true,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, selectedRenderId]);

  useEffect(() => {
    if (!selectedRenderId) return;
    onSelectNode(graphNodeTarget(model.items.get(selectedRenderId)));
  }, [model, selectedRenderId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = shell.getBoundingClientRect();
      const current = viewportRef.current;
      const scale = wheelZoomScale(current.scale, event, zoomLowerBound(), graphMaxScale);
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
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
          ...(box?.dataset.selectRenderId === undefined ? {} : { selectRenderId: box.dataset.selectRenderId }),
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
        setViewportWithOptionalAnimation({
          ...drag.viewport,
          x: drag.viewport.x + dx,
          y: drag.viewport.y + dy,
        }, false);
      }}
      onPointerUp={event => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        suppressClickRef.current = drag.moved || Boolean(drag.selectRenderId);
        if (!drag.moved && drag.selectRenderId) onSelectNode(graphNodeTarget(model.items.get(drag.selectRenderId)));
        dragRef.current = undefined;
      }}
      onPointerCancel={() => {
        dragRef.current = undefined;
      }}
    >
      <GraphPathBreadcrumb
        model={model}
        selectedRenderId={selectedRenderId}
        onNavigate={navigateGraph}
      />
      <div className="graph-toolbar" onClick={event => event.stopPropagation()}>
        {onSelectWorkflow && (
          <Button type="button" variant="tool" className="graph-tool-button workflow-io" title="Inspect workflow" aria-label="Inspect workflow" onClick={onSelectWorkflow}>
            <WorkflowIcon size={14} />
            <span>Workflow</span>
          </Button>
        )}
        <GraphNodeNavigator model={model} selectedRenderId={selectedRenderId} onNavigate={navigateGraph} />
        {graph.mode === "runtime" && (
          <Button
            type="button"
            variant="tool"
            className="graph-tool-button locate-active"
            title={currentFocus ? "Locate current work" : "No current work to locate"}
            aria-label={currentFocus ? `Locate current ${currentFocus.activeRenderIds.length} running node${currentFocus.activeRenderIds.length === 1 ? "" : "s"}` : "No current work to locate"}
            disabled={!currentFocus}
            onClick={() => applyActiveFocus(true)}
          >
            <LocateFixed size={14} />
          </Button>
        )}
        {selectedRenderId && (
          <Button type="button" variant="tool" className="graph-tool-button" title="Focus selected node" aria-label="Focus selected graph node" onClick={() => focusRenderedItem(selectedRenderId)}>
            <Focus size={14} />
          </Button>
        )}
        <Button type="button" variant="tool" className="graph-tool-button" title="Fit view" aria-label="Fit graph to view" onClick={() => applyFit(true)}>
          <Shrink size={14} />
        </Button>
      </div>
      <GraphMinimap
        model={model}
        layout={layout}
        viewport={viewport}
        shellSize={shellSize}
        selectedRenderId={selectedRenderId}
        onNavigate={navigateGraph}
      />
      <div
        className="graph-canvas"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          transform: losslessZoom ? undefined : `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {renderedEdgeLayers.map(([zIndex, edgePaths]) => (
          <GraphEdgeLayer key={zIndex} edgePaths={edgePaths} width={canvasWidth} height={canvasHeight} zIndex={zIndex} />
        ))}
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
                mode={model.mode}
                selected={selectedRenderId === item.id}
                depth={depth(item.id, model.parentOf)}
                onSelectNode={selected => onSelectNode(graphNodeTarget(selected))}
                onSelectOption={(selectorId, optionId) => {
                  const next = { ...selectionsRef.current, [selectorId]: optionId };
                  selectionsRef.current = next;
                  setSelections(next);
                  const nextModel = toRenderModel(graph, next);
                  if (selectedRenderId) onSelectNode(graphNodeTarget(nextModel.items.get(selectedRenderId)));
                }}
              />
            );
          })}
      </div>
    </div>
  );
}

function GraphEdgeLayer({
  edgePaths,
  width,
  height,
  zIndex,
}: {
  edgePaths: EdgePath[];
  width: number;
  height: number;
  zIndex: number;
}) {
  const markerId = zIndex === 0 ? "graph-arrow" : `graph-arrow-${String(zIndex).replace(".", "-")}`;
  return (
    <svg className="graph-edges" data-edge-layer={zIndex} style={{ zIndex }} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" stroke="none" />
        </marker>
      </defs>
      {edgePaths.map(edge => (
        <path key={edge.id} className={`graph-edge ${edge.kind} ${edge.active ? "active" : ""}`} d={edge.d} markerEnd={edge.kind === "loop" ? undefined : `url(#${markerId})`} />
      ))}
    </svg>
  );
}

const GraphBox = memo(function GraphBox({
  box,
  item,
  mode,
  selected,
  depth,
  onSelectNode,
  onSelectOption,
}: {
  box: PlacedBox;
  item: RenderItem;
  mode: WebGraph["mode"];
  selected: boolean;
  depth: number;
  onSelectNode(item: RenderItem): void;
  onSelectOption(selectorId: string, optionId: string): void;
}) {
  const hasCompositeHeader = item.children.length > 0 || isCompositeKind(item.kind);
  const accessibleLabel = graphNodeAccessibleLabel(item, mode);
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
      {...(item.type === "node"
        ? hasCompositeHeader
          ? { "data-select-render-id": item.id, role: "group", "aria-label": accessibleLabel }
          : { "data-select-render-id": item.id, role: "button", tabIndex: 0, "aria-label": accessibleLabel }
        : { role: "group", "aria-label": `Structure ${item.label}` })}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height, zIndex: graphItemZIndex(depth) }}
      onClick={item.type === "node" && !hasCompositeHeader ? event => {
        event.stopPropagation();
        onSelectNode(item);
      } : undefined}
      onKeyDown={item.type === "node" && !hasCompositeHeader ? event => {
        if (event.currentTarget !== event.target) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSelectNode(item);
      } : undefined}
    >
      {item.type === "container" ? <ContainerContent item={item} /> : (
        <>
          {item.children.length > 0 || isCompositeKind(item.kind) ? (
            <CompositeContent item={item} accessibleLabel={accessibleLabel} onSelectNode={() => onSelectNode(item)} onSelectOption={onSelectOption} />
          ) : (
            <LeafContent item={item} />
          )}
          <StatusStamp status={item.status} />
        </>
      )}
    </div>
  );
});

function LeafContent({ item }: { item: RenderItem }) {
  return (
    <div className="node-card">
      <div className="node-card-meta">
        <span className={`type-badge ${item.kind}`}>
          <KindIcon kind={item.kind} size={12} />
          {item.kind.toUpperCase()}
        </span>
      </div>
      <strong className="node-card-label" title={item.label}>{item.label}</strong>
    </div>
  );
}

function CompositeContent({
  item,
  accessibleLabel,
  onSelectNode,
  onSelectOption,
}: {
  item: RenderItem;
  accessibleLabel: string;
  onSelectNode(): void;
  onSelectOption(selectorId: string, optionId: string): void;
}) {
  const strategy = compositeStrategy(item.node?.detail);
  const title = (
    <>
      <KindIcon kind={item.kind} size={14} />
      <strong>{item.label}</strong>
      <span className={`type-badge ${item.kind}`}>{compositeBadge(item.kind)}</span>
      {strategy && <span className="strategy-badge">{strategy}</span>}
    </>
  );
  return (
    <div className="graph-box-header">
      <button
        type="button"
        className="composite-title composite-open"
        aria-label={accessibleLabel}
        onClick={event => {
          event.stopPropagation();
          onSelectNode();
        }}
      >
        {title}
      </button>
      {item.selector && item.selector.options.length > 0 && (
        <span className={`graph-selector-wrap ${item.selector.kind}`}>
          <Select
            value={item.selectedOptionId ?? item.selector.defaultOptionId ?? item.selector.options[0]?.id ?? ""}
            onValueChange={optionId => onSelectOption(item.selector!.id, optionId)}
          >
            <SelectTrigger
              className={`graph-selector ${item.selector.kind}`}
              aria-label={`Loop iteration for ${item.label}`}
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

function graphNodeAccessibleLabel(item: RenderItem, mode: WebGraph["mode"]): string {
  return [
    `Node ${item.label}`,
    graphContextLabel(item.context),
    mode === "runtime" ? runtimeStatusLabel(item.status) : undefined,
  ].filter(Boolean).join(" · ");
}

function ContainerContent({ item }: { item: RenderItem }) {
  return (
    <>
      <span className="branch-pill">{item.label}</span>
      {item.children.length === 0 && <div className="empty-branch">{item.kind === "scope" ? "empty scope" : item.kind === "fanout-item" ? "not started" : "empty branch"}</div>}
    </>
  );
}
