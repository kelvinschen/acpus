import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeNodeProcessHost } from "@acpus/owned-process";
import type { JsonValue } from "@acpus/expression/ir";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../../src/configuration.js";
import type { HookRunner } from "../../src/hooks/runner.js";
import type { NodeProgressWriter } from "../../src/progress/writer.js";
import type { RuntimeStoreAdapter } from "../../src/store/store.js";
import { makeRuntimeStoreService } from "../../src/store/service.js";
import {
  applySchedulerControlIntent as applySchedulerControlIntentWithOwner,
  type RunControlIntent,
  type SchedulerControlEffect,
} from "../../src/scheduler/control.js";
import { advanceFrozenRun } from "../../src/scheduler/runtime-runner.js";
import type { SchedulerEvent } from "../../src/scheduler/events.js";
import type { AttemptCommitInput, SchedulerSnapshot } from "../../src/scheduler/store-port.js";
import type { AdvanceRunSummary } from "../../src/scheduler/advance.js";

export function completed(output?: JsonValue): AttemptCommitInput["result"] {
  return output === undefined ? { status: "completed" } : { status: "completed", output };
}

export function rootFrameStarted(runId: string, nodeId: string, nodeKey: string): SchedulerEvent {
  return {
    type: "frame.started",
    payload: {
      runId,
      frameKey: "root",
      frameKind: "root",
      scope: { [nodeId]: nodeKey },
    },
  };
}

type RuntimeAdvanceOptions = {
  maxLeafConcurrency?: number;
  agentHostPolicy?: AgentHostPolicy;
  hookRunner?: HookRunner;
  progressWriter?: NodeProgressWriter;
};

export async function advanceRuntimeRun(cwd: string, store: RuntimeStoreAdapter, runId: string, ownerId: string, options: RuntimeAdvanceOptions = {}): Promise<AdvanceRunSummary> {
  if (!store.getFrozenRun(runId)) throw new Error(`Run '${runId}' was not found.`);
  return Effect.runPromise(advanceFrozenRun({
    cwd,
    store,
    runId,
    ownerId,
    processes: makeNodeProcessHost(),
    ...(options.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: options.maxLeafConcurrency }),
    agentHostPolicy: options.agentHostPolicy ?? loadAgentHostPolicy(process.env),
    ...(options.hookRunner === undefined ? {} : { hookRunner: options.hookRunner }),
    ...(options.progressWriter === undefined ? {} : { progressWriter: options.progressWriter }),
  }));
}

export async function applySchedulerControlIntent(
  cwd: string,
  store: RuntimeStoreAdapter,
  intent: RunControlIntent,
  options: { ownerId?: string; advance?: boolean } = {},
): Promise<{ runId: string; snapshot: SchedulerSnapshot; effect: SchedulerControlEffect | undefined; reopened: boolean; advanced?: AdvanceRunSummary }> {
  const ownerId = options.ownerId ?? "scheduler-control-test";
  const claim = store.scheduler.claimRun(intent.runId, ownerId, 30_000);
  if (!claim) {
    return {
      runId: intent.runId,
      snapshot: store.scheduler.tryLoadRunSnapshot(intent.runId),
      effect: undefined,
      reopened: false,
      advanced: { status: "lease_lost", runId: intent.runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    };
  }

  let snapshot: SchedulerSnapshot;
  let effect: SchedulerControlEffect;
  let reopened: boolean;
  try {
    const applied = await Effect.runPromise(Effect.result(
      applySchedulerControlIntentWithOwner(makeRuntimeStoreService(store), intent, claim.ownerEpoch),
    ));
    if (Result.isFailure(applied)) throw Object.assign(new Error(applied.failure.message), { failure: applied.failure });
    ({ snapshot, effect, reopened } = applied.success);
  } finally {
    store.scheduler.releaseRun(claim);
  }

  if (intent.type === "pause" || options.advance === false) return { runId: intent.runId, snapshot, effect, reopened };
  const advanced = await Effect.runPromise(advanceFrozenRun({
    cwd,
    store,
    runId: intent.runId,
    ownerId,
    processes: makeNodeProcessHost(),
  }));
  return {
    runId: intent.runId,
    snapshot: store.scheduler.tryLoadRunSnapshot(intent.runId),
    effect,
    reopened,
    advanced,
  };
}
