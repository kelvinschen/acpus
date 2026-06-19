import type { NodeKeyTemplate } from "@acpus/core";
import type { NodeKeyDynamic } from "./types.js";

const DYNAMIC_SEGMENT = /^(item|lane|round|branch):/u;

export interface ParsedNodeKey {
  nodeKey: string;
  staticPath: string;
  staticSegments: string[];
  /** Collapsed dynamic dimensions (last-value-wins for repeated dimensions). */
  dynamic: NodeKeyDynamic;
  /**
   * Full frame-based parsing of dynamic dimensions. Each frame captures one
   * dynamic "scope" (e.g., from a fanout/parallel/loop parent). Repeated
   * dimensions appear in separate frames rather than being collapsed.
   */
  dynamicFrames: NodeKeyDynamic[];
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
  const frames = dynamic.frames && dynamic.frames.length > 0 ? dynamic.frames : [dynamic];

  // Always include dynamic dimensions when provided, regardless of template flags.
  // The template flags indicate the node *can* have that dimension, but at runtime
  // any ancestor that provides a dimension should be reflected in child keys too.
  for (const frame of frames) {
    if (frame.fanoutItemId !== undefined) {
      parts.push(`item:${sanitizeValue(String(frame.fanoutItemId))}`);
    }

    if (frame.laneId !== undefined) {
      parts.push(`lane:${sanitizeValue(String(frame.laneId))}`);
    }

    if (frame.parallelBranchId !== undefined) {
      parts.push(`branch:${sanitizeValue(String(frame.parallelBranchId))}`);
    }

    if (frame.loopRound !== undefined) {
      parts.push(`round:${String(frame.loopRound)}`);
    }
  }

  return parts.join("/");
}

/**
 * Parse a resolved Node Key into its static Node path and dynamic dimensions.
 *
 * Dynamic segments are slash-separated `type:value` segments matching the
 * DYNAMIC_SEGMENT pattern (`item:`, `lane:`, `branch:`, `round:`). Segments
 * that match are treated as dynamic; all others are static.
 *
 * **Ambiguity note**: A step ID like `branch:blue` would match DYNAMIC_SEGMENT
 * and be misparsed as dynamic. This is prevented at the compiler level:
 * authored step and branch IDs must match the safe ID pattern. The runtime
 * parsing relies on this compiler guarantee.
 */
export function parseNodeKey(nodeKey: string): ParsedNodeKey {
  const segments = nodeKey.split("/");
  const staticSegments: string[] = [];
  const dynamicSegments: string[] = [];

  for (const segment of segments) {
    if (DYNAMIC_SEGMENT.test(segment)) {
      dynamicSegments.push(segment);
    } else {
      staticSegments.push(segment);
    }
  }

  const dynamic: NodeKeyDynamic = {};
  for (const segment of dynamicSegments) {
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

  const dynamicFrames = buildDynamicFrames(dynamicSegments);

  return {
    nodeKey,
    staticPath: staticSegments.join("/"),
    staticSegments,
    dynamic,
    dynamicFrames
  };
}

/**
 * Build dynamic frames from the already-identified dynamic segments.
 * Each time we encounter a new "item:" segment, we start a new frame
 * (since item: begins a new fanout scope). Other dimensions accumulate
 * into the current frame.
 */
function buildDynamicFrames(dynamicSegments: string[]): NodeKeyDynamic[] {
  const frames: NodeKeyDynamic[] = [];
  let current: NodeKeyDynamic = {};

  for (const segment of dynamicSegments) {
    const [kind, ...rest] = segment.split(":");
    const value = rest.join(":");

    // item starts a fanout frame; branch/round start their own composite frames.
    if ((kind === "item" || kind === "branch" || kind === "round") && !isEmptyDynamicScope(current)) {
      frames.push(current);
      current = {};
    }

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

  if (!isEmptyDynamicScope(current)) {
    frames.push(current);
  }
  return frames;
}

/** Return the static IR nodePath represented by a resolved Node Key. */
export function staticNodePathFromKey(nodeKey: string): string {
  return parseNodeKey(nodeKey).staticPath;
}

/**
 * Test whether a resolved Node Key is below any of the provided anchor keys.
 * Comparison is based on static paths plus ordered dynamic frames: a node is
 * below an anchor when it is not the exact same key, its static path is at or
 * below the anchor's static path, and its dynamic frames stay within the
 * anchor's runtime instance.
 */
export function isNodeKeyBelowAnyAnchor(nodeKey: string, anchorKeys: string[]): boolean {
  if (anchorKeys.length === 0) return false;
  const nodeParsed = parseNodeKey(nodeKey);

  for (const anchorKey of anchorKeys) {
    // Skip if this IS the anchor (not below it)
    if (nodeKey === anchorKey) continue;
    const anchorParsed = parseNodeKey(anchorKey);
    // Check that the node's static path is below the anchor's static path
    if (nodeParsed.staticPath === anchorParsed.staticPath || nodeParsed.staticPath.startsWith(`${anchorParsed.staticPath}/`)) {
      // Verify dynamic scope alignment: the node must be in the same dynamic
      // scope as the anchor (or a nested sub-scope under it)
      if (isDynamicFramePrefix(anchorParsed.dynamicFrames, nodeParsed.dynamicFrames)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check whether the anchor's ordered dynamic frames are a prefix of the node's
 * dynamic frames. This preserves subworkflow/fanout nesting boundaries when
 * the same inner item/lane values repeat under different outer instances.
 */
function isDynamicFramePrefix(anchorFrames: NodeKeyDynamic[], nodeFrames: NodeKeyDynamic[]): boolean {
  anchorFrames = collapseAdjacentDuplicateFrames(anchorFrames);
  nodeFrames = collapseAdjacentDuplicateFrames(nodeFrames);
  if (anchorFrames.length > nodeFrames.length) return false;

  return anchorFrames.every((anchorFrame, index) => {
    const nodeFrame = nodeFrames[index]!;
    if (anchorFrame.fanoutItemId !== undefined && nodeFrame.fanoutItemId !== anchorFrame.fanoutItemId) {
      return false;
    }
    if (anchorFrame.laneId !== undefined && nodeFrame.laneId !== anchorFrame.laneId) {
      return false;
    }
    if (
      anchorFrame.parallelBranchId !== undefined &&
      !isParallelBranchInScope(nodeFrame.parallelBranchId, anchorFrame.parallelBranchId)
    ) {
      return false;
    }
    if (anchorFrame.loopRound !== undefined && nodeFrame.loopRound !== anchorFrame.loopRound) {
      return false;
    }
    return true;
  });
}

function collapseAdjacentDuplicateFrames(frames: NodeKeyDynamic[]): NodeKeyDynamic[] {
  const collapsed: NodeKeyDynamic[] = [];
  for (const frame of frames) {
    const previous = collapsed.at(-1);
    if (previous !== undefined && isSameDynamicFrame(previous, frame)) continue;
    collapsed.push(frame);
  }
  return collapsed;
}

function isSameDynamicFrame(left: NodeKeyDynamic, right: NodeKeyDynamic): boolean {
  return (
    left.fanoutItemId === right.fanoutItemId &&
    left.laneId === right.laneId &&
    left.parallelBranchId === right.parallelBranchId &&
    left.loopRound === right.loopRound
  );
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

  const requiredFrames = dynamicFrames(dynamic);
  return isDynamicFrameSubsequence(requiredFrames, collectDynamicFrames(nodeKey));
}

function isDynamicFrameSubsequence(requiredFrames: NodeKeyDynamic[], nodeFrames: NodeKeyDynamic[]): boolean {
  let nodeIndex = 0;
  for (const required of requiredFrames) {
    let matched = false;
    for (; nodeIndex < nodeFrames.length; nodeIndex++) {
      if (isDynamicFrameScopeMatch(nodeFrames[nodeIndex]!, required)) {
        matched = true;
        nodeIndex++;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function isDynamicFrameScopeMatch(frame: DynamicFrame, required: NodeKeyDynamic): boolean {
  return (
    (required.fanoutItemId === undefined || frame.fanoutItemId === required.fanoutItemId) &&
    (required.laneId === undefined || frame.laneId === required.laneId) &&
    (required.parallelBranchId === undefined || isParallelBranchInScope(frame.parallelBranchId, required.parallelBranchId)) &&
    (required.loopRound === undefined || frame.loopRound === required.loopRound)
  );
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

    // item starts a fanout frame; branch/round start their own composite frames.
    if ((kind === "item" || kind === "branch" || kind === "round") && !isEmptyDynamicScope(current)) {
      pushDynamicFrame(frames, current);
      current = {};
    }

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

function dynamicFrames(dynamic: NodeKeyDynamic): NodeKeyDynamic[] {
  if (dynamic.frames && dynamic.frames.length > 0) return dynamic.frames;
  const { frames: _frames, ...frame } = dynamic;
  return isEmptyDynamicScope(frame) ? [] : splitDynamicFrame(frame);
}

function splitDynamicFrame(frame: NodeKeyDynamic): NodeKeyDynamic[] {
  const frames: NodeKeyDynamic[] = [];
  if (frame.fanoutItemId !== undefined || frame.laneId !== undefined) {
    frames.push({
      fanoutItemId: frame.fanoutItemId === undefined ? undefined : sanitizeValue(String(frame.fanoutItemId)),
      laneId: frame.laneId === undefined ? undefined : sanitizeValue(String(frame.laneId))
    });
  }
  if (frame.parallelBranchId !== undefined) frames.push({ parallelBranchId: sanitizeValue(String(frame.parallelBranchId)) });
  if (frame.loopRound !== undefined) frames.push({ loopRound: frame.loopRound });
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
