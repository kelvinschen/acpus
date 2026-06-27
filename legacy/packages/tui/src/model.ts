/**
 * Model overlay — pure functions that build a render tree by walking the frozen
 * IR (static structure) and attaching the live NodeExecutionState instances for
 * each node.
 *
 * The supervisor returns a flat NodeExecutionState[] keyed by node keys like
 * "workflow/mapped/item:file-a/lane:0/round:2". A single IR node id can map to
 * many runtime instances (fanout lanes, loop rounds, parallel branches). Rather
 * than grouping every IR node's instances globally (which mixes lanes from
 * different fanout items together and makes every descendant appear "(×N)"),
 * we rebuild a *real* hierarchical tree keyed by the dynamic dimensions encoded
 * in each node key.
 *
 * Each composite introduces a distinct dynamic dimension:
 *   - fanout → item + lane   (one lane per item)
 *   - parallel → branch      (children are distinct IR ids → single instance per lane)
 *   - loop → round
 *
 * So fanout/loop "expand" into one group row per lane/round, and every node
 * underneath a group is scoped to that lane/round → it resolves to a single
 * instance, no spurious "(×N)". The "(×N)" count therefore lives only on the
 * fanout/loop container that actually fans.
 */

import type { AcpusIr, IrNode, IrNodeKind } from "@acpus/core";
import { parseNodeKey as parseRuntimeNodeKey, type NodeExecutionState, type NodeState, type ParsedNodeKey } from "@acpus/runtime";

/** A dynamic dimension type encoded in node keys. */
export type Dim = "item" | "lane" | "branch" | "round";

/** A node key split into its static path segments and dynamic dimensions. */
export interface ParsedKey {
  path: string[];
  dims: Map<Dim, string>;
  frames: Map<Dim, string>[];
}

/** A runtime state plus its parsed key (cached). */
interface ParsedState {
  state: NodeExecutionState;
  parsed: ParsedKey;
}

/** Ordered inherited dynamic frames from ancestors. Repeated dims are meaningful across frames. */
type Scope = Map<Dim, string>[];

interface BuildCtx {
  /** IR nodePath → its runtime instances (with parsed keys). */
  byPath: Map<string, ParsedState[]>;
  /** Authored IR node id → runtime instances, used only as a compatibility fallback. */
  byId: Map<string, ParsedState[]>;
  /** IR nodePath → all descendant IR nodes (inclusive of self). */
  descendantNodes: Map<string, IrNode[]>;
}

function parseNodeKey(key: string): ParsedKey {
  const parsed = parseRuntimeNodeKey(key);
  return adaptParsedNodeKey(parsed);
}

function adaptParsedNodeKey(parsed: ParsedNodeKey): ParsedKey {
  const dims = new Map<Dim, string>();
  addDynamicDims(dims, parsed.dynamic);
  return {
    path: parsed.staticSegments,
    dims,
    frames: parsed.dynamicFrames.map(dynamicFrameToMap)
  };
}

function dynamicFrameToMap(frame: ParsedNodeKey["dynamic"]): Map<Dim, string> {
  const map = new Map<Dim, string>();
  addDynamicDims(map, frame);
  return map;
}

function addDynamicDims(map: Map<Dim, string>, dynamic: ParsedNodeKey["dynamic"]): void {
  if (dynamic.fanoutItemId !== undefined) map.set("item", dynamic.fanoutItemId);
  if (dynamic.laneId !== undefined) map.set("lane", dynamic.laneId);
  if (dynamic.parallelBranchId !== undefined) map.set("branch", dynamic.parallelBranchId);
  if (dynamic.loopRound !== undefined) map.set("round", String(dynamic.loopRound));
}

/** An instance belongs to the current subtree iff it matches every fixed dim. */
function matchesScope(parsed: ParsedKey, scope: Scope): boolean {
  if (scope.length > parsed.frames.length) return false;
  return scope.every((scopeFrame, index) => {
    const parsedFrame = parsed.frames[index];
    if (!parsedFrame) return false;
    for (const [dim, value] of scopeFrame) {
      if (parsedFrame.get(dim) !== value) return false;
    }
    return true;
  });
}

/** The dynamic dimension a composite kind introduces (causing it to fan). */
function dimIntroducedBy(kind: IrNodeKind): Dim | undefined {
  if (kind === "fanout") return "lane";
  if (kind === "loop") return "round";
  return undefined;
}

/** A node in the render tree: an IR node (or a synthetic lane/round group). */
export interface RenderNode {
  /** "ir" = a real IR node; "group" = a synthetic fanout-lane/loop-round group. */
  type: "ir" | "group";
  /** The IR node. Group rows carry their PARENT composite IR node. */
  irNode: IrNode;
  /** Live runtime states scoped to this node's lane/round. Usually 0 or 1. */
  instances: NodeExecutionState[];
  /** Child render nodes. */
  children: RenderNode[];
  /** For if/switch branches: the branch label and predicate. */
  branchLabel?: string;
  branchWhen?: string;
  /** Composite summary derived from metadata (e.g. "over=files join=quorum"). */
  summary?: string;
  /** Depth in the tree (root = 0). */
  depth: number;
  /** Set only on a fanout/loop container → drives the "(×N)" label. */
  fannedCount?: number;
  /** Set only on a synthetic group row. */
  groupDim?: Dim;
  groupValue?: string;
  groupLabel?: string;
  /** For lane group rows: the fanout item value (shown in DETAILS). */
  groupItem?: string;
}

/** Build the full render tree for a run. */
export function buildRenderTree(ir: AcpusIr, states: NodeExecutionState[]): RenderNode {
  const byPath = indexByNodePathParsed(states);
  const byId = indexByNodeIdParsed(states);
  const descendantNodes = new Map<string, IrNode[]>();
  collectDescendantNodes(ir.root, descendantNodes);
  const ctx: BuildCtx = { byPath, byId, descendantNodes };
  return buildNode(ir.root, ctx, [], 0);
}

/** Collect, for every IR node, all descendant IR nodes (inclusive). */
function collectDescendantNodes(node: IrNode, out: Map<string, IrNode[]>): IrNode[] {
  const nodes = [node];
  const kids = node.branches
    ? node.branches.map((b) => b.child)
    : node.children ?? [];
  for (const child of kids) {
    nodes.push(...collectDescendantNodes(child, out));
  }
  out.set(node.nodePath.join("/"), nodes);
  return nodes;
}

function buildNode(
  irNode: IrNode,
  ctx: BuildCtx,
  scope: Scope,
  depth: number,
  branchLabel?: string,
  branchWhen?: string
): RenderNode {
  const scopedInstances = instancesForNode(irNode, ctx)
    .filter((p) => matchesScope(p.parsed, scope))
    .map((p) => p.state);

  const groupDim = dimIntroducedBy(irNode.kind);
  if (groupDim) {
    return buildExpandingNode(irNode, ctx, scope, depth, groupDim, scopedInstances, branchLabel, branchWhen);
  }

  const children: RenderNode[] = [];
  if (irNode.branches) {
    for (const branch of irNode.branches) {
      children.push(buildNode(branch.child, ctx, scope, depth + 1, branch.id, branch.when));
    }
  } else if (irNode.children) {
    for (const child of irNode.children) {
      children.push(buildNode(child, ctx, scope, depth + 1, branchLabel, branchWhen));
    }
  }

  return {
    type: "ir",
    irNode,
    instances: scopedInstances,
    children,
    branchLabel,
    branchWhen,
    summary: summarize(irNode),
    depth
  };
}

/**
 * Build a fanout/loop container that expands into one synthetic group row per
 * lane/round value. Fanout lanes display their resolved item id as "item=..."
 * to align with loop labels like "round=...". Each group's subtree is scoped
 * to that value, so every descendant resolves to a single instance and "(×N)"
 * appears only here.
 */
function buildExpandingNode(
  irNode: IrNode,
  ctx: BuildCtx,
  scope: Scope,
  depth: number,
  groupDim: Dim,
  ownInstances: NodeExecutionState[],
  branchLabel?: string,
  branchWhen?: string
): RenderNode {
  const descendants = descendantInstances(irNode, ctx, scope);
  const groupValues = [...new Set(
    descendants
      .map((p) => nextDimValue(p.parsed, scope, groupDim))
      .filter((v): v is string => v !== undefined)
  )].sort((a, b) => numericCompare(a, b));

  const groupRows: RenderNode[] = groupValues.map((gv) => {
    const childScope: Scope = [...scope];
    const frame = new Map<Dim, string>();
    if (groupDim === "lane") {
      const item = itemForLane(descendants, scope, gv);
      if (item !== undefined) frame.set("item", item);
    }
    frame.set(groupDim, gv);
    childScope.push(frame);

    const groupChildren: RenderNode[] = (irNode.children ?? []).map((child) =>
      buildNode(child, ctx, childScope, depth + 2)
    );

    const groupInstances = descendants
      .filter((p) => matchesScope(p.parsed, childScope))
      .map((p) => p.state);

    return {
      type: "group" as const,
      irNode,
      instances: groupInstances,
      children: groupChildren,
      depth: depth + 1,
      groupDim,
      groupValue: gv,
      groupLabel: labelForGroup(irNode, groupDim, gv, childScope),
      groupItem: groupDim === "lane" ? lastScopeValue(childScope, "item") : undefined
    };
  });

  return {
    type: "ir",
    irNode,
    instances: ownInstances,
    children: groupRows,
    branchLabel,
    branchWhen,
    summary: summarize(irNode),
    depth,
    fannedCount: groupValues.length
  };
}

/** All runtime instances of any IR node in this subtree, scoped to `scope`. */
function descendantInstances(irNode: IrNode, ctx: BuildCtx, scope: Scope): ParsedState[] {
  const nodes = ctx.descendantNodes.get(irNode.nodePath.join("/")) ?? [irNode];
  const out: ParsedState[] = [];
  for (const node of nodes) {
    for (const p of instancesForNode(node, ctx)) {
      if (matchesScope(p.parsed, scope)) out.push(p);
    }
  }
  return out;
}

function instancesForNode(node: IrNode, ctx: BuildCtx): ParsedState[] {
  const byPath = ctx.byPath.get(node.nodePath.join("/"));
  if (byPath !== undefined || node.id.startsWith("$")) return byPath ?? [];
  return ctx.byId.get(node.id) ?? [];
}

/** Find the fanout item value associated with a lane index. */
function itemForLane(descendants: ParsedState[], scope: Scope, lane: string): string | undefined {
  for (const p of descendants) {
    const frame = nextFrame(p.parsed, scope);
    if (frame?.get("lane") === lane) {
      const item = frame.get("item");
      if (item !== undefined) return item;
    }
  }
  return undefined;
}

function nextDimValue(parsed: ParsedKey, scope: Scope, dim: Dim): string | undefined {
  return nextFrame(parsed, scope)?.get(dim);
}

function nextFrame(parsed: ParsedKey, scope: Scope): Map<Dim, string> | undefined {
  if (!matchesScope(parsed, scope)) return undefined;
  return parsed.frames[scope.length];
}

/** Friendly label for a lane/round group row, e.g. "item=moduleA" or "round=2". */
function labelForGroup(irNode: IrNode, groupDim: Dim, value: string, scope: Scope): string {
  if (groupDim === "lane") {
    return `item=${lastScopeValue(scope, "item") ?? value}`;
  }
  return `${groupDim}=${value}`;
}

function lastScopeValue(scope: Scope, dim: Dim): string | undefined {
  for (let i = scope.length - 1; i >= 0; i--) {
    const value = scope[i]!.get(dim);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Compare two dimension values numerically when possible, else lexically. */
function numericCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Group runtime states by their original IR node id, each list sorted by key. */
export function indexByNodeId(states: NodeExecutionState[]): Map<string, NodeExecutionState[]> {
  const map = new Map<string, NodeExecutionState[]>();
  for (const s of states) {
    const list = map.get(s.nodeId) ?? [];
    list.push(s);
    map.set(s.nodeId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
  }
  return map;
}

/** Like indexByNodeId but keyed by static nodePath and with cached parsed keys. */
function indexByNodePathParsed(states: NodeExecutionState[]): Map<string, ParsedState[]> {
  const map = new Map<string, ParsedState[]>();
  for (const s of [...states].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey))) {
    const parsed = parseNodeKey(s.nodeKey);
    const path = parsed.path.join("/");
    const list = map.get(path) ?? [];
    list.push({ state: s, parsed });
    map.set(path, list);
  }
  return map;
}

function indexByNodeIdParsed(states: NodeExecutionState[]): Map<string, ParsedState[]> {
  const map = new Map<string, ParsedState[]>();
  for (const s of [...states].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey))) {
    const list = map.get(s.nodeId) ?? [];
    list.push({ state: s, parsed: parseNodeKey(s.nodeKey) });
    map.set(s.nodeId, list);
  }
  return map;
}

/** Flatten the render tree into a linear, display-ordered list. */
export function flatten(root: RenderNode): RenderNode[] {
  const out: RenderNode[] = [];
  const walk = (n: RenderNode) => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/**
 * A single selectable/displayable row.
 */
export interface DisplayRow {
  /** Real node, fanout/loop group, or branch label inserted for if/switch. */
  rowKind?: "node" | "group" | "branch";
  /** Stable key for React + selection. */
  rowKey: string;
  irNode: IrNode;
  /** Indentation depth for rendering. */
  depth: number;
  /** The runtime instance this row represents, if any. */
  instance?: NodeExecutionState;
  /** Representative state for this row (single instance or aggregate). */
  state?: NodeState;
  /** Display label (own node id, group label, or branch label). */
  label: string;
  /** True if this is a container header row (groups children). */
  isHeader: boolean;
  /** node key usable for control actions, if known. */
  nodeKey?: string;
  /** Composite summary (over/join/until ...). */
  summary?: string;
  branchLabel?: string;
  branchWhen?: string;
  /** Set on synthetic fanout-lane/loop-round group rows. */
  groupDim?: Dim;
  groupValue?: string;
  /** For lane group rows: the fanout item value (shown in DETAILS). */
  groupItem?: string;
  /**
   * Tree guide-line prefix split into colorable segments (one per column).
   * Each segment is 3 chars (e.g. "│  ", "   ", "├─ ", "└─ "). `ownerKind`
   * marks the container kind that owns the column, so guide-line colors match
   * the node-kind legend.
   */
  treeSegments: TreeSegment[];
}

/** One colorable column of a tree guide-line prefix. */
export interface TreeSegment {
  text: string;
  /** The node kind whose child column this segment belongs to. */
  ownerKind: IrNodeKind;
}

/** Tree guide-line glyphs. */
const TREE = {
  vertical: "│  ",
  space: "   ",
  branch: "├─ ",
  last: "└─ "
} as const;

/**
 * Build the colorable guide-line segments for a node.
 *  - `ancestorIsLast[i]`  — whether the i-th ancestor on the path is its
 *    parent's last child (decides "│  "/"   " columns and the final connector).
 *  - `ancestorKinds[i]` — the kind of the container that owns this column.
 */
function treeSegmentsFor(ancestorIsLast: boolean[], ancestorKinds: IrNodeKind[]): TreeSegment[] {
  const segments: TreeSegment[] = [];
  const n = ancestorIsLast.length;
  for (let i = 0; i < n; i++) {
    const ownerKind = ancestorKinds[i] ?? "pipeline";
    if (i < n - 1) {
      segments.push({ text: ancestorIsLast[i] ? TREE.space : TREE.vertical, ownerKind });
    } else {
      segments.push({ text: ancestorIsLast[i] ? TREE.last : TREE.branch, ownerKind });
    }
  }
  return segments;
}

/** Build the display-ordered, selectable rows for the whole tree. */
export function buildRows(root: RenderNode): DisplayRow[] {
  const rows: DisplayRow[] = [];
  walkRows(root, rows, [], [], [], "");
  return rows;
}

interface VisibleChildEntry {
  node: RenderNode;
  key: string;
}

function walkRows(
  node: RenderNode,
  rows: DisplayRow[],
  ancestorIsLast: boolean[],
  ancestorKinds: IrNodeKind[],
  ancestorNodes: IrNode[],
  pathKey: string
): void {
  const inst = node.instances.length === 1 ? node.instances[0] : undefined;
  const treeSegments = treeSegmentsFor(ancestorIsLast, ancestorKinds);
  const visualDepth = ancestorIsLast.length;

  const parentNode = ancestorNodes[ancestorNodes.length - 1];
  const branchHeader = branchHeaderFor(node, parentNode);
  if (branchHeader) {
    rows.push({
      rowKind: "branch",
      rowKey: `${pathKey}/branch:${branchHeader.label}`,
      irNode: branchHeader.parent,
      depth: visualDepth,
      state: aggregateState(node),
      label: branchHeader.label,
      isHeader: true,
      summary: summarize(branchHeader.parent),
      branchLabel: branchHeader.label,
      branchWhen: branchHeader.when,
      treeSegments
    });
  }

  if (node.type === "group") {
    rows.push({
      rowKind: "group",
      // pathKey makes rowKey globally unique: the same IR node (e.g. a LOOP)
      // appearing under multiple fanout lanes produces distinct group rows.
      rowKey: `${pathKey}/${node.irNode.id}@${node.groupDim}:${node.groupValue}`,
      irNode: node.irNode,
      depth: visualDepth,
      instance: inst,
      state: inst?.state ?? aggregateState(node),
      label: node.groupLabel ?? `${node.groupDim}:${node.groupValue}`,
      isHeader: true,
      nodeKey: inst?.nodeKey,
      groupDim: node.groupDim,
      groupValue: node.groupValue,
      groupItem: node.groupItem,
      treeSegments
    });
  } else if (!branchHeader) {
    const label = node.fannedCount !== undefined ? `${node.irNode.id} (×${node.fannedCount})` : node.irNode.id;
    rows.push({
      rowKind: "node",
      rowKey: `${pathKey}/${node.irNode.id}` + (inst ? `#${inst.nodeKey}` : ""),
      irNode: node.irNode,
      depth: visualDepth,
      instance: inst,
      state: inst?.state ?? aggregateState(node),
      label,
      isHeader: node.children.length > 0,
      nodeKey: inst?.nodeKey,
      summary: node.summary,
      branchLabel: node.branchLabel,
      branchWhen: node.branchWhen,
      treeSegments
    });
  }

  const visibleChildren = visibleChildEntries(node.children, node.irNode);
  visibleChildren.forEach((child, i) =>
    walkRows(
      child.node,
      rows,
      [...ancestorIsLast, i === visibleChildren.length - 1],
      [...ancestorKinds, node.irNode.kind],
      [...ancestorNodes, node.irNode],
      `${pathKey}/${child.key}`
    )
  );
}

function branchHeaderFor(node: RenderNode, parent?: IrNode): { parent: IrNode; label: string; when?: string } | undefined {
  if (parent?.kind !== "if" && parent?.kind !== "switch") return undefined;
  if (node.type !== "ir") return undefined;
  if (node.irNode.kind !== "pipeline" || node.irNode.metadata.generated !== true) return undefined;
  const label = node.branchLabel;
  if (label === undefined) return undefined;
  return { parent, label, when: node.branchWhen };
}

function visibleChildEntries(children: RenderNode[], parent: IrNode, prefix = ""): VisibleChildEntry[] {
  return children.flatMap((child, index) => {
    const key = `${prefix}/${index}:${child.irNode.id}`;
    return isGeneratedPipeline(child) && !branchHeaderFor(child, parent)
      ? visibleChildEntries(child.children, child.irNode, key)
      : [{ node: child, key }];
  });
}

function isGeneratedPipeline(node: RenderNode): boolean {
  return node.type === "ir" && node.irNode.kind === "pipeline" && node.irNode.metadata.generated === true;
}

/**
 * The representative state for a node: the single instance if there is one,
 * else the aggregate state across this subtree's instances (failed if any
 * failed, completed only if all completed, etc.).
 */
export function aggregateState(node: RenderNode): NodeState | undefined {
  const states = collectStates(node);
  if (states.length === 0) return undefined;
  if (states.length === 1) return states[0];
  if (states.includes("failed")) return "failed";
  if (states.includes("cancelled")) return "cancelled";
  if (states.includes("running")) return "running";
  if (states.includes("awaiting")) return "awaiting";
  if (states.includes("paused")) return "paused";
  if (states.includes("pending")) return "pending";
  if (states.every((s) => s === "completed")) return "completed";
  return states[0];
}

/** Collect this node's own instance states plus all descendants' (deduped). */
function collectStates(node: RenderNode): NodeState[] {
  const seen = new Set<string>();
  const out: NodeState[] = [];
  for (const n of flatten(node)) {
    for (const inst of n.instances) {
      if (seen.has(inst.nodeKey)) continue;
      seen.add(inst.nodeKey);
      out.push(inst.state);
    }
  }
  return out;
}

/** Count every distinct runtime instance by state, for the progress/legend panes. */
export function countByState(root: RenderNode): Record<NodeState, number> & { total: number } {
  const counts = {
    pending: 0,
    running: 0,
    awaiting: 0,
    completed: 0,
    failed: 0,
    paused: 0,
    cancelled: 0,
    total: 0
  };
  const seen = new Set<string>();
  for (const node of flatten(root)) {
    if (isGeneratedPipeline(node)) continue;
    for (const inst of node.instances) {
      if (seen.has(inst.nodeKey)) continue;
      seen.add(inst.nodeKey);
      counts[inst.state]++;
      counts.total++;
    }
  }
  return counts;
}

/** Build a short human summary of a composite node from its IR metadata. */
function summarize(node: IrNode): string | undefined {
  const m = node.metadata ?? {};
  switch (node.kind) {
    case "fanout": {
      const parts: string[] = [];
      if (typeof m.over === "string") parts.push(`over ${m.over}`);
      if (typeof m.join === "string") parts.push(`join=${String(m.join)}`);
      if (m.quorum !== undefined) parts.push(`quorum=${String(m.quorum)}`);
      if (typeof m.max_concurrency === "number") parts.push(`conc=${m.max_concurrency}`);
      return parts.length ? parts.join(" ") : undefined;
    }
    case "parallel": {
      const parts: string[] = [];
      if (typeof m.join === "string") parts.push(`join=${String(m.join)}`);
      if (typeof m.max_concurrency === "number") parts.push(`conc=${m.max_concurrency}`);
      return parts.length ? parts.join(" ") : undefined;
    }
    case "if": {
      const condition = node.branches?.find((branch) => branch.id === "then")?.when;
      return typeof condition === "string" ? `condition ${condition}` : undefined;
    }
    case "switch":
      return typeof m.on === "string" ? `on ${m.on}` : undefined;
    case "loop": {
      const parts: string[] = [];
      if (m.max_iterations !== undefined) parts.push(`max=${String(m.max_iterations)}`);
      if (typeof m.until === "string") parts.push(`until ${m.until}`);
      return parts.length ? parts.join(" ") : undefined;
    }
    case "subworkflow":
      return typeof m.subworkflow === "string" ? String(m.subworkflow) : undefined;
    default:
      return undefined;
  }
}

/** Format a duration between two ISO timestamps as HH:MM:SS. */
export function formatDuration(startedAt?: string, completedAt?: string, freezeAt?: string | number): string {
  if (!startedAt) return "--:--:--";
  const start = Date.parse(startedAt);
  const frozen = typeof freezeAt === "number" ? freezeAt : freezeAt ? Date.parse(freezeAt) : undefined;
  const end = completedAt ? Date.parse(completedAt) : frozen ?? Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "--:--:--";
  return formatElapsed(end - start);
}

/** Format a millisecond span as HH:MM:SS. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
