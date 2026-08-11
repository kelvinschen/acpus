import type {
  NodeDetail,
  WebGraph,
  WebGraphContainer,
  WebGraphEdge,
  WebGraphNode,
  WebGraphSelection,
  WebGraphSelector,
  WebGraphSelectorOption,
} from "../../graph-types.js";
import {
  displayNodeStatus,
  displayRunStatus,
  isActiveDisplayStatus,
  type DisplayStatus,
} from "../../runtime-status.js";

export type GraphSelections = Record<string, string>;

export type GraphNodeTarget = {
  renderId: string;
  target: string;
  nodeId: string;
  kind: string;
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
      ...(type === "node"
        ? { node: { ...canonical, status } as WebGraphNode }
        : { container: { ...canonical, status } as WebGraphContainer }),
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
    kind: item.kind,
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

function safeParents(nodes: Array<{ id: string; parentId?: string }>, ids: Set<string>): Map<string, string> {
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

export function isAncestor(ancestor: string, id: string, parentOf: ReadonlyMap<string, string>): boolean {
  const visited = new Set<string>();
  let current = parentOf.get(id);
  while (current && !visited.has(current)) {
    if (current === ancestor) return true;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
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

  const byRank = (a: string, b: string) =>
    (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
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

function applyDisplayRuntimeState(
  graph: WebGraph,
  items: Map<string, RenderItem>,
  parentOf: ReadonlyMap<string, string>,
): void {
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

function deriveSkippedDisplayStatus(
  graph: WebGraph,
  items: Map<string, RenderItem>,
  parentOf: ReadonlyMap<string, string>,
): void {
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
