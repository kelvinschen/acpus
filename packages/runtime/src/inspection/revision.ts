import { createHash } from "node:crypto";
import type { RunInspectionContext, RunInspectionCursor, RunInspectionQuery, RunInspectionRevision } from "./types.js";

const encodingVersion = 4;
const timelineOrderingVersion = 5;

type RevisionPayload = {
  v: 4;
  kind: "inspection";
  runId: string;
  fingerprint: string;
  target?: string;
  event: number;
  progress: number;
  observation: number;
  activity: string;
  visibility: string;
};

type PagePayloadBase = {
  v: 4;
  kind: "timeline-page";
  runId: string;
  target: string;
  ordering: 5;
};

type PagePayload = PagePayloadBase & {
  boundary: "entry";
  at: string;
  id: string;
  ordinal: number;
  beforeEntry?: {
    observationVersion: number;
    sourceSequence: number;
    id: string;
  };
};

export function inspectionFingerprint(
  query: RunInspectionQuery | { mode: RunInspectionQuery["mode"]; context?: RunInspectionContext },
): string {
  const context = "context" in query ? query.context ?? [] : [];
  const view = query.mode === "timeline"
    ? {
        limit: ("page" in query ? query.page?.limit : undefined) ?? 12,
        before: "page" in query ? query.page?.before : undefined,
      }
    : query.mode === "target" && "view" in query
      ? { view: query.view ?? "summary" }
      : undefined;
  return createHash("sha256")
    .update(JSON.stringify({ mode: query.mode, context, view }))
    .digest("base64url")
    .slice(0, 16);
}

export function inspectionRevision(input: {
  runId: string;
  query: RunInspectionQuery | { mode: RunInspectionQuery["mode"]; context?: RunInspectionContext };
  resolvedTarget?: string;
  cursor: RunInspectionCursor;
}): RunInspectionRevision {
  return encode({
    v: encodingVersion,
    kind: "inspection",
    runId: input.runId,
    fingerprint: inspectionFingerprint(input.query),
    ...(input.resolvedTarget ? { target: inspectionTargetFingerprint(input.resolvedTarget) } : {}),
    event: input.cursor.eventSequence,
    progress: input.cursor.progressVersion,
    observation: input.cursor.observationVersion,
    activity: stateFingerprint(null),
    visibility: stateFingerprint(null),
  }) as RunInspectionRevision;
}

export function inspectionRevisionWithState(
  revision: RunInspectionRevision,
  state: { activity: unknown; visibility: unknown },
): RunInspectionRevision {
  const decoded = decodeInspectionRevision(revision);
  if (!decoded) throw new Error("Inspection revision is invalid.");
  return encode({
    ...decoded,
    activity: stateFingerprint(state.activity),
    visibility: stateFingerprint(state.visibility),
  }) as RunInspectionRevision;
}

export function decodeInspectionRevision(value: string): RevisionPayload | undefined {
  const decoded = decode(value);
  if (!isRecord(decoded)
    || decoded.v !== encodingVersion
    || decoded.kind !== "inspection"
    || typeof decoded.runId !== "string"
    || typeof decoded.fingerprint !== "string"
    || decoded.target !== undefined && typeof decoded.target !== "string"
    || !safeVersion(decoded.event)
    || !safeVersion(decoded.progress)
    || !safeVersion(decoded.observation)
    || typeof decoded.activity !== "string"
    || typeof decoded.visibility !== "string") return undefined;
  return decoded as RevisionPayload;
}

export function timelinePageCursor(input: {
  runId: string;
  target: string;
  at: string;
  id: string;
  ordinal: number;
  beforeEntry?: PagePayload["beforeEntry"];
}): string {
  return encode({
    v: encodingVersion,
    kind: "timeline-page",
    runId: input.runId,
    target: inspectionTargetFingerprint(input.target),
    ordering: timelineOrderingVersion,
    boundary: "entry",
    at: input.at,
    id: input.id,
    ordinal: input.ordinal,
    ...(input.beforeEntry === undefined ? {} : { beforeEntry: input.beforeEntry }),
  });
}

export function inspectionTargetFingerprint(target: string): string {
  return createHash("sha256").update(target).digest("base64url").slice(0, 22);
}

function stateFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("base64url")
    .slice(0, 16);
}

export function decodeTimelinePageCursor(value: string): PagePayload | undefined {
  const decoded = decode(value);
  if (!isRecord(decoded)
    || decoded.v !== encodingVersion
    || decoded.kind !== "timeline-page"
    || decoded.ordering !== timelineOrderingVersion
    || typeof decoded.runId !== "string"
    || typeof decoded.target !== "string"
    || decoded.boundary !== "entry"
    || typeof decoded.at !== "string"
    || typeof decoded.id !== "string"
    || !safeVersion(decoded.ordinal)
    || decoded.beforeEntry !== undefined && !validEntryBoundary(decoded.beforeEntry)) return undefined;
  return decoded as PagePayload;
}

function encode(value: RevisionPayload | PagePayload): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validEntryBoundary(value: unknown): value is NonNullable<PagePayload["beforeEntry"]> {
  return isRecord(value)
    && safeVersion(value.observationVersion)
    && safeVersion(value.sourceSequence)
    && typeof value.id === "string";
}
