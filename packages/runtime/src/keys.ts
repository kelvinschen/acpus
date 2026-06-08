import type { NodeKeyTemplate } from "@acpus/core";
import type { NodeKeyDynamic } from "./types.js";

/**
 * Convert a NodeKeyTemplate + runtime dynamic context into a stable key string
 * for file naming and state lookup.
 *
 * Encoding: slash-separated path segments where dynamic dimensions use
 * `type:value` format. All values are filesystem-safe (no colons or
 * special chars in values — colons only appear as dimension separators).
 *
 * Examples:
 *   - Plain: "workflow/step-a"
 *   - Fanout item: "workflow/mapped/item:file-a"
 *   - Fanout with lane: "workflow/mapped/item:file-a/lane:0"
 *   - Loop round: "workflow/iterator/round:3"
 *   - Parallel branch: "workflow/parallel-group/branch:0"
 *   - Composite: "workflow/mapped/item:file-a/lane:0/branch:0/round:2"
 */
export function resolveNodeKey(
  template: NodeKeyTemplate,
  dynamic: NodeKeyDynamic = {}
): string {
  const parts: string[] = [template.nodePath];

  // Always include dynamic dimensions when provided, regardless of template flags.
  // The template flags indicate the node *can* have that dimension, but at runtime
  // any ancestor that provides a dimension should be reflected in child keys too.
  if (dynamic.fanoutItemId !== undefined) {
    parts.push(`item:${sanitizeValue(String(dynamic.fanoutItemId))}`);
  }

  if (dynamic.laneId !== undefined) {
    parts.push(`lane:${sanitizeValue(String(dynamic.laneId))}`);
  }

  if (dynamic.parallelBranchId !== undefined) {
    parts.push(`branch:${sanitizeValue(String(dynamic.parallelBranchId))}`);
  }

  if (dynamic.loopRound !== undefined) {
    parts.push(`round:${String(dynamic.loopRound)}`);
  }

  return parts.join("/");
}

/** Sanitize a dynamic value to be filesystem-safe (shared with key-scope matching). */
export function sanitizeValue(value: string): string {
  // Replace filesystem-unsafe characters with underscores
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

/**
 * Encode a node key for use as a filesystem filename.
 * Replaces "/" with ":" to flatten the hierarchical key into a flat name,
 * then appends ".json".
 * This encoding must be used consistently across store.ts and artifacts.ts.
 */
export function encodeNodeKeyForFs(nodeKey: string): string {
  return encodeNodeKeyForDir(nodeKey) + ".json";
}

/**
 * Encode a node key for use as a filesystem directory name.
 * Replaces "/" with ":" to flatten the hierarchical key into a flat name.
 * Use this when you need the encoded key without a file extension
 * (e.g., artifact directories, path segments).
 */
export function encodeNodeKeyForDir(nodeKey: string): string {
  return nodeKey.replace(/\//g, ":");
}
