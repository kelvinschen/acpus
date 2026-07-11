import type { JsonValue } from "@acpus/expression/ir";
import type { RuntimeStore } from "../../src/store/store.js";
import { applySchedulerControlIntent as applySchedulerControlIntentWithOwner, type RunControlIntent } from "../../src/scheduler/control.js";
import { advanceFrozenRun } from "../../src/scheduler/runtime-runner.js";
import { throwSchedulerStoreResult, type AttemptCommitInput, type SchedulerSnapshot } from "../../src/scheduler/store-port.js";
import type { AdvanceRunSummary } from "../../src/scheduler/advance.js";

export function completed(output?: JsonValue): AttemptCommitInput["result"] {
  return output === undefined ? { status: "completed" } : { status: "completed", output };
}

export async function applySchedulerControlIntent(
  cwd: string,
  store: RuntimeStore,
  intent: RunControlIntent,
  options: { ownerId?: string; advance?: boolean } = {},
): Promise<{ runId: string; snapshot: SchedulerSnapshot; advanced?: AdvanceRunSummary }> {
  const ownerId = options.ownerId ?? "scheduler-control-test";
  const claim = store.scheduler.claimRun(intent.runId, ownerId, 30_000);
  if (!claim) {
    return {
      runId: intent.runId,
      snapshot: throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(intent.runId)),
      advanced: { status: "lease_lost", runId: intent.runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    };
  }

  let snapshot: SchedulerSnapshot;
  try {
    snapshot = applySchedulerControlIntentWithOwner(store, intent, claim.ownerEpoch);
  } finally {
    store.scheduler.releaseRun(claim);
  }

  if (intent.type === "pause" || options.advance === false) return { runId: intent.runId, snapshot };
  const advanced = await advanceFrozenRun({ cwd, store, runId: intent.runId, ownerId });
  return {
    runId: intent.runId,
    snapshot: throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(intent.runId)),
    advanced,
  };
}
