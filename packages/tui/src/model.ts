/**
 * Model overlay — pure functions that build a render tree by walking the frozen
 * IR (static structure) and attaching the live NodeExecutionState instances for
 * each node.
 *
 * The daemon returns a flat NodeExecutionState[] keyed by node keys like
 * "workflow/mapped/item:file-a/lane:0/round:2". A single IR node id can map to
 * many runtime instances (fanout lanes, loop rounds, parallel branches), so we
 * group instances by their original IR node id (NodeExecutionState.nodeId).
 */

import type { AcpusIr, IrNode } from "@acpus/core";
import type { NodeExecutionState, NodeState } from "@acpus/runtime";

/** A node in the render tree: an IR node plus its live runtime instance(s). */
export interface RenderNode {
  irNode: IrNode;
  /** Live runtime states for this IR node, ordered by nodeKey. May be empty (not reached). */
  instances: NodeExecutionState[];
  /** Child render nodes (composite children or switch-branch children). */
  children: RenderNode[];
  /** For switch branches: the case label (e.g. "case_1", "default") and predicate. */
  branchLabel?: string;
  branchWhen?: string;
  /** Composite summary derived from metadata (e.g. "over=files join=quorum"). */
  summary?: string;
  /** Depth in the tree (root = 0). */
  depth: number;
}

/** Build the full render tree for a run. */
export function buildRenderTree(ir: AcpusIr, states: NodeExecutionState[]): RenderNode {
  const byId = indexByNodeId(states);
  return buildNode(ir.root, byId, 0);
}

function buildNode(
  irNode: IrNode,
  byId: Map<string, NodeExecutionState[]>,
  depth: number,
  branchLabel?: string,
  branchWhen?: string
): RenderNode {
  const instances = byId.get(irNode.id) ?? [];
  const children: RenderNode[] = [];

  if (irNode.branches) {
    // switch: each branch is a labeled group of children
    for (const branch of irNode.branches) {
      for (const child of branch.children) {
        children.push(buildNode(child, byId, depth + 1, branch.id, branch.when));
      }
    }
  } else if (irNode.children) {
    for (const child of irNode.children) {
      children.push(buildNode(child, byId, depth + 1));
    }
  }

  return {
    irNode,
    instances,
    children,
    branchLabel,
    branchWhen,
    summary: summarize(irNode),
    depth
  };
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

/** Flatten the render tree into a linear, display-ordered list for the task list / graph panes. */
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
 * A single selectable/displayable row. Composite or single-instance nodes
 * yield one row; nodes that expanded into multiple runtime instances (fanout
 * lanes, loop rounds, parallel branches) yield one row per instance plus a
 * header row for the composite itself.
 */
export interface DisplayRow {
  /** Stable key for React + selection. */
  rowKey: string;
  irNode: IrNode;
  /** Indentation depth for rendering. */
  depth: number;
  /** The runtime instance this row represents, if any. */
  instance?: NodeExecutionState;
  /** Representative state for this row (single instance, instance, or aggregate). */
  state?: NodeState;
  /** Display label (node id, branch label, or instance key tail). */
  label: string;
  /** True if this is a composite container header row (groups instances/children). */
  isHeader: boolean;
  /** node key usable for control actions, if known. */
  nodeKey?: string;
  /** Composite summary (over/join/until ...). */
  summary?: string;
  branchLabel?: string;
  branchWhen?: string;
}

/** Build the display-ordered, selectable rows for the whole tree. */
export function buildRows(root: RenderNode): DisplayRow[] {
  const rows: DisplayRow[] = [];
  walkRows(root, rows);
  return rows;
}

function walkRows(node: RenderNode, rows: DisplayRow[]): void {
  const { irNode, depth, instances } = node;
  const tail = (key: string): string => {
    const segs = key.split("/");
    return segs.slice(1).join("/") || segs[0];
  };

  if (instances.length <= 1) {
    const inst = instances[0];
    rows.push({
      rowKey: irNode.id + (inst ? `#${inst.nodeKey}` : ""),
      irNode,
      depth,
      instance: inst,
      state: inst?.state,
      label: irNode.id,
      isHeader: node.children.length > 0,
      nodeKey: inst?.nodeKey,
      summary: node.summary,
      branchLabel: node.branchLabel,
      branchWhen: node.branchWhen
    });
  } else {
    // Composite header row (aggregate), then one row per runtime instance.
    rows.push({
      rowKey: irNode.id,
      irNode,
      depth,
      state: aggregateState(node),
      label: `${irNode.id} (×${instances.length})`,
      isHeader: true,
      summary: node.summary,
      branchLabel: node.branchLabel,
      branchWhen: node.branchWhen
    });
    for (const inst of instances) {
      rows.push({
        rowKey: `${irNode.id}#${inst.nodeKey}`,
        irNode,
        depth: depth + 1,
        instance: inst,
        state: inst.state,
        label: tail(inst.nodeKey),
        isHeader: false,
        nodeKey: inst.nodeKey
      });
    }
  }

  for (const child of node.children) walkRows(child, rows);
}


/**
 * The representative state for a node: the single instance if there is one,
 * else the aggregate state across instances (e.g. running if any running,
 * failed if any failed, completed only if all completed).
 */
export function aggregateState(node: RenderNode): NodeState | undefined {
  if (node.instances.length === 0) return undefined;
  if (node.instances.length === 1) return node.instances[0].state;
  const states = node.instances.map((i) => i.state);
  if (states.includes("failed")) return "failed";
  if (states.includes("cancelled")) return "cancelled";
  if (states.includes("running")) return "running";
  if (states.includes("paused")) return "paused";
  if (states.includes("pending")) return "pending";
  if (states.every((s) => s === "completed")) return "completed";
  return states[0];
}

/** Count nodes (by representative state) across the whole tree, for the progress/legend panes. */
export function countByState(root: RenderNode): Record<NodeState, number> & { total: number } {
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    paused: 0,
    cancelled: 0,
    total: 0
  };
  for (const node of flatten(root)) {
    // Count every runtime instance so fanout lanes / loop rounds are reflected.
    for (const inst of node.instances) {
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
export function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "--:--:--";
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
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
