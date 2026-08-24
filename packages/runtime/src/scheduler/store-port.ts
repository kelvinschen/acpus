import type { Sha256Digest } from "@acpus/core/content-identity";
import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import * as Result from "effect/Result";
import type {
  AgentAttemptOperationPlan,
  AgentOperationPlanError,
  AgentSessionCheckpoint,
  AgentSessionCheckpointValue,
} from "../execution/agent-operation-plan.js";
import type { AgentPromptOrigin } from "../execution/agent-prompt.js";
import type { SchedulerEvent } from "./events.js";
import type { RuntimeSteerProjection } from "./steer-lifecycle.js";
import type { SchedulerProjection } from "./types.js";
import type { ReplayIdentity } from "./types.js";

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
  | { type: "agent-session-not-found"; runId: string; agentSessionId: string; message: string }
  | { type: "agent-session-binding-conflict"; runId: string; attemptId: string; message: string }
  | { type: "agent-session-checkpoint-conflict"; runId: string; agentSessionId: string; message: string }
  | { type: "agent-session-generation-conflict"; runId: string; scopeDigest: string; message: string }
  | { type: "agent-session-settlement-authority-mismatch"; runId: string; agentSessionId: string; attemptId: string; message: string }
  | { type: "retry-neutralization-mismatch"; runId: string; expectedAgentSessionIds: string[]; actualAgentSessionIds: string[]; message: string }
  | { type: "shared-session-retry-requires-fork"; runId: string; target: string; message: string }
  | { type: "deadline-out-of-range"; runId: string; nodeKey: string; message: string };

export type WriteExecutionMetadataInput = {
  runId: string;
  attemptId: string;
  ownerEpoch: number;
  kind: string;
  metadata: JsonValue;
};

export class SchedulerStoreException extends Error {
  constructor(readonly failure: SchedulerStoreError) {
    super(failure.message);
  }
}

export function schedulerStoreError(error: unknown): SchedulerStoreError | undefined {
  return error instanceof SchedulerStoreException ? error.failure : undefined;
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
  replayIdentity?: ReplayIdentity;
  sessionGroupDigest?: string;
};

export type ReplayCandidate = {
  nodeKey: string;
  sourceSequence: number;
  sessionGroupDigest?: string;
};

export type ReplayCommitInput = {
  runId: string;
  nodeKey: string;
  ownerEpoch: number;
  expectedVersion: number;
  replayIdentity?: ReplayIdentity;
  expectedSessionGroupDigest?: string;
};

export type ReplayCommitResult =
  | { disposition: "replayed"; snapshot: SchedulerSnapshot }
  | { disposition: "mismatch"; snapshot: SchedulerSnapshot; invalidatedNodeKeys: string[] };

export type AttemptStartResult = {
  attemptId: string;
  attemptNo: number;
  snapshot: SchedulerSnapshot;
  disposition: "started" | "existing";
  invalidatedSessionGroupDigest?: string;
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

export type SchedulerRetryPlan = Readonly<{
  snapshot: SchedulerSnapshot;
  requestedTarget: string;
  resolvedTarget: string;
  duplicate: boolean;
  sessions: readonly Readonly<{ runId: string; agentSessionId: string }>[];
}>;

export type SchedulerRetryCommitInput = SchedulerRetryInput & Readonly<{
  expectedVersion: number;
  neutralizedAgentSessionIds: readonly string[];
}>;

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
  proof?: SchedulerSteerProof;
};

export type SchedulerSteerProof = Readonly<{
  agentSessionId: string;
  attemptId: string;
  turnId: string;
  sessionLeaseId: string;
}>;

export type SchedulerSteerTarget = Readonly<{
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
}>;

export type SchedulerSteerResult = {
  snapshot: SchedulerSnapshot;
  steerId: string;
  requestedTarget: string;
  target: string;
  fencedAttemptId: string;
  fenceEventSequence: number;
  fencedAt: string;
};

export type AgentSessionCheckpointTransitionCause =
  | "begin_repair"
  | "local_call_pending"
  | "provider_activity"
  | "provider_terminal"
  | "loss_without_new_provider_evidence"
  | "inbound_local_failure";

export type BindAgentAttemptSessionInput = Readonly<{
  runId: string;
  attemptId: string;
  ownerEpoch: number;
  agentSessionId: string;
  scopeDigest: Sha256Digest;
  generation: number;
  explicitShared: boolean;
  operation: "start" | "continue" | "safe_retry";
  sessionOpenMode: "new_or_empty" | "existing_required";
  predecessorAttemptId?: string;
  steerEventSequence?: number;
  promptOrigin: AgentPromptOrigin;
  inputDigest: Sha256Digest;
  admittedFromCheckpoint?: AgentSessionCheckpoint;
  now?: Date;
}>;

export type AdvanceAgentSessionCheckpointInput = Readonly<{
  runId: string;
  ownerEpoch: number;
  agentSessionId: string;
  attemptId: string;
  expected: AgentSessionCheckpointValue;
  next: AgentSessionCheckpointValue;
  cause: AgentSessionCheckpointTransitionCause;
  now?: Date;
}>;

export type RecordAgentSessionReadyInput = Readonly<{
  runId: string;
  attemptId: string;
  ownerEpoch: number;
  agentSessionId: string;
  reportedVersion?: string;
  now?: Date;
}>;

export type CommitAgentTurnDispatchInput = Readonly<{
  runId: string;
  ownerEpoch: number;
  agentSessionId: string;
  attemptId: string;
  turnId: string;
  sessionLeaseId: string;
  expected: Extract<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>;
  invocationMetadata: JsonValue;
  now?: Date;
}>;

export type SettleFencedAgentSessionCheckpointInput = Readonly<{
  runId: string;
  runtimeOwnerEpoch: number;
  agentSessionId: string;
  attemptId: string;
  turnId: string;
  sessionLeaseId: string;
  expected: AgentSessionCheckpoint;
  next: "provider_observed" | "terminal_observed" | "acceptance_unknown" | "terminal_unknown";
  cause: Extract<
    AgentSessionCheckpointTransitionCause,
    "provider_activity" | "provider_terminal" | "loss_without_new_provider_evidence" | "inbound_local_failure"
  >;
  observedAt: Date;
}>;

export type ReconcileAgentSteersInput = Readonly<{
  runId: string;
  runtimeOwnerEpoch: number;
  now?: Date;
}>;

export type RuntimeAgentSessionInspection = Readonly<{
  scope: "node" | "shared";
  agentSessionId: string;
  generation: number;
  lifecycle: "active" | "abandoned";
  reportedVersion?: string;
  ownershipHealth?: "healthy" | "quarantined" | "unverified";
  currentBinding: Readonly<{
    attemptId: string;
    operation: "start" | "continue" | "safe_retry";
    promptOrigin: AgentPromptOrigin;
  }>;
  checkpoint: Readonly<{
    value: AgentSessionCheckpoint;
    attemptId: string;
    turnId?: string;
    promptOrigin: AgentPromptOrigin;
  }>;
}>;

export type RuntimeAgentControlInspection = Readonly<{
  agentSessions: readonly RuntimeAgentSessionInspection[];
  steers: readonly Readonly<{ nodeKey: string; projection: RuntimeSteerProjection }>[];
  turnProofs: readonly Readonly<{
    runId: string;
    nodeKey: string;
    agentSessionId: string;
    attemptId: string;
    turnId: string;
    sessionLeaseId: string;
  }>[];
}>;

export type AgentAttemptSessionBinding = Readonly<{
  attemptId: string;
  runId: string;
  agentSessionId: string;
  operation: "start" | "continue" | "safe_retry";
  sessionOpenMode: "new_or_empty" | "existing_required";
  predecessorAttemptId?: string;
  steerEventSequence?: number;
  initialPromptOrigin: AgentPromptOrigin;
  inputDigest: Sha256Digest;
  admittedFromCheckpoint?: AgentSessionCheckpoint;
}>;

export type PlanAgentAttemptAdmissionInput = Readonly<{
  runId: string;
  attemptId: string;
  ownerEpoch: number;
  target: string;
  scopeDigest: Sha256Digest;
  explicitShared: boolean;
  authored: Readonly<{ promptOrigin: "authored"; inputDigest: Sha256Digest }>;
  steering?: Readonly<{
    steerId: string;
    instruction: string;
    promptOrigin: "steering";
    inputDigest: Sha256Digest;
  }>;
}>;

export type SchedulerStorePort = {
  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined;
  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean;
  releaseRun(claim: RunOwnerClaim): boolean;
  tryLoadRunSnapshot(runId: string): SchedulerSnapshot;
  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot;
  tryStartAttempt(input: AttemptStartInput): AttemptStartResult;
  listReplayCandidates(runId: string): ReplayCandidate[];
  tryCommitReplay(input: ReplayCommitInput): ReplayCommitResult;
  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot;
  tryConsumeSignal(input: SignalConsumeInput): SchedulerSnapshot;
  tryPauseRun(input: SchedulerPauseInput): SchedulerSnapshot;
  tryResumeRun(input: SchedulerResumeInput): SchedulerSnapshot;
  tryPlanRetry(input: Omit<SchedulerRetryInput, "ownerEpoch">): SchedulerRetryPlan;
  tryCommitRetry(input: SchedulerRetryCommitInput): SchedulerSnapshot;
  tryCancel(input: SchedulerCancelInput): SchedulerSnapshot;
  tryPlanAgentSteer(runId: string, target: string): SchedulerSteerTarget;
  trySteerAgent(input: SchedulerSteerInput): SchedulerSteerResult;
  planAgentAttemptAdmission(input: PlanAgentAttemptAdmissionInput): Result.Result<AgentAttemptOperationPlan, AgentOperationPlanError>;
  tryBindAgentAttemptSession(input: BindAgentAttemptSessionInput): AgentAttemptSessionBinding;
  tryRecordAgentSessionReady(input: RecordAgentSessionReadyInput): void;
  tryAdvanceAgentSessionCheckpoint(input: AdvanceAgentSessionCheckpointInput): AgentSessionCheckpointValue;
  tryCommitAgentTurnDispatch(input: CommitAgentTurnDispatchInput): AgentSessionCheckpointValue;
  trySettleFencedAgentSessionCheckpoint(input: SettleFencedAgentSessionCheckpointInput): AgentSessionCheckpointValue;
  tryReconcileAgentSteers(input: ReconcileAgentSteersInput): number;
  readAgentControlInspection(runId: string): RuntimeAgentControlInspection;
  tryMarkExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerSnapshot;
};
