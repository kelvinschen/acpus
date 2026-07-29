import {
  deriveOccurrenceRef,
  resolveOccurrenceRefCandidate,
} from "../scheduler/occurrence-ref.js";
import type {
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
} from "../store/store.js";
import type {
  RunInspectionCandidate,
  RunInspectionCandidatesDocument,
  RunInspectionStaticNode,
  RunInspectionStatus,
} from "./types.js";

type TargetableOccurrence = {
  kind: "dynamic-node" | "frame";
  target: string;
  ref: string;
  nodeId?: string;
  staticCandidate?: true;
  path: NonNullable<RunDynamicNodeInstance["instancePath"]>;
  status: RunInspectionStatus;
  diagnosticKey: string;
};

export type InspectionTargetResolution =
  | { kind: "resolved"; target: string }
  | { kind: "candidates"; document: RunInspectionCandidatesDocument }
  | { kind: "not-found" }
  | { kind: "ref-collision"; candidateKeys: string[] };

export function resolveInspectionTarget(input: {
  run: RunDetails;
  staticNodes: readonly RunInspectionStaticNode[];
  target: string;
  page?: { number?: number; limit?: number };
}): InspectionTargetResolution {
  const allOccurrences = targetableOccurrences(input.run);
  const ref = resolveOccurrenceRefCandidate(input.target, allOccurrences.map(value => ({
    ref: value.ref as `@${string}`,
    value,
  })));
  if (ref.kind !== "not-occurrence-ref") {
    if (ref.kind === "invalid" || ref.kind === "not-found") return { kind: "not-found" };
    if (ref.kind === "collision") {
      return {
        kind: "ref-collision",
        candidateKeys: ref.candidates.map(candidate => candidate.diagnosticKey).sort(),
      };
    }
    const match = ref.candidate;
    if (ref.attemptNo === undefined) return { kind: "resolved", target: match.target };
    if (match.kind !== "dynamic-node") return { kind: "not-found" };
    const attempts = (input.run.dynamic?.attempts ?? [])
      .filter(attempt => attempt.nodeKey === match.target && attempt.attemptNo === ref.attemptNo);
    return attempts.length === 1
      ? { kind: "resolved", target: attempts[0]!.attemptId }
      : attempts.length > 1
        ? { kind: "ref-collision", candidateKeys: attempts.map(attempt => attempt.attemptId).sort() }
        : { kind: "not-found" };
  }

  const dynamic = input.run.dynamic;
  if (dynamic?.attempts.some(attempt => attempt.attemptId === input.target)
    || dynamic?.nodeInstances.some(instance => instance.nodeKey === input.target)
    || dynamic?.frames.some(frame => frame.frameKey === input.target)) {
    return { kind: "resolved", target: input.target };
  }

  if (!input.staticNodes.some(node => node.nodeId === input.target)) return { kind: "not-found" };
  const matches = allOccurrences.filter(candidate => candidate.staticCandidate && candidate.nodeId === input.target);
  if (matches.length === 0) return { kind: "resolved", target: input.target };
  if (matches.length === 1) return { kind: "resolved", target: matches[0]!.target };
  return {
    kind: "candidates",
    document: candidateDocument(input.run, input.target, matches, input.page),
  };
}

function targetableOccurrences(run: RunDetails): TargetableOccurrence[] {
  const dynamic = run.dynamic;
  const attemptsByNodeKey = new Map<string, RunDynamicAttempt[]>();
  for (const attempt of dynamic?.attempts ?? []) addToMap(attemptsByNodeKey, attempt.nodeKey, attempt);
  const waitsByNodeKey = new Map<string, RunDynamicSignalWait>();
  for (const wait of dynamic?.signalWaits ?? []) waitsByNodeKey.set(wait.nodeKey, wait);

  const byPath = new Map<string, TargetableOccurrence[]>();
  for (const instance of dynamic?.nodeInstances ?? []) {
    const path = requireInstancePath(instance.nodeKey, instance.instancePath);
    const latest = latestAttempt(attemptsByNodeKey.get(instance.nodeKey) ?? []);
    const wait = waitsByNodeKey.get(instance.nodeKey);
    addOccurrence(byPath, {
      kind: "dynamic-node",
      target: instance.nodeKey,
      ref: deriveOccurrenceRef(path),
      nodeId: instance.nodeId,
      staticCandidate: true,
      path,
      status: normalizeStatus(wait?.status === "awaiting" || wait?.status === "timed_out"
        ? wait.status
        : latest?.status === "timed_out" ? "timed_out" : instance.status),
      diagnosticKey: instance.nodeKey,
    });
  }
  for (const frame of dynamic?.frames ?? []) {
    if (frame.frameKind === "root") continue;
    const path = requireInstancePath(frame.frameKey, frame.instancePath);
    addOccurrence(byPath, frameOccurrence(frame, path));
  }

  const resolved: TargetableOccurrence[] = [];
  for (const values of byPath.values()) {
    const nodes = values.filter(candidate => candidate.kind === "dynamic-node");
    if (nodes.length > 0) {
      resolved.push(...nodes);
      continue;
    }
    resolved.push(...values);
  }
  return resolved;
}

function frameOccurrence(
  frame: RunDynamicFrame,
  path: NonNullable<RunDynamicFrame["instancePath"]>,
): TargetableOccurrence {
  return {
    kind: "frame",
    target: frame.frameKey,
    ref: deriveOccurrenceRef(path),
    ...(frame.nodeId === undefined ? {} : { nodeId: frame.nodeId }),
    ...((frame.frameKind === "node" || frame.frameKind === "loop") ? { staticCandidate: true as const } : {}),
    path,
    status: normalizeStatus(frame.status),
    diagnosticKey: frame.frameKey,
  };
}

function candidateDocument(
  run: RunDetails,
  target: string,
  candidates: readonly TargetableOccurrence[],
  page: { number?: number; limit?: number } | undefined,
): RunInspectionCandidatesDocument {
  const number = page?.number ?? 1;
  const limit = page?.limit ?? 12;
  const ordered = [...candidates].sort(compareOccurrence);
  const start = (number - 1) * limit;
  const entries = ordered.slice(start, start + limit).map(toCandidate);
  return {
    schemaVersion: 2,
    kind: "candidates",
    run: { id: run.id, status: run.status, updatedAt: run.updatedAt },
    target,
    candidates: {
      entries,
      page: number,
      limit,
      total: ordered.length,
      hasMore: start + entries.length < ordered.length,
      ...(start + entries.length < ordered.length ? { nextPage: number + 1 } : {}),
    },
  };
}

function toCandidate(value: TargetableOccurrence): RunInspectionCandidate {
  return {
    ref: value.ref,
    status: value.status,
    breadcrumb: breadcrumb(value.path),
    kind: value.kind,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
  };
}

function compareOccurrence(left: TargetableOccurrence, right: TargetableOccurrence): number {
  return occurrencePriority(left.status) - occurrencePriority(right.status)
    || breadcrumb(left.path).localeCompare(breadcrumb(right.path))
    || left.ref.localeCompare(right.ref)
    || left.kind.localeCompare(right.kind);
}

function occurrencePriority(status: RunInspectionStatus): number {
  if (status === "awaiting" || status === "failed" || status === "timed_out") return 0;
  if (status === "starting" || status === "running") return 1;
  return 2;
}

function breadcrumb(path: TargetableOccurrence["path"]): string {
  return path.map(segment => {
    if (segment.kind === "node") return segment.nodeId;
    if (segment.kind === "branch") return `${segment.nodeId}.${segment.branchId}`;
    if (segment.kind === "fanout") return `${segment.nodeId}[${segment.itemIndex}]`;
    return `${segment.nodeId}#${segment.iter}`;
  }).join(" › ");
}

function addOccurrence(byPath: Map<string, TargetableOccurrence[]>, occurrence: TargetableOccurrence): void {
  const key = JSON.stringify(occurrence.path);
  const values = byPath.get(key);
  if (values) values.push(occurrence);
  else byPath.set(key, [occurrence]);
}

function addToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function latestAttempt(attempts: readonly RunDynamicAttempt[]): RunDynamicAttempt | undefined {
  return [...attempts].sort((left, right) => right.attemptNo - left.attemptNo
    || right.startedAt.localeCompare(left.startedAt)
    || right.attemptId.localeCompare(left.attemptId))[0];
}

function normalizeStatus(status: string): RunInspectionStatus {
  if (status === "canceled" || status === "superseded") return "cancelled";
  const known: RunInspectionStatus[] = ["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "cancelled", "mixed"];
  return known.includes(status as RunInspectionStatus) ? status as RunInspectionStatus : "mixed";
}

function requireInstancePath<T extends string>(key: T, path: RunDynamicNodeInstance["instancePath"]): NonNullable<RunDynamicNodeInstance["instancePath"]> {
  if (!path) throw new Error(`Materialized occurrence '${key}' has no instance path.`);
  return path;
}
