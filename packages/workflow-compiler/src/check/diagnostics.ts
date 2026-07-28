import { resolve } from "node:path";
import type { DiagnosticIR } from "@acpus/core/ir";

export type DiagnosticOrigin = "config" | "program" | "global" | "syntactic" | "semantic" | "authoring" | "source";

export type AuthoringOwnership =
  | "expr-condition"
  | "expr-negation"
  | "expr-nullish"
  | "expr-equality"
  | "expr-relational"
  | "expr-switch";

export type DiagnosticCandidate = {
  diagnostic: DiagnosticIR;
  origin: DiagnosticOrigin;
  file?: string;
  start?: number;
  end?: number;
  sequence: number;
  ownership?: AuthoringOwnership;
  ownershipStart?: number;
  ownershipEnd?: number;
};

export function normalizeDiagnostics(candidates: readonly DiagnosticCandidate[], entry: string): DiagnosticIR[] {
  const ownedByTypeScript = candidates.filter(candidate => candidate.origin === "semantic" && candidate.ownership);
  const singleOwned = candidates.filter(candidate => {
    if (candidate.origin !== "authoring" || !candidate.ownership) return true;
    return !ownedByTypeScript.some(native => native.ownership === candidate.ownership
      && sameFile(native.file, candidate.file)
      && rangesOverlap(ownershipRange(native), ownershipRange(candidate)));
  });
  const broad = new Set(singleOwned.filter(candidate => candidate.origin === "semantic"
    && candidate.file
    && candidate.start !== undefined
    && candidate.end !== undefined
    && candidate.end > candidate.start
    && singleOwned.some(other => other !== candidate
      && sameFile(candidate.file, other.file)
      && containsRange(candidate, other))));
  const sorted = [...singleOwned].sort((left, right) => compareCandidates(left, right, entry, broad));
  const seen = new Set<string>();
  return sorted.flatMap(candidate => {
    const key = visibleDiagnosticKey(candidate.diagnostic);
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate.diagnostic];
  });
}

function compareCandidates(
  left: DiagnosticCandidate,
  right: DiagnosticCandidate,
  entry: string,
  broad: ReadonlySet<DiagnosticCandidate>,
): number {
  const leftGroup = diagnosticGroup(left, entry);
  const rightGroup = diagnosticGroup(right, entry);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftGroup === 5) {
    const fileOrder = (left.file ?? "").localeCompare(right.file ?? "");
    if (fileOrder !== 0) return fileOrder;
  }
  if (sameFile(left.file, right.file)) {
    if (broad.has(left) && containsRange(left, right)) return 1;
    if (broad.has(right) && containsRange(right, left)) return -1;
  }
  return sourceStart(left) - sourceStart(right) || left.sequence - right.sequence;
}

function diagnosticGroup(candidate: DiagnosticCandidate, entry: string): number {
  switch (candidate.origin) {
    case "config": return 0;
    case "program": return 1;
    case "global": return 2;
    case "syntactic": return 3;
    case "authoring":
    case "source":
      return candidate.file && sameFile(candidate.file, entry) ? 4 : 5;
    case "semantic": return sameFile(candidate.file, entry) ? 4 : 5;
  }
}

function sourceStart(candidate: DiagnosticCandidate): number {
  if (candidate.start !== undefined) return candidate.start;
  const source = candidate.diagnostic.source;
  return source?.line === undefined ? Number.MAX_SAFE_INTEGER : source.line * 1_000_000 + (source.column ?? 0);
}

function ownershipRange(candidate: DiagnosticCandidate): { start?: number; end?: number } {
  const start = candidate.ownershipStart ?? candidate.start;
  const end = candidate.ownershipEnd ?? candidate.end;
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function rangesOverlap(left: { start?: number; end?: number }, right: { start?: number; end?: number }): boolean {
  if (left.start === undefined || left.end === undefined || right.start === undefined || right.end === undefined) return false;
  return left.start <= right.end && right.start <= left.end;
}

function containsRange(container: DiagnosticCandidate, contained: DiagnosticCandidate): boolean {
  if (container.start === undefined || container.end === undefined || contained.start === undefined || contained.end === undefined) return false;
  return container.start <= contained.start
    && container.end >= contained.end
    && (container.start < contained.start || container.end > contained.end);
}

function sameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  return resolve(left) === resolve(right);
}

function visibleDiagnosticKey(diagnostic: DiagnosticIR): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.path,
    diagnostic.source?.file,
    diagnostic.source?.line,
    diagnostic.source?.column,
    diagnostic.hint,
  ]);
}
