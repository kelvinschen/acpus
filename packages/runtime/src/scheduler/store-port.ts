import type { JsonValue } from "@acpus/expression/ir";
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
  result: { status: "completed"; output?: JsonValue } | { status: "failed" | "timed_out"; reason: string } | { status: "cancelled"; reason: "parent_failed" | "race_lost" | "quorum_reached" | "paused" | "superseded" };
  idempotencyKey: string;
};

export type SignalConsumeInput = {
  runId: string;
  nodeKey: string;
  ownerEpoch: number;
  payload: JsonValue;
  commandIdempotencyKey: string;
  idempotencyKey: string;
};

export type SchedulerPauseInput = {
  runId: string;
  ownerEpoch: number;
  reason?: string;
  idempotencyKey: string;
};

export type SchedulerResumeInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
};

export type SchedulerRetryInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
  nodeKey: string;
};

export type SchedulerRunRetryInput = {
  runId: string;
  ownerEpoch: number;
  idempotencyKey: string;
};

export type SchedulerStorePort = {
  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined;
  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean;
  releaseRun(claim: RunOwnerClaim): boolean;
  loadRunSnapshot(runId: string): SchedulerSnapshot;
  appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot;
  startAttempt(input: AttemptStartInput): { attemptId: string; attemptNo: number };
  commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot;
  consumeSignal(input: SignalConsumeInput): SchedulerSnapshot;
  pauseRun(input: SchedulerPauseInput): SchedulerSnapshot;
  resumeRun(input: SchedulerResumeInput): SchedulerSnapshot;
  retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot;
  retry(input: SchedulerRetryInput): SchedulerSnapshot;
  markExpiredOwnerAttemptsSuperseded(runId: string, ownerEpoch: number): SchedulerSnapshot;
};
