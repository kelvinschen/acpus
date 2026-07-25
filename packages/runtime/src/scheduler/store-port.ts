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
  | { type: "instance-not-ready"; runId: string; nodeKey: string; status: string; message: string }
  | { type: "terminal-attempt"; attemptId: string; status: string; message: string }
  | { type: "attempt-not-found"; attemptId: string; message: string }
  | { type: "owner-epoch-stale"; runId: string; attemptId: string; ownerEpoch: number; message: string }
  | { type: "signal-wait-not-found"; runId: string; nodeKey: string; message: string }
  | { type: "signal-wait-terminal"; runId: string; nodeKey: string; status: string; message: string }
  | { type: "idempotency-conflict"; idempotencyKey: string; runId?: string; message: string }
  | { type: "missing-retry-target"; runId: string; targetKey: string; message: string }
  | { type: "ambiguous-retry-target"; runId: string; targetKey: string; candidateKeys: string[]; message: string }
  | { type: "invalid-retry-target"; runId: string; targetKey?: string; status: string; message: string }
  | { type: "missing-cancel-target"; runId: string; targetKey: string; message: string }
  | { type: "ambiguous-cancel-target"; runId: string; targetKey: string; candidateKeys: string[]; message: string }
  | { type: "invalid-cancel-target"; runId: string; targetKey?: string; status: string; message: string }
  | { type: "missing-steer-target"; runId: string; targetKey: string; message: string }
  | { type: "ambiguous-steer-target"; runId: string; targetKey: string; candidateKeys: string[]; message: string }
  | { type: "invalid-steer-target"; runId: string; targetKey: string; status: string; message: string }
  | { type: "steer-session-conflict"; runId: string; targetKey: string; candidateKeys: string[]; message: string }
  | { type: "invalid-steer-instruction"; runId: string; message: string }
  | { type: "deadline-out-of-range"; runId: string; nodeKey: string; message: string };

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
  intentDigest?: string;
};

export type AttemptStartInput = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  ownerEpoch: number;
  expectedVersion: number;
  deadlineAt?: string;
  idempotencyKey: string;
};

export type AttemptStartResult = {
  attemptId: string;
  attemptNo: number;
  snapshot: SchedulerSnapshot;
  disposition: "started" | "existing";
  steer?: { steerId: string; instruction: string };
};

export type SchedulerRecoveryInput = {
  runId: string;
  currentOwnerEpoch: number;
  expiredOwnerEpoch: number;
  expectedVersion: number;
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
  requestedTarget?: string;
  ownerEpoch: number;
  payload: JsonValue;
  commandIdempotencyKey: string;
  idempotencyKey: string;
  now?: Date;
};

export type SchedulerPauseInput = {
  runId: string;
  ownerEpoch: number;
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
  target: string;
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
  target?: string;
};

export type SchedulerSteerInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
  steerId: string;
  target: string;
  instruction: string;
};

export type SchedulerSteerResult = {
  snapshot: SchedulerSnapshot;
  steerId: string;
  requestedTarget: string;
  target: string;
  fencedAttemptId: string;
};

export type SchedulerStorePort = {
  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined;
  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean;
  releaseRun(claim: RunOwnerClaim): boolean;
  tryLoadRunSnapshot(runId: string): SchedulerStoreResult<SchedulerSnapshot>;
  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerStoreResult<SchedulerSnapshot>;
  tryStartAttempt(input: AttemptStartInput): SchedulerStoreResult<AttemptStartResult>;
  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryConsumeSignal(input: SignalConsumeInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryPauseRun(input: SchedulerPauseInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryResumeRun(input: SchedulerResumeInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot>;
  tryCancel(input: SchedulerCancelInput): SchedulerStoreResult<SchedulerSnapshot>;
  trySteerAgent(input: SchedulerSteerInput): SchedulerStoreResult<SchedulerSteerResult>;
  tryMarkExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerStoreResult<SchedulerSnapshot>;
};
