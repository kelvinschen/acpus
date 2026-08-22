import * as Result from "effect/Result";
import {
  SchedulerStoreException,
  schedulerStoreError,
  type AttemptCommitInput,
  type AttemptStartInput,
  type SchedulerCancelInput,
  type SchedulerCommit,
  type SchedulerPauseInput,
  type SchedulerResumeInput,
  type SchedulerRetryInput,
  type SchedulerSnapshot,
  type SchedulerStoreError,
  type SchedulerRecoveryInput,
  type SchedulerSteerInput,
  type SchedulerStorePort,
  type SignalConsumeInput,
} from "../../src/scheduler/store-port.js";

export function throwingSchedulerStore(store: SchedulerStorePort) {
  return {
    loadRunSnapshot: (runId: string) => store.tryLoadRunSnapshot(runId),
    appendSchedulerEvents: (input: SchedulerCommit) => store.tryAppendSchedulerEvents(input),
    startAttempt: (input: Omit<AttemptStartInput, "expectedVersion"> & { expectedVersion?: number }) => store.tryStartAttempt({
      ...input,
      expectedVersion: input.expectedVersion ?? store.tryLoadRunSnapshot(input.runId).version,
    }),
    commitAttemptResult: (input: AttemptCommitInput) => store.tryCommitAttemptResult(input),
    consumeSignal: (input: SignalConsumeInput) => store.tryConsumeSignal(input),
    pauseRun: (input: SchedulerPauseInput) => store.tryPauseRun(input),
    resumeRun: (input: SchedulerResumeInput) => store.tryResumeRun(input),
    retry: (input: SchedulerRetryInput) => unwrap(tryRetryStore(store, input)),
    cancel: (input: SchedulerCancelInput) => store.tryCancel(input),
    steerAgent: (input: SchedulerSteerInput) => store.trySteerAgent(input),
    markExpiredOwnerAttemptsSuperseded: (input: SchedulerRecoveryInput) => store.tryMarkExpiredOwnerAttemptsSuperseded(input),
  };
}

export function tryRetryStore(
  store: SchedulerStorePort,
  input: SchedulerRetryInput,
): Result.Result<SchedulerSnapshot, SchedulerStoreError> {
  try {
    const plan = store.tryPlanRetry({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
    });
    if (plan.duplicate) return Result.succeed(store.tryLoadRunSnapshot(input.runId));
    return Result.succeed(store.tryCommitRetry({
      ...input,
      expectedVersion: plan.snapshot.version,
      neutralizedAgentSessionIds: plan.sessions.map(session => session.agentSessionId),
    }));
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (failure) return Result.fail(failure);
    throw error;
  }
}

export function captureSchedulerCall<Success>(operation: () => Success): Result.Result<Success, SchedulerStoreError> {
  try {
    return Result.succeed(operation());
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (failure) return Result.fail(failure);
    throw error;
  }
}

function unwrap<Success>(result: Result.Result<Success, SchedulerStoreError>): Success {
  if (Result.isFailure(result)) throw new SchedulerStoreException(result.failure);
  return result.success;
}
