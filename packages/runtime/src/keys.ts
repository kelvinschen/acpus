import type { NodeKeyTemplate } from "@acpus/core";
import type { NodeKeyDynamic } from "./types.js";

const DYNAMIC_SEGMENT = /^(item|lane|round|branch):/u;

export interface ParsedNodeKey {
  nodeKey: string;
  staticPath: string;
  staticSegments: string[];
  dynamic: NodeKeyDynamic;
}

type DynamicFrame = NodeKeyDynamic;

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

/**
 * Parse a resolved Node Key into its static Node path and dynamic dimensions.
 * Dynamic dimensions are slash-separated `type:value` suffix segments.
 */
export function parseNodeKey(nodeKey: string): ParsedNodeKey {
  const staticSegments: string[] = [];
  const dynamic: NodeKeyDynamic = {};

  for (const segment of nodeKey.split("/")) {
    if (!DYNAMIC_SEGMENT.test(segment)) {
      staticSegments.push(segment);
      continue;
    }

    const [kind, ...rest] = segment.split(":");
    const value = rest.join(":");
    switch (kind) {
      case "item":
        dynamic.fanoutItemId = value;
        break;
      case "lane":
        dynamic.laneId = value;
        break;
      case "branch":
        dynamic.parallelBranchId = value;
        break;
      case "round":
        dynamic.loopRound = Number(value);
        break;
    }
  }

  return {
    nodeKey,
    staticPath: staticSegments.join("/"),
    staticSegments,
    dynamic
  };
}

/** Return the static IR nodePath represented by a resolved Node Key. */
export function staticNodePathFromKey(nodeKey: string): string {
  return parseNodeKey(nodeKey).staticPath;
}

/**
 * Test whether a resolved Node Key addresses `staticPath` or a descendant of it.
 * The comparison ignores dynamic dimensions.
 */
export function isNodeKeyAtOrBelow(nodeKey: string, staticPath: string): boolean {
  const nodeStaticPath = staticNodePathFromKey(nodeKey);
  return nodeStaticPath === staticPath || nodeStaticPath.startsWith(`${staticPath}/`);
}

/**
 * Test whether a resolved Node Key belongs to the provided dynamic scope.
 * Required scope dimensions are encoded with the same rules as Node Key
 * resolution before comparison.
 */
export function isNodeKeyInDynamicScope(nodeKey: string, dynamic: NodeKeyDynamic): boolean {
  if (isEmptyDynamicScope(dynamic)) {
    return true;
  }

  for (const frame of collectDynamicFrames(nodeKey)) {
    if (isDynamicFrameInScope(frame, dynamic)) {
      return true;
    }
  }

  return false;
}

function isDynamicFrameInScope(frame: DynamicFrame, dynamic: NodeKeyDynamic): boolean {
  if (
    dynamic.fanoutItemId !== undefined &&
    frame.fanoutItemId !== sanitizeValue(String(dynamic.fanoutItemId))
  ) {
    return false;
  }

  if (dynamic.laneId !== undefined && frame.laneId !== sanitizeValue(String(dynamic.laneId))) {
    return false;
  }

  if (
    dynamic.parallelBranchId !== undefined &&
    !isParallelBranchInScope(frame.parallelBranchId, dynamic.parallelBranchId)
  ) {
    return false;
  }

  if (dynamic.loopRound !== undefined && frame.loopRound !== dynamic.loopRound) {
    return false;
  }

  return true;
}

function collectDynamicFrames(nodeKey: string): DynamicFrame[] {
  const frames: DynamicFrame[] = [];
  let current: DynamicFrame = {};

  for (const segment of nodeKey.split("/")) {
    if (!DYNAMIC_SEGMENT.test(segment)) {
      pushDynamicFrame(frames, current);
      current = {};
      continue;
    }

    const [kind, ...rest] = segment.split(":");
    const value = rest.join(":");
    switch (kind) {
      case "item":
        current.fanoutItemId = value;
        break;
      case "lane":
        current.laneId = value;
        break;
      case "branch":
        current.parallelBranchId = value;
        break;
      case "round":
        current.loopRound = Number(value);
        break;
    }
  }

  pushDynamicFrame(frames, current);
  return frames;
}

function pushDynamicFrame(frames: DynamicFrame[], frame: DynamicFrame): void {
  if (!isEmptyDynamicScope(frame)) {
    frames.push(frame);
  }
}

function isEmptyDynamicScope(dynamic: NodeKeyDynamic): boolean {
  return (
    dynamic.fanoutItemId === undefined &&
    dynamic.laneId === undefined &&
    dynamic.parallelBranchId === undefined &&
    dynamic.loopRound === undefined
  );
}

function isParallelBranchInScope(parsedBranch: string | undefined, scopeBranch: string): boolean {
  const sanitizedScope = sanitizeValue(String(scopeBranch));
  return parsedBranch === sanitizedScope || parsedBranch?.startsWith(`${sanitizedScope}.`) === true;
}

/** Prefix a resolved child Node Key with a parent Node Key, preserving nesting. */
export function withNodeKeyPrefix(prefix: string | undefined, nodeKey: string): string {
  return prefix ? `${prefix}/${nodeKey}` : nodeKey;
}

/** Sanitize a dynamic value to be filesystem-safe (shared with key-scope matching). */
function sanitizeValue(value: string): string {
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
