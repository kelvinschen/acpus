import { deriveInstanceDigest } from "./identity.js";
import type { InstancePath, SchedulerFrame, SchedulerProjection } from "./types.js";

export type OccurrenceRef = `@${string}`;

type ResolvedOccurrenceRef =
  | {
      kind: "node";
      ref: OccurrenceRef;
      nodeKey: string;
      nodeId: string;
      instancePath: InstancePath;
    }
  | {
      kind: "frame";
      ref: OccurrenceRef;
      frameKey: string;
      nodeKey?: string;
      nodeId?: string;
      instancePath: InstancePath;
    }
  | {
      kind: "attempt";
      ref: OccurrenceRef;
      nodeKey: string;
      nodeId: string;
      attemptId: string;
      attemptNo: number;
      instancePath: InstancePath;
    };

type OccurrenceRefResolutionError =
  | { type: "invalid-occurrence-ref"; target: string }
  | { type: "occurrence-ref-attempt-not-allowed"; target: string; attemptNo: number }
  | { type: "occurrence-ref-not-found"; target: string }
  | { type: "occurrence-ref-collision"; target: string; candidateKeys: string[] };

export type OccurrenceRefResolution =
  | { ok: true; value: ResolvedOccurrenceRef }
  | { ok: false; error: OccurrenceRefResolutionError };

export type OccurrenceRefCandidate<T> = {
  ref: OccurrenceRef;
  value: T;
};

export type OccurrenceRefCandidateResolution<T> =
  | { kind: "not-occurrence-ref" }
  | { kind: "invalid"; target: string }
  | { kind: "not-found"; target: string }
  | { kind: "collision"; target: string; candidates: readonly T[] }
  | { kind: "resolved"; target: string; candidate: T; attemptNo?: number };

/** Returns the short, Run-scoped selector for one fully structured path. */
export function deriveOccurrenceRef(path: InstancePath): OccurrenceRef {
  return `@${deriveInstanceDigest(path)}`;
}

/**
 * Resolves only the short selector grammar. Callers keep ordinary authored IDs
 * and full diagnostic keys on their existing paths.
 */
export function resolveOccurrenceRef(
  projection: SchedulerProjection,
  target: string,
  options: { attempt?: "allow" | "reject" } = {},
): OccurrenceRefResolution | undefined {
  const parsed = target.startsWith("@") ? parseOccurrenceRef(target) : undefined;
  if (parsed?.attemptNo !== undefined && options.attempt === "reject") {
    return {
      ok: false,
      error: {
        type: "occurrence-ref-attempt-not-allowed",
        target,
        attemptNo: parsed.attemptNo,
      },
    };
  }
  const lookup = resolveOccurrenceRefCandidate(target, occurrenceTargets(projection).map(value => ({
    ref: value.ref,
    value,
  })));
  if (lookup.kind === "not-occurrence-ref") return undefined;
  if (lookup.kind === "invalid") return { ok: false, error: { type: "invalid-occurrence-ref", target } };
  if (lookup.kind === "not-found") return { ok: false, error: { type: "occurrence-ref-not-found", target } };
  if (lookup.kind === "collision") {
    return {
      ok: false,
      error: {
        type: "occurrence-ref-collision",
        target,
        candidateKeys: lookup.candidates.map(occurrenceDiagnosticKey).sort(),
      },
    };
  }
  const match = lookup.candidate;
  if (lookup.attemptNo === undefined) return { ok: true, value: match };
  if (match.kind !== "node") return { ok: false, error: { type: "occurrence-ref-not-found", target } };
  const attempts = Object.values(projection.attempts)
    .filter(attempt => attempt.nodeKey === match.nodeKey && attempt.attemptNo === lookup.attemptNo);
  if (attempts.length === 0) return { ok: false, error: { type: "occurrence-ref-not-found", target } };
  if (attempts.length > 1) {
    return {
      ok: false,
      error: {
        type: "occurrence-ref-collision",
        target,
        candidateKeys: attempts.map(attempt => attempt.attemptId).sort(),
      },
    };
  }
  const attempt = attempts[0]!;
  return {
    ok: true,
    value: {
      kind: "attempt",
      ref: match.ref,
      nodeKey: attempt.nodeKey,
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
      attemptNo: attempt.attemptNo,
      instancePath: match.instancePath,
    },
  };
}

export function occurrenceRefSelector(ref: OccurrenceRef, attemptNo?: number): string {
  return attemptNo === undefined ? ref : `${ref}#${attemptNo}`;
}

export function resolveOccurrenceRefCandidate<T>(
  target: string,
  candidates: readonly OccurrenceRefCandidate<T>[],
): OccurrenceRefCandidateResolution<T> {
  if (!target.startsWith("@")) return { kind: "not-occurrence-ref" };
  const parsed = parseOccurrenceRef(target);
  if (!parsed) return { kind: "invalid", target };
  const matches = candidates.filter(candidate => candidate.ref === parsed.ref);
  if (matches.length === 0) return { kind: "not-found", target };
  if (matches.length > 1) return { kind: "collision", target, candidates: matches.map(candidate => candidate.value) };
  return {
    kind: "resolved",
    target,
    candidate: matches[0]!.value,
    ...(parsed.attemptNo === undefined ? {} : { attemptNo: parsed.attemptNo }),
  };
}

function parseOccurrenceRef(value: string): { ref: OccurrenceRef; attemptNo?: number } | undefined {
  const match = /^@([0-9a-f]{12})(?:#([1-9]\d*))?$/.exec(value);
  if (!match) return undefined;
  const attemptNo = match[2] === undefined ? undefined : Number(match[2]);
  if (attemptNo !== undefined && !Number.isSafeInteger(attemptNo)) return undefined;
  return {
    ref: `@${match[1]}`,
    ...(attemptNo === undefined ? {} : { attemptNo }),
  };
}

type BaseOccurrenceRef = Exclude<ResolvedOccurrenceRef, { kind: "attempt" }>;

function occurrenceTargets(projection: SchedulerProjection): BaseOccurrenceRef[] {
  const byPath = new Map<string, BaseOccurrenceRef[]>();
  for (const instance of Object.values(projection.instances)) {
    addTarget(byPath, {
      kind: "node",
      ref: deriveOccurrenceRef(instance.instancePath),
      nodeKey: instance.nodeKey,
      nodeId: instance.nodeId,
      instancePath: instance.instancePath,
    });
  }
  for (const frame of Object.values(projection.frames)) {
    if (frame.frameKind === "root" || !frame.instancePath) continue;
    addTarget(byPath, frameTarget(frame));
  }

  const targets: BaseOccurrenceRef[] = [];
  for (const values of byPath.values()) {
    const nodes = values.filter((value): value is Extract<BaseOccurrenceRef, { kind: "node" }> => value.kind === "node");
    if (nodes.length > 0) {
      targets.push(...nodes);
      continue;
    }
    targets.push(...values);
  }
  return targets;
}

function frameTarget(frame: SchedulerFrame): Extract<BaseOccurrenceRef, { kind: "frame" }> {
  return {
    kind: "frame",
    ref: deriveOccurrenceRef(frame.instancePath!),
    frameKey: frame.frameKey,
    ...(frame.nodeKey === undefined ? {} : { nodeKey: frame.nodeKey }),
    ...(frame.nodeId === undefined ? {} : { nodeId: frame.nodeId }),
    instancePath: frame.instancePath!,
  };
}

function occurrenceDiagnosticKey(value: BaseOccurrenceRef): string {
  return value.kind === "node" ? value.nodeKey : value.frameKey;
}

function addTarget(byPath: Map<string, BaseOccurrenceRef[]>, target: BaseOccurrenceRef): void {
  const key = JSON.stringify(target.instancePath);
  const values = byPath.get(key);
  if (values) values.push(target);
  else byPath.set(key, [target]);
}
