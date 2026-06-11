import { createHash } from "node:crypto";
import type { IrBranch, IrNode } from "./types.js";

/**
 * Compute a stable canonical hash of an IR Node, including its full subtree.
 *
 * Two Nodes with equal Node Key and equal Node Definition Hash are treated as
 * the same Node across Runs by the Forked Run inheritance rule (ADR-0007). The
 * hash MUST be stable across re-compiles of the same source IR; it MUST change
 * when any compiled IR field of the Node or any of its descendants differs.
 *
 * The hash explicitly excludes `id`, `nodePath`, and `keyTemplate` because Node
 * Key already carries that identity; including them would tautologically force
 * two structurally identical Nodes to mismatch only because they live under
 * different parent paths.
 */
export function hashIrNode(node: IrNode): string {
  return sha256(JSON.stringify(canonicalize(nodeShape(node))));
}

interface CanonicalNodeShape {
  kind: IrNode["kind"];
  outputMerge?: IrNode["outputMerge"];
  metadata: Record<string, unknown>;
  children?: CanonicalNodeShape[];
  branches?: CanonicalBranchShape[];
}

interface CanonicalBranchShape {
  id: string;
  when?: string;
  children: CanonicalNodeShape[];
}

function nodeShape(node: IrNode): CanonicalNodeShape {
  const shape: CanonicalNodeShape = {
    kind: node.kind,
    metadata: node.metadata
  };
  if (node.outputMerge) shape.outputMerge = node.outputMerge;
  if (node.children && node.children.length > 0) shape.children = node.children.map(nodeShape);
  if (node.branches && node.branches.length > 0) shape.branches = node.branches.map(branchShape);
  return shape;
}

function branchShape(branch: IrBranch): CanonicalBranchShape {
  return {
    id: branch.id,
    when: branch.when,
    children: branch.children.map(nodeShape)
  };
}

/**
 * Recursively sort object keys so JSON.stringify is canonical regardless of
 * source insertion order. Arrays are preserved in order (semantic).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  }
  return value;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
