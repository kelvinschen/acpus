import { ResultAsync } from "neverthrow";
import type { AdvanceRunSummary } from "../scheduler/advance.js";
import { advanceFrozenRun } from "../scheduler/runtime-runner.js";
import { schedulerStoreError, throwSchedulerStoreResult, type SchedulerStoreError, type SchedulerStoreResult } from "../scheduler/store-port.js";
import type { RunDetails, RuntimeStore } from "../store/store.js";

export type RuntimeAdvanceResult =
  | { status: "completed"; run: RunDetails; summary: AdvanceRunSummary }
  | { status: "failed"; run: RunDetails; message: string; summary: AdvanceRunSummary }
  | { status: "canceled"; run: RunDetails; summary: AdvanceRunSummary }
  | { status: "awaiting"; run: RunDetails; nodeKey: string; summary: AdvanceRunSummary }
  | { status: "paused" | "idle" | "lease_lost"; run: RunDetails; summary: AdvanceRunSummary };

export type RuntimeAdvanceError =
  | SchedulerStoreError
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "runtime-not-quiescent"; runId: string; drives: number; message: string };

export type RuntimeAdvanceObserver = (run: RunDetails, summary: AdvanceRunSummary) => void;

class RuntimeAdvanceException extends Error {
  constructor(readonly failure: RuntimeAdvanceError) {
    super(failure.message);
  }
}

export function tryAdvanceRuntimeRun(cwd: string, store: RuntimeStore, runId: string, ownerId = "runtime-public", observe?: RuntimeAdvanceObserver): ResultAsync<RuntimeAdvanceResult, RuntimeAdvanceError> {
  return ResultAsync.fromPromise(
    advanceRuntimeRun(cwd, store, runId, ownerId, observe),
    error => {
      const storeError = schedulerStoreError(error);
      if (storeError) return storeError;
      if (error instanceof RuntimeAdvanceException) return error.failure;
      throw error;
    },
  );
}

export async function advanceRuntimeRun(cwd: string, store: RuntimeStore, runId: string, ownerId = "runtime-public", observe?: RuntimeAdvanceObserver): Promise<RuntimeAdvanceResult> {
  if (!store.getFrozenRun(runId)) {
    throw new RuntimeAdvanceException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
  }
  let last: AdvanceRunSummary | undefined;
  for (let drives = 0; drives < 1_000; drives += 1) {
    last = await advanceFrozenRun({ cwd, store, runId, ownerId });
    const run = store.getRun(runId);
    if (run) observe?.(run, last);
    if (last.status === "idle" && madeProgress(last)) continue;
    if (last.status !== "idle" || !madeProgress(last)) return runtimeAdvanceResult(store, runId, last);
  }
  throw new RuntimeAdvanceException({ type: "runtime-not-quiescent", runId, drives: 1_000, message: `Run '${runId}' did not quiesce after 1000 scheduler drives.` });
}

export function runtimeAdvanceResult(store: RuntimeStore, runId: string, summary: AdvanceRunSummary): RuntimeAdvanceResult {
  const run = store.getRun(runId);
  if (!run) throw new RuntimeAdvanceException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
  if (summary.status === "completed") return { status: "completed", run, summary };
  if (summary.status === "failed") return { status: "failed", run, message: rootFailureMessage(store, runId), summary };
  if (summary.status === "canceled") return { status: "canceled", run, summary };
  if (summary.status === "awaiting") return { status: "awaiting", run, nodeKey: firstAwaitingNodeKey(store, runId), summary };
  return { status: summary.status, run, summary };
}

function madeProgress(summary: AdvanceRunSummary): boolean {
  return summary.started + summary.completed + summary.failed + summary.cancelled > 0;
}

function firstAwaitingNodeKey(store: RuntimeStore, runId: string): string {
  const projection = unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)).projection;
  return Object.values(projection.instances).find(instance => instance.status === "awaiting")?.nodeKey
    ?? Object.values(projection.signalWaits).find(wait => wait.status === "awaiting")?.nodeKey
    ?? "";
}

function rootFailureMessage(store: RuntimeStore, runId: string): string {
  const root = unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)).projection.frames.root;
  const error = root?.error;
  if (error && typeof error.message === "string") return error.message;
  if (error && typeof error.reason === "string") return error.reason;
  return root?.terminalReason ?? "scheduler_failed";
}

function unwrapStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}
