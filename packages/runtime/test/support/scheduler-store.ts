import {
  throwSchedulerStoreResult,
  type AttemptCommitInput,
  type AttemptStartInput,
  type SchedulerCancelInput,
  type SchedulerCommit,
  type SchedulerPauseInput,
  type SchedulerResumeInput,
  type SchedulerRetryInput,
  type SchedulerSnapshot,
  type SchedulerStoreResult,
  type SchedulerRecoveryInput,
  type SchedulerSteerInput,
  type SchedulerStorePort,
  type SignalConsumeInput,
} from "../../src/scheduler/store-port.js";
import { err } from "neverthrow";

export function throwingSchedulerStore(store: SchedulerStorePort) {
  return {
    loadRunSnapshot: (runId: string) => throwSchedulerStoreResult(store.tryLoadRunSnapshot(runId)),
    appendSchedulerEvents: (input: SchedulerCommit) => throwSchedulerStoreResult(store.tryAppendSchedulerEvents(input)),
    startAttempt: (input: Omit<AttemptStartInput, "expectedVersion"> & { expectedVersion?: number }) => throwSchedulerStoreResult(store.tryStartAttempt({
      ...input,
      expectedVersion: input.expectedVersion ?? throwSchedulerStoreResult(store.tryLoadRunSnapshot(input.runId)).version,
    })),
    commitAttemptResult: (input: AttemptCommitInput) => throwSchedulerStoreResult(store.tryCommitAttemptResult(input)),
    consumeSignal: (input: SignalConsumeInput) => throwSchedulerStoreResult(store.tryConsumeSignal(input)),
    pauseRun: (input: SchedulerPauseInput) => throwSchedulerStoreResult(store.tryPauseRun(input)),
    resumeRun: (input: SchedulerResumeInput) => throwSchedulerStoreResult(store.tryResumeRun(input)),
    retry: (input: SchedulerRetryInput) => throwSchedulerStoreResult(tryRetryStore(store, input)),
    cancel: (input: SchedulerCancelInput) => throwSchedulerStoreResult(store.tryCancel(input)),
    steerAgent: (input: SchedulerSteerInput) => throwSchedulerStoreResult(store.trySteerAgent(input)),
    markExpiredOwnerAttemptsSuperseded: (input: SchedulerRecoveryInput) => throwSchedulerStoreResult(store.tryMarkExpiredOwnerAttemptsSuperseded(input)),
  };
}

export function tryRetryStore(
  store: SchedulerStorePort,
  input: SchedulerRetryInput,
): SchedulerStoreResult<SchedulerSnapshot> {
  const plan = store.tryPlanRetry({
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    target: input.target,
  });
  if (plan.isErr()) return err(plan.error);
  if (plan.value.duplicate) return store.tryLoadRunSnapshot(input.runId);
  return store.tryCommitRetry({
    ...input,
    expectedVersion: plan.value.snapshot.version,
    neutralizedAgentSessionIds: plan.value.sessions.map(session => session.agentSessionId),
  });
}
