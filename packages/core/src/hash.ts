import { createHash } from "node:crypto";
import type { IrBranch, IrNode } from "./types.js";
import { extractReferences } from "./cel-ast.js";
import { EXPRESSION_PATTERN } from "./expressions-shared.js";

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
export interface IrNodeHashOptions {
  workflow?: unknown;
}

export function hashIrNode(node: IrNode, options: IrNodeHashOptions = {}): string {
  return sha256(JSON.stringify(canonicalize(nodeShape(node, options))));
}

interface CanonicalNodeShape {
  kind: IrNode["kind"];
  outputMerge?: IrNode["outputMerge"];
  metadata: Record<string, unknown>;
  workflow?: unknown;
  children?: CanonicalNodeShape[];
  branches?: CanonicalBranchShape[];
}

interface CanonicalBranchShape {
  id: string;
  when?: string;
  child: CanonicalNodeShape;
}

function nodeShape(node: IrNode, options: IrNodeHashOptions): CanonicalNodeShape {
  const shape: CanonicalNodeShape = {
    kind: node.kind,
    metadata: node.metadata
  };
  if (options.workflow && nodeReferencesWorkflow(node)) shape.workflow = options.workflow;
  if (node.outputMerge) shape.outputMerge = node.outputMerge;
  if (node.children && node.children.length > 0) shape.children = node.children.map((child) => nodeShape(child, options));
  if (node.branches && node.branches.length > 0) shape.branches = node.branches.map((branch) => branchShape(branch, options));
  return shape;
}

function branchShape(branch: IrBranch, options: IrNodeHashOptions): CanonicalBranchShape {
  return {
    id: branch.id,
    when: branch.when,
    child: nodeShape(branch.child, options)
  };
}

function nodeReferencesWorkflow(node: IrNode): boolean {
  if (metadataReferencesWorkflow(node.kind, node.metadata)) return true;
  if (node.branches?.some((branch) =>
    rawCelReferencesWorkflow(branch.when) || nodeReferencesWorkflow(branch.child)
  )) return true;
  return node.children?.some(nodeReferencesWorkflow) ?? false;
}

function metadataReferencesWorkflow(kind: IrNode["kind"], metadata: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      if (templateReferencesWorkflow(value)) return true;
      if (isRawCelField(kind, key) && rawCelReferencesWorkflow(value)) return true;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => valueReferencesWorkflow(item))) return true;
      continue;
    }
    if (value && typeof value === "object") {
      if (valueReferencesWorkflow(value)) return true;
    }
  }
  return false;
}

function valueReferencesWorkflow(value: unknown): boolean {
  if (typeof value === "string") return templateReferencesWorkflow(value);
  if (Array.isArray(value)) return value.some(valueReferencesWorkflow);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(valueReferencesWorkflow);
  return false;
}

function templateReferencesWorkflow(value: string): boolean {
  for (const match of value.matchAll(EXPRESSION_PATTERN)) {
    if (expressionReferencesWorkflow(match[1]?.trim() ?? "")) return true;
  }
  EXPRESSION_PATTERN.lastIndex = 0;
  return false;
}

function rawCelReferencesWorkflow(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  if (EXPRESSION_PATTERN.test(value)) {
    EXPRESSION_PATTERN.lastIndex = 0;
    return templateReferencesWorkflow(value);
  }
  EXPRESSION_PATTERN.lastIndex = 0;
  return expressionReferencesWorkflow(value.trim());
}

function expressionReferencesWorkflow(source: string): boolean {
  if (!source) return false;
  const { references, parseError } = extractReferences(source);
  if (parseError) return false;
  return references.some((ref) => ref.root === "workflow");
}

function isRawCelField(kind: IrNode["kind"], key: string): boolean {
  return (kind === "fanout" && key === "over")
    || (kind === "loop" && key === "until")
    || (kind === "guard" && key === "when");
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
