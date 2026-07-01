import type { AdvanceRunSummary } from "../scheduler/advance.js";
import { advanceFrozenRun } from "../scheduler/runtime-runner.js";
import type { RunDetails, RuntimeStore } from "../store/store.js";

export type RuntimeAdvanceResult =
  | { status: "completed"; run: RunDetails; summary: AdvanceRunSummary }
  | { status: "failed"; run: RunDetails; message: string; summary: AdvanceRunSummary }
  | { status: "awaiting"; run: RunDetails; nodeKey: string; summary: AdvanceRunSummary }
  | { status: "paused" | "idle" | "lease_lost"; run: RunDetails; summary: AdvanceRunSummary };

export async function advanceRuntimeRun(cwd: string, store: RuntimeStore, runId: string, ownerId = "runtime-public"): Promise<RuntimeAdvanceResult> {
  let last: AdvanceRunSummary | undefined;
  for (let drives = 0; drives < 1_000; drives += 1) {
    last = await advanceFrozenRun({ cwd, store, runId, ownerId });
    if (last.status === "idle" && madeProgress(last)) continue;
    if (last.status !== "idle" || !madeProgress(last)) return runtimeAdvanceResult(store, runId, last);
  }
  throw new Error(`Run '${runId}' did not quiesce after 1000 scheduler drives.`);
}

export function hasSchedulerState(store: RuntimeStore, runId: string): boolean {
  const projection = store.scheduler.loadRunSnapshot(runId).projection;
  return projection.run.paused
    || projection.run.status !== "pending"
    || Object.keys(projection.frames).length > 0
    || Object.keys(projection.instances).length > 0
    || Object.keys(projection.attempts).length > 0
    || Object.keys(projection.groups).length > 0
    || Object.keys(projection.groupMembers).length > 0
    || Object.keys(projection.signalWaits).length > 0
    || Object.keys(projection.branchDecisions).length > 0;
}

export function runtimeAdvanceResult(store: RuntimeStore, runId: string, summary: AdvanceRunSummary): RuntimeAdvanceResult {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run '${runId}' was not found.`);
  if (summary.status === "completed") return { status: "completed", run, summary };
  if (summary.status === "failed") return { status: "failed", run, message: rootFailureMessage(store, runId), summary };
  if (summary.status === "awaiting") return { status: "awaiting", run, nodeKey: firstAwaitingNodeKey(store, runId), summary };
  return { status: summary.status, run, summary };
}

function madeProgress(summary: AdvanceRunSummary): boolean {
  return summary.started + summary.completed + summary.failed + summary.cancelled > 0;
}

function firstAwaitingNodeKey(store: RuntimeStore, runId: string): string {
  const projection = store.scheduler.loadRunSnapshot(runId).projection;
  return Object.values(projection.instances).find(instance => instance.status === "awaiting")?.nodeKey
    ?? Object.values(projection.signalWaits).find(wait => wait.status === "awaiting")?.nodeKey
    ?? "";
}

function rootFailureMessage(store: RuntimeStore, runId: string): string {
  const root = store.scheduler.loadRunSnapshot(runId).projection.frames.root;
  const error = root?.error;
  if (error && typeof error.message === "string") return error.message;
  if (error && typeof error.reason === "string") return error.reason;
  return root?.terminalReason ?? "scheduler_failed";
}
