import type { JsonValue } from "@acpus/expression/ir";
import type { RuntimeStore } from "../../src/store/store.js";
import {
  applySchedulerControlIntent as applySchedulerControlIntentWithOwner,
  type RunControlIntent,
  type SchedulerControlEffect,
} from "../../src/scheduler/control.js";
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
): Promise<{ runId: string; snapshot: SchedulerSnapshot; effect: SchedulerControlEffect | undefined; reopened: boolean; advanced?: AdvanceRunSummary }> {
  const ownerId = options.ownerId ?? "scheduler-control-test";
  const claim = store.scheduler.claimRun(intent.runId, ownerId, 30_000);
  if (!claim) {
    return {
      runId: intent.runId,
      snapshot: throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(intent.runId)),
      effect: undefined,
      reopened: false,
      advanced: { status: "lease_lost", runId: intent.runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    };
  }

  let snapshot: SchedulerSnapshot;
  let effect: SchedulerControlEffect;
  let reopened: boolean;
  try {
    ({ snapshot, effect, reopened } = applySchedulerControlIntentWithOwner(store, intent, claim.ownerEpoch));
  } finally {
    store.scheduler.releaseRun(claim);
  }

  if (intent.type === "pause" || options.advance === false) return { runId: intent.runId, snapshot, effect, reopened };
  const advanced = await advanceFrozenRun({ cwd, store, runId: intent.runId, ownerId });
  return {
    runId: intent.runId,
    snapshot: throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(intent.runId)),
    effect,
    reopened,
    advanced,
  };
}
