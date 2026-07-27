import { createHash } from "node:crypto";

const encodingVersion = 4;
const timelineOrderingVersion = 5;

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

function encode(value: PagePayload): string {
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
