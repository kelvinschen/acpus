import {
  throwSchedulerStoreResult,
  type AttemptCommitInput,
  type AttemptStartInput,
  type SchedulerCancelInput,
  type SchedulerCommit,
  type SchedulerPauseInput,
  type SchedulerResumeInput,
  type SchedulerRetryInput,
  type SchedulerRunRetryInput,
  type SchedulerStorePort,
  type SignalConsumeInput,
} from "../../src/scheduler/store-port.js";

export function throwingSchedulerStore(store: SchedulerStorePort) {
  return {
    loadRunSnapshot: (runId: string) => throwSchedulerStoreResult(store.tryLoadRunSnapshot(runId)),
    appendSchedulerEvents: (input: SchedulerCommit) => throwSchedulerStoreResult(store.tryAppendSchedulerEvents(input)),
    startAttempt: (input: AttemptStartInput) => throwSchedulerStoreResult(store.tryStartAttempt(input)),
    commitAttemptResult: (input: AttemptCommitInput) => throwSchedulerStoreResult(store.tryCommitAttemptResult(input)),
    consumeSignal: (input: SignalConsumeInput) => throwSchedulerStoreResult(store.tryConsumeSignal(input)),
    pauseRun: (input: SchedulerPauseInput) => throwSchedulerStoreResult(store.tryPauseRun(input)),
    resumeRun: (input: SchedulerResumeInput) => throwSchedulerStoreResult(store.tryResumeRun(input)),
    retryRun: (input: SchedulerRunRetryInput) => throwSchedulerStoreResult(store.tryRetryRun(input)),
    retry: (input: SchedulerRetryInput) => throwSchedulerStoreResult(store.tryRetry(input)),
    cancel: (input: SchedulerCancelInput) => throwSchedulerStoreResult(store.tryCancel(input)),
    markExpiredOwnerAttemptsSuperseded: (runId: string, ownerEpoch: number) => throwSchedulerStoreResult(store.tryMarkExpiredOwnerAttemptsSuperseded(runId, ownerEpoch)),
  };
}
