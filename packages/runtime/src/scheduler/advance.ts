import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { ok, type Result } from "neverthrow";
import { tryNormalizeWorkflowData } from "../evaluation/admissible.js";
import { selectNextAdmission } from "./admission.js";
import type { SchedulerEvent } from "./events.js";
import {
  throwSchedulerStoreResult,
  type AttemptCommitInput,
  type RunOwnerClaim,
  type SchedulerSnapshot,
  type SchedulerStoreError,
  type SchedulerStorePort,
  type SchedulerStoreResult,
} from "./store-port.js";
import { nextSchedulerTransitionEvents } from "./settle.js";
import type { NodeInstance, SchedulerProjection } from "./types.js";
import { createVersionedWakeup, type VersionedWakeup } from "./wakeup.js";
import type { ReplayEvaluation } from "./fork-replay.js";

export type NodeAttemptContext = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
  deadlineAt?: string;
  attemptStartReason?: "control_retry" | "pause_resume";
  steer?: { steerId: string; instruction: string };
  signal: AbortSignal;
};

export type NodeExecutor = {
  execute(context: NodeAttemptContext): Promise<AttemptCommitInput["result"]>;
};

type AttemptDeadlineFailure = { status: "failed"; reason: string; error?: JsonObject };

export type SchedulerExecutionStore = Pick<
  SchedulerStorePort,
  | "claimRun"
  | "heartbeatRun"
  | "releaseRun"
  | "tryLoadRunSnapshot"
  | "tryAppendSchedulerEvents"
  | "tryStartAttempt"
  | "tryCommitAttemptResult"
  | "tryMarkExpiredOwnerAttemptsSuperseded"
>;

export type AdvanceRunInput = {
  runId: string;
  ownerId: string;
  store: SchedulerExecutionStore;
  executor: NodeExecutor;
  leaseMs?: number;
  maxLeafConcurrency?: number;
  signalNodeIds?: ReadonlySet<string>;
  executorResourceFor?: (instance: NodeInstance, projection: SchedulerProjection) => string | undefined;
  replayEvaluationFor?: (instance: NodeInstance, projection: SchedulerProjection) => ReplayEvaluation;
  replayCandidates?: ReturnType<SchedulerStorePort["listReplayCandidates"]>;
  tryCommitReplay?: SchedulerStorePort["tryCommitReplay"];
  deadlineAtFor?: (instance: NodeInstance, projection: SchedulerProjection, now: Date) => Result<Date | undefined, AttemptDeadlineFailure>;
  awaitableEventsFor?: (instance: NodeInstance, projection: SchedulerProjection, now: Date) => SchedulerEvent[];
  bootstrap?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  wakeup?: VersionedWakeup;
  shouldStop?: () => boolean;
  onClaim?: (claim: RunOwnerClaim) => void;
  onRelease?: (claim: RunOwnerClaim) => void;
  onCheckpoint?: (snapshot: SchedulerSnapshot) => void;
  afterOwnershipRecovery?: () => Promise<void>;
  now?: () => Date;
};

type ActiveAttempt = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
  controller: AbortController;
};

export type AdvanceRunSummary = {
  status: "completed" | "failed" | "canceled" | "paused" | "awaiting" | "idle" | "lease_lost";
  runId: string;
  ownerEpoch?: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
};

type Counters = {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
};

type ActiveExecution = {
  attempt: ActiveAttempt;
  instance: NodeInstance;
  executorResource?: string;
  settlement?: Promise<void>;
  outcome?: ActiveExecutionOutcome;
};

type ActiveExecutionOutcome =
  | { type: "result"; value: AttemptCommitInput["result"] }
  | { type: "rejection"; error: unknown };

type SchedulerStepResult =
  | { status: "quiescent"; snapshot: SchedulerSnapshot }
  | { status: "lease_lost"; snapshot: SchedulerSnapshot };

type DerivedTransitionDrainResult = SchedulerStepResult
  | { status: "stopped"; snapshot: SchedulerSnapshot };

const DEFAULT_LEASE_MS = 30_000;
const UNCOORDINATED_CONTROL_POLL_MS = 250;
const COOPERATIVE_YIELD_QUANTUM = 256;
export const DEFAULT_MAX_LEAF_CONCURRENCY = 32;

export async function advanceRun(input: AdvanceRunInput): Promise<AdvanceRunSummary> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const claim = input.store.claimRun(input.runId, input.ownerId, leaseMs);
  if (!claim) return summary(input.runId, "lease_lost");

  const wakeup = input.wakeup ?? createVersionedWakeup();
  const coordinatedWakeup = input.wakeup !== undefined;
  const now = input.now ?? (() => new Date());
  const counters: Counters = { started: 0, completed: 0, failed: 0, cancelled: 0 };
  const replayCandidates = new Map((input.replayCandidates ?? []).map(candidate => [candidate.nodeKey, candidate]));
  const active = new Map<string, ActiveExecution>();
  const settledAttemptIds: string[] = [];
  let leaseLost = false;
  let executionFailed = false;
  let executionFailure: unknown;
  const stopHeartbeat = startRunHeartbeat(input.store, claim, leaseMs, active, () => {
    leaseLost = true;
    wakeup.wake();
  });

  try {
    safeObserver(() => input.onClaim?.(claim));
    const bootstrap = appendBootstrapEvents(input, claim);
    if (bootstrap === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);

    let drained = await drainDerivedTransitions(input, claim, leaseMs, now);
    if (drained.status === "stopped") {
      await stopLocalExecutions(active);
      return withCounters(summary(input.runId, "lease_lost"), claim, counters);
    }
    if (drained.status === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);
    checkpoint(input, drained.snapshot);
    let recovered = await recoverExpiredOwnerAttempts(input, claim, drained.snapshot);
    if (recovered.status === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);
    await input.afterOwnershipRecovery?.();

    let pumpTurns = 0;
    for (;;) {
      if (leaseLost) {
        abortAll(active);
        return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      }
      if (input.shouldStop?.()) {
        await stopLocalExecutions(active);
        return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      }
      pumpTurns += 1;
      if (pumpTurns % COOPERATIVE_YIELD_QUANTUM === 0) {
        if (!input.store.heartbeatRun(claim, leaseMs)) {
          leaseLost = true;
          continue;
        }
        await yieldToEventLoop();
        continue;
      }
      const observedWakeVersion = wakeup.current();

      drained = await drainDerivedTransitions(input, claim, leaseMs, now);
      if (drained.status === "stopped") {
        await stopLocalExecutions(active);
        return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      }
      if (drained.status === "lease_lost") {
        leaseLost = true;
        continue;
      }
      let snapshot = drained.snapshot;
      checkpoint(input, snapshot);
      if (input.shouldStop?.()) {
        await stopLocalExecutions(active);
        return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      }
      abortDurablyInterruptedExecutions(snapshot.projection, active);

      const settledAttemptId = settledAttemptIds.shift();
      if (settledAttemptId !== undefined) {
        const execution = active.get(settledAttemptId);
        if (!execution?.outcome) continue;
        if (execution.outcome.type === "rejection") {
          active.delete(settledAttemptId);
          throw execution.outcome.error;
        }
        const commit = commitExecutionResult(input, claim, execution, counters);
        active.delete(settledAttemptId);
        if (commit.status === "lease_lost") {
          leaseLost = true;
          continue;
        }
        snapshot = commit.snapshot;
        checkpoint(input, snapshot);
        continue;
      }

      const terminal = terminalSummary(snapshot.projection, claim);
      if (terminal) {
        abortAll(active);
        if (active.size > 0) {
          await waitForPump({ wakeup, observedWakeVersion, active, projection: snapshot.projection, now, coordinatedWakeup });
          continue;
        }
        if (wakeup.current() !== observedWakeVersion) continue;
        return withCounters(terminal, claim, counters);
      }

      const replay = replayReadyInstance(input, claim, snapshot, replayCandidates);
      if (replay === "lease_lost") {
        leaseLost = true;
        continue;
      }
      if (replay) {
        counters.completed += 1;
        checkpoint(input, replay);
        continue;
      }

      const admission = selectNextAdmission({
        projection: snapshot.projection,
        maxLeafConcurrency: input.maxLeafConcurrency ?? DEFAULT_MAX_LEAF_CONCURRENCY,
        ownerLocalUnsettled: unresolvedExecutionCount(active),
        ownerLocalUnsettledExecutorResources: unsettledExecutorResources(active),
        ...(input.executorResourceFor === undefined
          ? {}
          : { executorResourceFor: instance => input.executorResourceFor!(instance, snapshot.projection) }),
        signalNodeIds: input.signalNodeIds ?? new Set(),
      });
      if (admission?.kind === "signal") {
        const replayIdentity = input.replayEvaluationFor?.(admission.instance, snapshot.projection).replayIdentity;
        const events = (input.awaitableEventsFor?.(admission.instance, snapshot.projection, now()) ?? []).map(event =>
          event.type === "instance.awaiting" && replayIdentity !== undefined
            ? { ...event, payload: { ...event.payload, replayIdentity } }
            : event
        );
        if (events.length === 0) throw new Error(`Signal instance '${admission.instance.nodeKey}' produced no awaiting transition.`);
        const appended = input.store.tryAppendSchedulerEvents({
          runId: input.runId,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: `scheduler:await:${input.runId}:${admission.instance.nodeKey}:${snapshot.version}`,
          events,
        });
        if (appended.isErr()) {
          if (isVersionMismatchError(appended.error)) continue;
          if (isLeaseLostError(appended.error)) {
            leaseLost = true;
            continue;
          }
          unwrapStoreResult(appended);
        } else {
          checkpoint(input, appended.value);
        }
        continue;
      }

      if (admission?.kind === "executor") {
        const replay = input.replayEvaluationFor?.(admission.instance, snapshot.projection);
        const replayIdentity = replay?.replayIdentity;
        const deadline = input.deadlineAtFor?.(admission.instance, snapshot.projection, now()) ?? ok(undefined);
        const deadlineAt = deadline.isOk() ? deadline.value?.toISOString() : undefined;
        const executorResource = input.executorResourceFor?.(admission.instance, snapshot.projection);
        const started = input.store.tryStartAttempt({
          runId: input.runId,
          nodeKey: admission.instance.nodeKey,
          nodeId: admission.instance.nodeId,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: snapshot.version,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          ...(replayIdentity === undefined ? {} : { replayIdentity }),
          ...(replay?.sessionGroupDigest === undefined ? {} : { sessionGroupDigest: replay.sessionGroupDigest }),
          idempotencyKey: `scheduler:start:${input.runId}:${admission.instance.nodeKey}:${snapshot.version}`,
        });
        if (started.isErr()) {
          if (isVersionMismatchError(started.error) || isInstanceNotReadyError(started.error) || isPausedError(started.error)) continue;
          if (isLeaseLostError(started.error)) {
            leaseLost = true;
            continue;
          }
          unwrapStoreResult(started);
        } else {
          if (started.value.invalidatedSessionGroupDigest !== undefined) {
            for (const [nodeKey, candidate] of replayCandidates) {
              if (candidate.sessionGroupDigest === started.value.invalidatedSessionGroupDigest) replayCandidates.delete(nodeKey);
            }
          }
          if (started.value.disposition === "existing") continue;
          counters.started += 1;
          if (deadline.isErr()) {
            const committed = commitImmediateResult(input, claim, started.value.attemptId, deadline.error, counters);
            if (committed.status === "lease_lost") leaseLost = true;
            else checkpoint(input, committed.snapshot);
            continue;
          }
          launchExecution({
            input,
            claim,
            instance: admission.instance,
            attemptId: started.value.attemptId,
            attemptNo: started.value.attemptNo,
            deadlineAt,
            ...(started.value.steer === undefined ? {} : { steer: started.value.steer }),
            ...(executorResource === undefined ? {} : { executorResource }),
            active,
            settledAttemptIds,
            wakeup,
          });
        }
        continue;
      }

      if (active.size > 0) {
        await waitForPump({ wakeup, observedWakeVersion, active, projection: snapshot.projection, now, coordinatedWakeup });
        continue;
      }

      if (wakeup.current() !== observedWakeVersion) continue;
      const idle = idleSummary(snapshot.projection, claim);
      return withCounters(idle, claim, counters);
    }
  } catch (error) {
    executionFailed = true;
    executionFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      if (leaseLost) abortAll(active);
      else await stopLocalExecutions(active);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      stopHeartbeat();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      input.store.releaseRun(claim);
    } catch (error) {
      cleanupFailures.push(error);
    }
    safeObserver(() => input.onRelease?.(claim));
    if (cleanupFailures.length > 0) {
      const failures = executionFailed ? [executionFailure, ...cleanupFailures] : cleanupFailures;
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, executionFailed
        ? `Run '${input.runId}' execution and cleanup both failed.`
        : `Run '${input.runId}' cleanup failed.`);
    }
  }
}

function replayReadyInstance(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  snapshot: SchedulerSnapshot,
  candidates: Map<string, NonNullable<AdvanceRunInput["replayCandidates"]>[number]>,
): SchedulerSnapshot | "lease_lost" | undefined {
  if (!input.replayEvaluationFor || !input.tryCommitReplay) return undefined;
  const firstByGroup = new Map<string, NonNullable<AdvanceRunInput["replayCandidates"]>[number]>();
  for (const candidate of candidates.values()) {
    if (candidate.sessionGroupDigest === undefined) continue;
    const first = firstByGroup.get(candidate.sessionGroupDigest);
    if (!first
      || candidate.sourceSequence < first.sourceSequence
      || (candidate.sourceSequence === first.sourceSequence && candidate.nodeKey.localeCompare(first.nodeKey) < 0)) {
      firstByGroup.set(candidate.sessionGroupDigest, candidate);
    }
  }
  for (const candidate of candidates.values()) {
    if (candidate.sessionGroupDigest !== undefined
      && firstByGroup.get(candidate.sessionGroupDigest)?.nodeKey !== candidate.nodeKey) continue;
    const instance = snapshot.projection.instances[candidate.nodeKey];
    if (instance?.status !== "ready") continue;
    const replayIdentity = input.replayEvaluationFor(instance, snapshot.projection).replayIdentity;
    const replayed = input.tryCommitReplay({
      runId: input.runId,
      nodeKey: instance.nodeKey,
      ownerEpoch: claim.ownerEpoch,
      expectedVersion: snapshot.version,
      ...(replayIdentity === undefined ? {} : { replayIdentity }),
      ...(candidate.sessionGroupDigest === undefined ? {} : { expectedSessionGroupDigest: candidate.sessionGroupDigest }),
    });
    if (replayed.isErr()) {
      if (isVersionMismatchError(replayed.error) || isInstanceNotReadyError(replayed.error) || isPausedError(replayed.error)) return undefined;
      if (isLeaseLostError(replayed.error)) return "lease_lost";
      unwrapStoreResult(replayed);
      continue;
    }
    if (replayed.value.disposition === "replayed") {
      candidates.delete(candidate.nodeKey);
      return replayed.value.snapshot;
    }
    for (const nodeKey of replayed.value.invalidatedNodeKeys) candidates.delete(nodeKey);
  }
  return undefined;
}

function appendBootstrapEvents(input: AdvanceRunInput, claim: RunOwnerClaim): "appended" | "quiescent" | "lease_lost" {
  if (!input.bootstrap) return "quiescent";
  for (;;) {
    const snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
    const events = input.bootstrap(snapshot);
    if (events.length === 0) return "quiescent";
    const appended = input.store.tryAppendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `scheduler:bootstrap:${input.runId}:${snapshot.version}`,
      events,
    });
    if (appended.isOk()) {
      checkpoint(input, appended.value);
      return "appended";
    }
    if (isLeaseLostError(appended.error)) return "lease_lost";
    if (!isVersionMismatchError(appended.error)) unwrapStoreResult(appended);
  }
}

async function recoverExpiredOwnerAttempts(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  initial: SchedulerSnapshot,
): Promise<SchedulerStepResult> {
  let snapshot = initial;
  for (;;) {
    const expiredOwnerEpoch = Object.values(snapshot.projection.attempts)
      .find(attempt => attempt.status === "started" && attempt.ownerEpoch !== claim.ownerEpoch)?.ownerEpoch;
    if (expiredOwnerEpoch === undefined) return { status: "quiescent", snapshot };
    const superseded = input.store.tryMarkExpiredOwnerAttemptsSuperseded({
      runId: input.runId,
      currentOwnerEpoch: claim.ownerEpoch,
      expiredOwnerEpoch,
      expectedVersion: snapshot.version,
    });
    if (superseded.isOk()) {
      snapshot = superseded.value;
      checkpoint(input, snapshot);
      continue;
    }
    if (isLeaseLostError(superseded.error)) return { status: "lease_lost", snapshot };
    if (isVersionMismatchError(superseded.error)) {
      snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
      continue;
    }
    snapshot = unwrapStoreResult(superseded);
  }
}

async function drainDerivedTransitions(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  leaseMs: number,
  now: () => Date,
): Promise<DerivedTransitionDrainResult> {
  let snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
  let progressedBatches = 0;
  for (;;) {
    if (input.shouldStop?.()) return { status: "stopped", snapshot };
    const events = nextSchedulerTransitionEvents(
      snapshot.projection,
      () => input.materialize?.(snapshot) ?? [],
      now(),
    );
    if (events.length === 0) return { status: "quiescent", snapshot };
    if (!input.store.heartbeatRun(claim, leaseMs)) return { status: "lease_lost", snapshot };

    const beforeVersion = snapshot.version;
    const appended = input.store.tryAppendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `scheduler:derived:${input.runId}:${snapshot.version}`,
      events,
    });
    if (appended.isErr()) {
      if (isLeaseLostError(appended.error)) return { status: "lease_lost", snapshot };
      if (isVersionMismatchError(appended.error)) {
        snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
        continue;
      }
      snapshot = unwrapStoreResult(appended);
    } else {
      snapshot = appended.value;
      if (snapshot.version <= beforeVersion) throw new Error(`Run '${input.runId}' appended derived transitions without advancing its durable version.`);
      checkpoint(input, snapshot);
    }

    progressedBatches += 1;
    if (progressedBatches % COOPERATIVE_YIELD_QUANTUM === 0) {
      if (!input.store.heartbeatRun(claim, leaseMs)) return { status: "lease_lost", snapshot };
      await yieldToEventLoop();
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function launchExecution(input: {
  input: AdvanceRunInput;
  claim: RunOwnerClaim;
  instance: NodeInstance;
  attemptId: string;
  attemptNo: number;
  deadlineAt: string | undefined;
  steer?: { steerId: string; instruction: string };
  executorResource?: string;
  active: Map<string, ActiveExecution>;
  settledAttemptIds: string[];
  wakeup: VersionedWakeup;
}): void {
  const controller = new AbortController();
  const attempt: ActiveAttempt = {
    runId: input.input.runId,
    nodeKey: input.instance.nodeKey,
    nodeId: input.instance.nodeId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    ownerEpoch: input.claim.ownerEpoch,
    controller,
  };
  const execution: ActiveExecution = {
    attempt,
    instance: input.instance,
    ...(input.executorResource === undefined ? {} : { executorResource: input.executorResource }),
  };
  input.active.set(input.attemptId, execution);
  const startReason = attemptStartReason(input.instance);
  execution.settlement = Promise.resolve()
    .then(() => input.input.executor.execute({
      runId: input.input.runId,
      nodeKey: input.instance.nodeKey,
      nodeId: input.instance.nodeId,
      attemptId: input.attemptId,
      attemptNo: input.attemptNo,
      ownerEpoch: input.claim.ownerEpoch,
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(startReason === undefined ? {} : { attemptStartReason: startReason }),
      ...(input.steer === undefined ? {} : { steer: input.steer }),
      signal: controller.signal,
    }))
    .then(
      result => {
        execution.outcome = { type: "result", value: result };
      },
      error => {
        execution.outcome = { type: "rejection", error };
      },
    )
    .finally(() => {
      input.settledAttemptIds.push(input.attemptId);
      input.wakeup.wake();
    });
}

function commitExecutionResult(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  execution: ActiveExecution,
  counters: Counters,
): SchedulerStepResult {
  if (execution.outcome?.type !== "result") throw new Error(`Attempt '${execution.attempt.attemptId}' has no committable executor result.`);
  let result = execution.outcome.value;
  if (result.status === "completed" && result.output !== undefined) {
    const normalized = tryNormalizeWorkflowData(result.output, `Node '${execution.instance.nodeId}' output`);
    result = normalized.isErr()
      ? { status: "failed", reason: normalized.error.message }
      : { ...result, output: normalized.value as JsonValue };
  }
  return commitImmediateResult(input, claim, execution.attempt.attemptId, result, counters);
}

function commitImmediateResult(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  attemptId: string,
  result: AttemptCommitInput["result"],
  counters: Counters,
): SchedulerStepResult {
  const committed = input.store.tryCommitAttemptResult({
    runId: input.runId,
    attemptId,
    ownerEpoch: claim.ownerEpoch,
    result,
    idempotencyKey: `scheduler:commit:${input.runId}:${attemptId}`,
  });
  if (committed.isErr()) {
    if (isLeaseLostError(committed.error)) {
      return { status: "lease_lost", snapshot: unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId)) };
    }
    const staleTerminal = staleTerminalStatus(committed.error);
    if (staleTerminal) {
      if (staleTerminal === "failed") counters.failed += 1;
      else counters.cancelled += 1;
      return { status: "quiescent", snapshot: unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId)) };
    }
    return { status: "quiescent", snapshot: unwrapStoreResult(committed) };
  }
  if (result.status === "completed") counters.completed += 1;
  else if (result.status === "cancelled") counters.cancelled += 1;
  else counters.failed += 1;
  return { status: "quiescent", snapshot: committed.value };
}

async function waitForPump(input: {
  wakeup: VersionedWakeup;
  observedWakeVersion: number;
  active: ReadonlyMap<string, ActiveExecution>;
  projection: SchedulerProjection;
  now: () => Date;
  coordinatedWakeup: boolean;
}): Promise<void> {
  const waits: Promise<unknown>[] = [input.wakeup.waitForChange(input.observedWakeVersion)];
  for (const execution of input.active.values()) {
    if (execution.outcome === undefined && execution.settlement) waits.push(execution.settlement);
  }

  const nearestDeadline = nearestWakeDeadline(input.projection, input.active);
  const deadlineDelay = nearestDeadline === undefined ? undefined : Math.max(0, nearestDeadline - input.now().getTime());
  const fallbackDelay = input.coordinatedWakeup ? undefined : UNCOORDINATED_CONTROL_POLL_MS;
  const delay = minimumDefined(deadlineDelay, fallbackDelay);
  let timer: NodeJS.Timeout | undefined;
  if (delay !== undefined) {
    waits.push(new Promise<void>(resolve => {
      timer = setTimeout(resolve, Math.min(delay, 2_147_483_647));
      timer.unref?.();
    }));
  }
  try {
    await Promise.race(waits);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nearestWakeDeadline(projection: SchedulerProjection, active: ReadonlyMap<string, ActiveExecution>): number | undefined {
  let nearest: number | undefined;
  for (const attemptId of active.keys()) {
    const deadlineAt = projection.attempts[attemptId]?.deadlineAt;
    if (deadlineAt === undefined) continue;
    nearest = minimumTimestamp(nearest, deadlineAt, `Attempt '${attemptId}'`);
  }
  for (const wait of Object.values(projection.signalWaits)) {
    if (wait.status !== "awaiting" || wait.deadlineAt === undefined) continue;
    nearest = minimumTimestamp(nearest, wait.deadlineAt, `Signal wait '${wait.nodeKey}'`);
  }
  return nearest;
}

function minimumTimestamp(current: number | undefined, deadlineAt: string, subject: string): number {
  const value = Date.parse(deadlineAt);
  if (!Number.isFinite(value)) throw new Error(`${subject} has an invalid durable deadline.`);
  return current === undefined ? value : Math.min(current, value);
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function startRunHeartbeat(
  store: SchedulerExecutionStore,
  claim: RunOwnerClaim,
  leaseMs: number,
  active: ReadonlyMap<string, ActiveExecution>,
  onLeaseLost: () => void,
): () => void {
  const heartbeat = setInterval(() => {
    if (store.heartbeatRun(claim, leaseMs)) return;
    abortAll(active);
    onLeaseLost();
  }, heartbeatIntervalMs(leaseMs));
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

function heartbeatIntervalMs(leaseMs: number): number {
  return Math.max(1, Math.floor(leaseMs / 3));
}

function abortDurablyInterruptedExecutions(projection: SchedulerProjection, active: ReadonlyMap<string, ActiveExecution>): void {
  for (const [attemptId, execution] of active) {
    if (projection.attempts[attemptId]?.status !== "started") execution.attempt.controller.abort();
  }
}

function abortAll(active: ReadonlyMap<string, ActiveExecution>): void {
  for (const execution of active.values()) execution.attempt.controller.abort();
}

async function stopLocalExecutions(active: Map<string, ActiveExecution>): Promise<void> {
  abortAll(active);
  await Promise.all([...active.values()].flatMap(execution => execution.settlement ? [execution.settlement] : []));
  active.clear();
}

function unresolvedExecutionCount(active: ReadonlyMap<string, ActiveExecution>): number {
  let count = 0;
  for (const execution of active.values()) {
    if (execution.outcome === undefined) count += 1;
  }
  return count;
}

function unsettledExecutorResources(active: ReadonlyMap<string, ActiveExecution>): ReadonlySet<string> {
  const resources = new Set<string>();
  for (const execution of active.values()) {
    if (execution.outcome === undefined && execution.executorResource !== undefined) {
      resources.add(execution.executorResource);
    }
  }
  return resources;
}

function attemptStartReason(instance: NodeInstance): NodeAttemptContext["attemptStartReason"] | undefined {
  if (instance.statusReason === "retry") return "control_retry";
  if (instance.statusReason === "paused") return "pause_resume";
  return undefined;
}

function terminalSummary(projection: SchedulerProjection, claim: RunOwnerClaim): AdvanceRunSummary | undefined {
  if (projection.run.status !== "completed" && projection.run.status !== "failed" && projection.run.status !== "canceled" && projection.run.status !== "paused") return undefined;
  return {
    status: projection.run.status,
    runId: projection.run.runId,
    ownerEpoch: claim.ownerEpoch,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: activeAttemptCount(projection),
  };
}

function idleSummary(projection: SchedulerProjection, claim: RunOwnerClaim): AdvanceRunSummary {
  return {
    status: hasAwaitingWork(projection) ? "awaiting" : "idle",
    runId: projection.run.runId,
    ownerEpoch: claim.ownerEpoch,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: activeAttemptCount(projection),
  };
}

function summary(runId: string, status: AdvanceRunSummary["status"]): AdvanceRunSummary {
  return { status, runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 };
}

function withCounters(base: AdvanceRunSummary, claim: RunOwnerClaim, counters: Counters): AdvanceRunSummary {
  return { ...base, ownerEpoch: claim.ownerEpoch, ...counters };
}

function activeAttemptCount(projection: SchedulerProjection): number {
  return Object.values(projection.attempts).filter(attempt => attempt.status === "started").length;
}

function hasAwaitingWork(projection: SchedulerProjection): boolean {
  return Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
}

function checkpoint(input: AdvanceRunInput, snapshot: SchedulerSnapshot): void {
  safeObserver(() => input.onCheckpoint?.(snapshot));
}

function safeObserver(observer: () => void): void {
  try {
    observer();
  } catch {
    // Owner-local observers cannot alter durable scheduling outcomes.
  }
}

function unwrapStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}

function isLeaseLostError(error: SchedulerStoreError): boolean {
  return error.type === "owner-epoch-inactive" || error.type === "owner-epoch-stale";
}

function isPausedError(error: SchedulerStoreError): boolean {
  return error.type === "run-paused";
}

function isVersionMismatchError(error: SchedulerStoreError): boolean {
  return error.type === "version-mismatch";
}

function isInstanceNotReadyError(error: SchedulerStoreError): boolean {
  return error.type === "instance-not-ready";
}

function staleTerminalStatus(error: SchedulerStoreError): "cancelled" | "failed" | undefined {
  if (error.type !== "terminal-attempt") return undefined;
  if (error.status === "cancelled" || error.status === "superseded") return "cancelled";
  if (error.status === "timed_out" || error.status === "failed") return "failed";
  return undefined;
}
