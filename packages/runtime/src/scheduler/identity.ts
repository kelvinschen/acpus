import { createHash } from "node:crypto";
import type { InstancePath, InstancePathSegment } from "./types.js";

export function deriveInstanceKey(path: InstancePath): string {
  const hash = deriveInstanceDigest(path);
  const readable = path.map(readableSegment).join("/") || "root";
  return `${truncateReadable(readable)}~${hash}`;
}

/** A stable, path-scoped digest for operator-facing occurrence selectors. */
export function deriveInstanceDigest(path: InstancePath): string {
  return createHash("sha256").update(canonicalPath(path)).digest("hex").slice(0, 8);
}

export function appendNode(path: InstancePath, nodeId: string): InstancePath {
  return [...path, { kind: "node", nodeId }];
}

export function appendBranch(path: InstancePath, nodeId: string, branchId: string): InstancePath {
  return [...path, { kind: "branch", nodeId, branchId }];
}

export function appendFanoutItem(path: InstancePath, nodeId: string, itemIndex: number): InstancePath {
  return [...path, { kind: "fanout", nodeId, itemIndex }];
}

export function appendLoopIteration(path: InstancePath, nodeId: string, iter: number): InstancePath {
  return [...path, { kind: "loop", nodeId, iter }];
}

function canonicalPath(path: InstancePath): string {
  return JSON.stringify(path.map(canonicalSegment));
}

function canonicalSegment(segment: InstancePathSegment): InstancePathSegment {
  if (segment.kind === "node") return { kind: "node", nodeId: segment.nodeId };
  if (segment.kind === "branch") return { kind: "branch", nodeId: segment.nodeId, branchId: segment.branchId };
  if (segment.kind === "fanout") return { kind: "fanout", nodeId: segment.nodeId, itemIndex: segment.itemIndex };
  return { kind: "loop", nodeId: segment.nodeId, iter: segment.iter };
}

function readableSegment(segment: InstancePathSegment): string {
  if (segment.kind === "node") return safePart(segment.nodeId);
  if (segment.kind === "branch") return `${safePart(segment.nodeId)}.${safePart(segment.branchId)}`;
  if (segment.kind === "fanout") return `${safePart(segment.nodeId)}[${segment.itemIndex}]`;
  return `${safePart(segment.nodeId)}#${segment.iter}`;
}

function safePart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";
}

function truncateReadable(value: string): string {
  if (value.length <= 160) return value;
  return `${value.slice(0, 72)}...${value.slice(-72)}`;
}
