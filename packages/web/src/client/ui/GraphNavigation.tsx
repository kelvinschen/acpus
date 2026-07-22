import { useMemo, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Rows3 from "lucide-react/dist/esm/icons/rows-3.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import type { GraphViewport, PlacedBox, RenderLayout, RenderModel, RenderItem } from "../../graph-renderer.js";
import { graphContextLabel } from "../../graph-renderer.js";
import { Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "./shadcn/breadcrumb.js";
import { Button } from "./shadcn/button.js";
import { Input } from "./shadcn/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./shadcn/popover.js";

type ShellSize = { width: number; height: number };

export function GraphPathBreadcrumb({
  model,
  selectedRenderId,
  onNavigate,
}: {
  model: RenderModel;
  selectedRenderId?: string | undefined;
  onNavigate(item: RenderItem, inspect: boolean): void;
}) {
  const path = useMemo(() => navigationPath(selectedRenderId, model), [model, selectedRenderId]);
  if (!selectedRenderId) return null;
  const visiblePath = path.length > 4 ? [path[0]!, ...path.slice(-3)] : path;

  return (
    <Breadcrumb className="graph-path-breadcrumb" aria-label="Graph path" onClick={event => event.stopPropagation()}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <span className="graph-path-root">Workflow</span>
        </BreadcrumbItem>
        {path.length > 4 && (
          <>
            <BreadcrumbSeparator><ChevronRight size={12} /></BreadcrumbSeparator>
            <BreadcrumbItem><span className="graph-path-ellipsis">…</span></BreadcrumbItem>
          </>
        )}
        {visiblePath.map((item, index) => {
          const isLast = index === visiblePath.length - 1;
          return (
            <BreadcrumbItem key={item.id}>
              <BreadcrumbSeparator><ChevronRight size={12} /></BreadcrumbSeparator>
              <BreadcrumbButton
                aria-current={isLast ? "page" : undefined}
                title={navigationItemTitle(item)}
                onClick={() => onNavigate(item, item.type === "node")}
              >
                {item.label}
              </BreadcrumbButton>
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function GraphNodeNavigator({
  model,
  selectedRenderId,
  onNavigate,
}: {
  model: RenderModel;
  selectedRenderId?: string | undefined;
  onNavigate(item: RenderItem): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const nodes = useMemo(
    () => [...model.items.values()]
      .filter((item): item is RenderItem & { type: "node" } => item.type === "node")
      .sort((left, right) => navigationItemTitle(left).localeCompare(navigationItemTitle(right))),
    [model],
  );
  const matches = query.trim().toLocaleLowerCase();
  const visibleNodes = matches.length === 0
    ? nodes
    : nodes.filter(item => navigatorSearchText(item).includes(matches));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="tool" className="graph-tool-button graph-navigator-trigger" title="Navigate graph nodes" aria-label="Open graph navigator">
          <Rows3 size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="graph-navigator" align="end" side="bottom" sideOffset={8} onOpenAutoFocus={event => event.preventDefault()}>
        <label className="graph-navigator-search">
          <Search size={14} aria-hidden="true" />
          <Input autoFocus value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="Find node, type, or context" aria-label="Find graph node" />
        </label>
        <div className="graph-navigator-summary">{visibleNodes.length} of {nodes.length} rendered nodes</div>
        <div className="graph-navigator-list" role="list">
          {visibleNodes.map(item => {
            const selected = item.id === selectedRenderId;
            const context = graphContextLabel(item.context);
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                className={`graph-navigator-row ${selected ? "selected" : ""}`}
                data-graph-node={item.id}
                aria-current={selected ? "true" : undefined}
                title={navigationItemTitle(item)}
                onClick={() => {
                  onNavigate(item);
                  setOpen(false);
                }}
              >
                <span className={`graph-navigator-kind ${item.kind}`}>{item.kind.toUpperCase()}</span>
                <span className="graph-navigator-node">
                  <strong>{item.label}</strong>
                  <small>{context ?? pathLabel(item)}</small>
                </span>
                {item.status !== "not_started" && <span className={`graph-navigator-status ${item.status}`}>{item.status}</span>}
              </Button>
            );
          })}
          {visibleNodes.length === 0 && <div className="graph-navigator-empty">No rendered node matches “{query}”.</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function GraphMinimap({
  model,
  layout,
  viewport,
  shellSize,
  selectedRenderId,
  onNavigate,
}: {
  model: RenderModel;
  layout: RenderLayout;
  viewport: GraphViewport;
  shellSize: ShellSize;
  selectedRenderId?: string | undefined;
  onNavigate(point: { x: number; y: number }): void;
}) {
  const size = minimapSize(layout);
  const visible = visibleGraphRect(viewport, shellSize);
  const items = useMemo(
    () => [...layout.boxes.values()]
      .map(box => ({ box, item: model.items.get(box.id) }))
      .filter((entry): entry is { box: PlacedBox; item: RenderItem & { type: "node" } } => entry.item?.type === "node"),
    [layout.boxes, model],
  );

  return (
    <Button
      type="button"
      variant="ghost"
      className="graph-minimap"
      aria-label="Navigate graph overview"
      title="Graph overview — click to recenter"
      style={size}
      onClick={event => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        onNavigate({
          x: Math.max(0, Math.min(layout.width, (event.clientX - rect.left) / rect.width * layout.width)),
          y: Math.max(0, Math.min(layout.height, (event.clientY - rect.top) / rect.height * layout.height)),
        });
      }}
    >
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true">
        <rect className="graph-minimap-surface" x="0" y="0" width={layout.width} height={layout.height} />
        {items.map(({ box, item }) => (
          <rect
            key={box.id}
            className={`graph-minimap-item ${item.type} ${item.active ? "active" : ""} ${item.id === selectedRenderId ? "selected" : ""}`}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={item.type === "node" ? 4 : 0}
          />
        ))}
        {visible && <rect className="graph-minimap-viewport" x={visible.x} y={visible.y} width={visible.width} height={visible.height} />}
      </svg>
    </Button>
  );
}

function navigationPath(selectedRenderId: string | undefined, model: RenderModel): RenderItem[] {
  if (!selectedRenderId) return [];
  const path: RenderItem[] = [];
  const visited = new Set<string>();
  let current: string | undefined = selectedRenderId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const item = model.items.get(current);
    if (!item) break;
    path.push(item);
    current = model.parentOf.get(current);
  }
  return path.reverse();
}

function pathLabel(item: RenderItem): string {
  return item.path.slice(1, -1).join(" / ") || "workflow root";
}

function navigationItemTitle(item: RenderItem): string {
  return [item.label, item.kind, pathLabel(item), graphContextLabel(item.context)].filter(Boolean).join(" · ");
}

function navigatorSearchText(item: RenderItem): string {
  return [item.label, item.nodeId, item.kind, item.path.join(" "), graphContextLabel(item.context)].filter(Boolean).join(" ").toLocaleLowerCase();
}

function minimapSize(layout: Pick<RenderLayout, "width" | "height">): { width: number; height: number } {
  const scale = Math.min(176 / Math.max(layout.width, 1), 124 / Math.max(layout.height, 1));
  return {
    width: Math.max(80, Math.round(layout.width * scale)),
    height: Math.max(56, Math.round(layout.height * scale)),
  };
}

function visibleGraphRect(viewport: GraphViewport, shellSize: ShellSize): { x: number; y: number; width: number; height: number } | undefined {
  if (viewport.scale <= 0 || shellSize.width <= 0 || shellSize.height <= 0) return undefined;
  return {
    x: -viewport.x / viewport.scale,
    y: -viewport.y / viewport.scale,
    width: shellSize.width / viewport.scale,
    height: shellSize.height / viewport.scale,
  };
}
