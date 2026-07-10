import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";
import type { SchedulerEvent } from "./events.js";
import type { SchedulerProjection } from "./types.js";

export type RunOwnerClaim = {
  runId: string;
  ownerId: string;
  ownerEpoch: number;
  leaseExpiresAt: string;
};

export type SchedulerSnapshot = {
  runId: string;
  version: number;
  projection: SchedulerProjection;
};

export type SchedulerStoreError =
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "version-mismatch"; runId: string; expectedVersion: number; actualVersion: number; message: string }
  | { type: "owner-epoch-inactive"; runId: string; ownerEpoch: number; message: string }
  | { type: "owner-epoch-still-active"; runId: string; ownerEpoch: number; message: string }
  | { type: "run-paused"; runId: string; message: string }
  | { type: "terminal-attempt"; attemptId: string; status: string; message: string }
  | { type: "attempt-not-found"; attemptId: string; message: string }
  | { type: "owner-epoch-stale"; runId: string; attemptId: string; ownerEpoch: number; message: string }
  | { type: "signal-wait-not-found"; runId: string; nodeKey: string; message: string }
  | { type: "signal-wait-terminal"; runId: string; nodeKey: string; status: string; message: string }
  | { type: "idempotency-conflict"; idempotencyKey: string; runId?: string; message: string }
  | { type: "missing-retry-target"; runId: string; targetKey: string; message: string }
  | { type: "invalid-retry-target"; runId: string; targetKey?: string; status: string; message: string }
  | { type: "missing-cancel-target"; runId: string; targetKey: string; message: string }
  | { type: "invalid-cancel-target"; runId: string; targetKey?: string; status: string; message: string }
  | { type: "invalid-control-state"; runId: string; command: "resume"; status: string; message: string };

export type SchedulerStoreResult<T> = Result<T, SchedulerStoreError>;

export class SchedulerStoreException extends Error {
  constructor(readonly failure: SchedulerStoreError) {
    super(failure.message);
  }
}

export function schedulerStoreError(error: unknown): SchedulerStoreError | undefined {
  return error instanceof SchedulerStoreException ? error.failure : undefined;
}

export function schedulerStoreResult<T>(fn: () => T): SchedulerStoreResult<T> {
  try {
    return ok(fn());
  } catch (error) {
    const storeError = schedulerStoreError(error);
    if (storeError) return err(storeError);
    throw error;
  }
}

export function throwSchedulerStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return result.match(
    value => value,
    error => {
      throw new SchedulerStoreException(error);
    },
  );
}

export type SchedulerCommit = {
  runId: string;
  expectedVersion: number;
  ownerEpoch: number;
  events: SchedulerEvent[];
  idempotencyKey: string;
};

export type AttemptStartInput = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  ownerEpoch: number;
  deadlineAt?: string;
  idempotencyKey: string;
};

export type AttemptCommitInput = {
  runId: string;
  attemptId: string;
  ownerEpoch: number;
  result: { status: "completed"; output?: JsonValue } | { status: "failed" | "timed_out"; reason: string; error?: JsonObject } | { status: "cancelled"; reason: "parent_failed" | "race_lost" | "quorum_reached" | "paused" | "superseded" };
  idempotencyKey: string;
};

export type SignalConsumeInput = {
  runId: string;
  nodeKey: string;
  ownerEpoch: number;
  payload: JsonValue;
  commandIdempotencyKey: string;
  idempotencyKey: string;
  now?: Date;
};

export type SchedulerPauseInput = {
  runId: string;
  ownerEpoch: number;
  reason?: string;
  idempotencyKey: string;
  now?: Date;
};

export type SchedulerResumeInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
  now?: Date;
};

export type SchedulerRetryInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
  targetKey: string;
};

export type SchedulerRunRetryInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
};

export type SchedulerCancelInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
  targetKey?: string;
};

export type SchedulerStorePort = {
  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined;
  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean;
  releaseRun(claim: RunOwnerClaim): boolean;
  tryLoadRunSnapshot(runId: string): SchedulerStoreResult<SchedulerSnapshot>;
  loadRunSnapshot(runId: string): SchedulerSnapshot;
  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerStoreResult<SchedulerSnapshot>;
  appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot;
  tryStartAttempt(input: AttemptStartInput): SchedulerStoreResult<{ attemptId: string; attemptNo: number }>;
  startAttempt(input: AttemptStartInput): { attemptId: string; attemptNo: number };
  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerStoreResult<SchedulerSnapshot>;
  commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot;
  tryConsumeSignal(input: SignalConsumeInput): SchedulerStoreResult<SchedulerSnapshot>;
  consumeSignal(input: SignalConsumeInput): SchedulerSnapshot;
  tryPauseRun(input: SchedulerPauseInput): SchedulerStoreResult<SchedulerSnapshot>;
  pauseRun(input: SchedulerPauseInput): SchedulerSnapshot;
  tryResumeRun(input: SchedulerResumeInput): SchedulerStoreResult<SchedulerSnapshot>;
  resumeRun(input: SchedulerResumeInput): SchedulerSnapshot;
  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot>;
  retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot;
  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot>;
  retry(input: SchedulerRetryInput): SchedulerSnapshot;
  tryCancel(input: SchedulerCancelInput): SchedulerStoreResult<SchedulerSnapshot>;
  cancel(input: SchedulerCancelInput): SchedulerSnapshot;
  tryMarkExpiredOwnerAttemptsSuperseded(runId: string, ownerEpoch: number): SchedulerStoreResult<SchedulerSnapshot>;
  markExpiredOwnerAttemptsSuperseded(runId: string, ownerEpoch: number): SchedulerSnapshot;
};
