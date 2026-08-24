import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { tryNormalizeWorkflowData } from "../evaluation/admissible.js";
import { selectNextAdmission } from "./admission.js";
import type { SchedulerEvent } from "./events.js";
import {
  SchedulerStoreException,
  schedulerStoreError,
  type AttemptCommitInput,
  type RunOwnerClaim,
  type SchedulerSnapshot,
  type SchedulerStoreError,
  type SchedulerStorePort,
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
  interrupt?(reason: "steer"): void;
};

export type NodeExecutor = {
  execute(context: NodeAttemptContext): Effect.Effect<AttemptCommitInput["result"]>;
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
  deadlineAtFor?: (instance: NodeInstance, projection: SchedulerProjection, now: Date) => Result.Result<Date | undefined, AttemptDeadlineFailure>;
  awaitableEventsFor?: (instance: NodeInstance, projection: SchedulerProjection, now: Date) => SchedulerEvent[];
  bootstrap?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  wakeup?: VersionedWakeup;
  onClaim?: (claim: RunOwnerClaim) => void;
  onRelease?: (claim: RunOwnerClaim) => void;
  onCheckpoint?: (snapshot: SchedulerSnapshot) => Effect.Effect<void>;
  afterOwnershipRecovery?: () => Effect.Effect<void>;
};

type ActiveAttempt = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
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
  fiber: Fiber.Fiber<AttemptCommitInput["result"]>;
};

type SchedulerStepResult =
  | { status: "quiescent"; snapshot: SchedulerSnapshot }
  | { status: "lease_lost"; snapshot: SchedulerSnapshot };

const DEFAULT_LEASE_MS = 30_000;
const UNCOORDINATED_CONTROL_POLL_MS = 250;
const COOPERATIVE_YIELD_QUANTUM = 256;
export const DEFAULT_MAX_LEAF_CONCURRENCY = 32;

export function advanceRun(input: AdvanceRunInput): Effect.Effect<AdvanceRunSummary> {
  return Effect.suspend(() => {
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const claim = input.store.claimRun(input.runId, input.ownerId, leaseMs);
    if (!claim) return Effect.succeed(summary(input.runId, "lease_lost"));

    return Effect.acquireUseRelease(
      Effect.succeed(claim),
      () => Effect.scoped(Effect.gen(function* () {
      const attempts = yield* FiberSet.make<AttemptCommitInput["result"]>();
      const wakeup = input.wakeup ?? createVersionedWakeup();
      const coordinatedWakeup = input.wakeup !== undefined;
      const counters: Counters = { started: 0, completed: 0, failed: 0, cancelled: 0 };
      const replayCandidates = new Map((input.replayCandidates ?? []).map(candidate => [candidate.nodeKey, candidate]));
      const active = new Map<string, ActiveExecution>();
      let leaseLost = false;
      const onLeaseLost = () => {
        leaseLost = true;
        wakeup.wake();
      };

      const execution = Effect.gen(function* () {
      yield* startRunHeartbeat(input.store, claim, leaseMs, active, onLeaseLost);
      safeObserver(() => input.onClaim?.(claim));
      const bootstrap = yield* appendBootstrapEvents(input, claim);
      if (bootstrap === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);

      let drained = yield* drainDerivedTransitions(input, claim, leaseMs, () => leaseLost);
      if (drained.status === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      yield* checkpoint(input, drained.snapshot);
      const recovered = yield* recoverExpiredOwnerAttempts(input, claim, drained.snapshot);
      if (recovered.status === "lease_lost") return withCounters(summary(input.runId, "lease_lost"), claim, counters);
      if (input.afterOwnershipRecovery) yield* input.afterOwnershipRecovery();

      let pumpTurns = 0;
      for (;;) {
        if (leaseLost) {
          abortAll(active);
          return withCounters(summary(input.runId, "lease_lost"), claim, counters);
        }
        pumpTurns += 1;
        if (pumpTurns % COOPERATIVE_YIELD_QUANTUM === 0) {
          if (!input.store.heartbeatRun(claim, leaseMs)) {
            leaseLost = true;
            continue;
          }
          yield* Effect.yieldNow;
          continue;
        }
        const observedWakeVersion = wakeup.current();

        drained = yield* drainDerivedTransitions(input, claim, leaseMs, () => leaseLost);
        if (drained.status === "lease_lost") {
          leaseLost = true;
          continue;
        }
        let snapshot = drained.snapshot;
        yield* checkpoint(input, snapshot);
        abortDurablyInterruptedExecutions(snapshot.projection, active);

        const settled = firstSettledExecution(active);
        if (settled !== undefined) {
          active.delete(settled.execution.attempt.attemptId);
          if (Exit.isFailure(settled.exit)) {
            if (Cause.hasInterruptsOnly(settled.exit.cause)
              && snapshot.projection.attempts[settled.execution.attempt.attemptId]?.status !== "started") {
              countDurableTerminalAttempt(snapshot.projection, settled.execution.attempt.attemptId, counters);
              continue;
            }
            return yield* Effect.failCause(settled.exit.cause);
          }
          const commit = commitExecutionResult(input, claim, settled.execution, settled.exit.value, counters);
          if (commit.status === "lease_lost") {
            leaseLost = true;
            continue;
          }
          snapshot = commit.snapshot;
          yield* checkpoint(input, snapshot);
          continue;
        }

        const terminal = terminalSummary(snapshot.projection, claim);
        if (terminal) {
          abortAll(active);
          if (active.size > 0) {
            yield* waitForPump({ wakeup, observedWakeVersion, active, projection: snapshot.projection, coordinatedWakeup });
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
          yield* checkpoint(input, replay);
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
          const now = yield* currentDate;
          const replayIdentity = input.replayEvaluationFor?.(admission.instance, snapshot.projection).replayIdentity;
          const events = (input.awaitableEventsFor?.(admission.instance, snapshot.projection, now) ?? []).map(event =>
            event.type === "instance.awaiting" && replayIdentity !== undefined
              ? { ...event, payload: { ...event.payload, replayIdentity } }
              : event
          );
          if (events.length === 0) throw new Error(`Signal instance '${admission.instance.nodeKey}' produced no awaiting transition.`);
          const appended = captureStore(() => input.store.tryAppendSchedulerEvents({
            runId: input.runId,
            expectedVersion: snapshot.version,
            ownerEpoch: claim.ownerEpoch,
            idempotencyKey: `scheduler:await:${input.runId}:${admission.instance.nodeKey}:${snapshot.version}`,
            events,
          }));
          if (Result.isFailure(appended)) {
            if (isVersionMismatchError(appended.failure)) continue;
            if (isLeaseLostError(appended.failure)) {
              leaseLost = true;
              continue;
            }
            storeValue(appended);
          } else {
            yield* checkpoint(input, appended.success);
          }
          continue;
        }

        if (admission?.kind === "executor") {
          const now = yield* currentDate;
          const replay = input.replayEvaluationFor?.(admission.instance, snapshot.projection);
          const replayIdentity = replay?.replayIdentity;
          const deadline = input.deadlineAtFor?.(admission.instance, snapshot.projection, now) ?? Result.succeed(undefined);
          const deadlineAt = Result.isSuccess(deadline) ? deadline.success?.toISOString() : undefined;
          const executorResource = input.executorResourceFor?.(admission.instance, snapshot.projection);
          const started = captureStore(() => input.store.tryStartAttempt({
            runId: input.runId,
            nodeKey: admission.instance.nodeKey,
            nodeId: admission.instance.nodeId,
            ownerEpoch: claim.ownerEpoch,
            expectedVersion: snapshot.version,
            ...(deadlineAt === undefined ? {} : { deadlineAt }),
            ...(replayIdentity === undefined ? {} : { replayIdentity }),
            ...(replay?.sessionGroupDigest === undefined ? {} : { sessionGroupDigest: replay.sessionGroupDigest }),
            idempotencyKey: `scheduler:start:${input.runId}:${admission.instance.nodeKey}:${snapshot.version}`,
          }));
          if (Result.isFailure(started)) {
            if (isVersionMismatchError(started.failure) || isInstanceNotReadyError(started.failure) || isPausedError(started.failure)) continue;
            if (isLeaseLostError(started.failure)) {
              leaseLost = true;
              continue;
            }
            storeValue(started);
          } else {
            if (started.success.invalidatedSessionGroupDigest !== undefined) {
              for (const [nodeKey, candidate] of replayCandidates) {
                if (candidate.sessionGroupDigest === started.success.invalidatedSessionGroupDigest) replayCandidates.delete(nodeKey);
              }
            }
            if (started.success.disposition === "existing") continue;
            counters.started += 1;
            if (Result.isFailure(deadline)) {
              const committed = commitImmediateResult(input, claim, started.success.attemptId, deadline.failure, counters);
              if (committed.status === "lease_lost") leaseLost = true;
              else yield* checkpoint(input, committed.snapshot);
              continue;
            }
            yield* launchExecution({
              input,
              claim,
              instance: admission.instance,
              attemptId: started.success.attemptId,
              attemptNo: started.success.attemptNo,
              deadlineAt,
              ...(started.success.steer === undefined ? {} : { steer: started.success.steer }),
              ...(executorResource === undefined ? {} : { executorResource }),
              active,
              attempts,
            });
          }
          continue;
        }

        if (active.size > 0) {
          yield* waitForPump({ wakeup, observedWakeVersion, active, projection: snapshot.projection, coordinatedWakeup });
          continue;
        }

        if (wakeup.current() !== observedWakeVersion) continue;
        const idle = idleSummary(snapshot.projection, claim);
        return withCounters(idle, claim, counters);
      }
      });
      return yield* execution;
      })),
      ownedClaim => Effect.sync(() => input.store.releaseRun(ownedClaim)).pipe(
        Effect.ensuring(Effect.sync(() => safeObserver(() => input.onRelease?.(ownedClaim)))),
        Effect.asVoid,
      ),
    );
  });
}

function countDurableTerminalAttempt(
  projection: SchedulerProjection,
  attemptId: string,
  counters: Counters,
): void {
  const status = projection.attempts[attemptId]?.status;
  if (status === "completed") counters.completed += 1;
  else if (status === "cancelled" || status === "superseded") counters.cancelled += 1;
  else if (status === "failed" || status === "timed_out") counters.failed += 1;
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
    const replayed = captureStore(() => input.tryCommitReplay!({
      runId: input.runId,
      nodeKey: instance.nodeKey,
      ownerEpoch: claim.ownerEpoch,
      expectedVersion: snapshot.version,
      ...(replayIdentity === undefined ? {} : { replayIdentity }),
      ...(candidate.sessionGroupDigest === undefined ? {} : { expectedSessionGroupDigest: candidate.sessionGroupDigest }),
    }));
    if (Result.isFailure(replayed)) {
      if (isVersionMismatchError(replayed.failure) || isInstanceNotReadyError(replayed.failure) || isPausedError(replayed.failure)) return undefined;
      if (isLeaseLostError(replayed.failure)) return "lease_lost";
      storeValue(replayed);
      continue;
    }
    if (replayed.success.disposition === "replayed") {
      candidates.delete(candidate.nodeKey);
      return replayed.success.snapshot;
    }
    for (const nodeKey of replayed.success.invalidatedNodeKeys) candidates.delete(nodeKey);
  }
  return undefined;
}

function appendBootstrapEvents(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
): Effect.Effect<"appended" | "quiescent" | "lease_lost"> {
  return Effect.gen(function* () {
    if (!input.bootstrap) return "quiescent";
    for (;;) {
      const snapshot = input.store.tryLoadRunSnapshot(input.runId);
      const events = input.bootstrap(snapshot);
      if (events.length === 0) return "quiescent";
      const appended = captureStore(() => input.store.tryAppendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: `scheduler:bootstrap:${input.runId}:${snapshot.version}`,
        events,
      }));
      if (Result.isSuccess(appended)) {
        yield* checkpoint(input, appended.success);
        return "appended";
      }
      if (isLeaseLostError(appended.failure)) return "lease_lost";
      if (!isVersionMismatchError(appended.failure)) storeValue(appended);
    }
  });
}

function recoverExpiredOwnerAttempts(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  initial: SchedulerSnapshot,
): Effect.Effect<SchedulerStepResult> {
  return Effect.gen(function* () {
    let snapshot = initial;
    for (;;) {
      const expiredOwnerEpoch = Object.values(snapshot.projection.attempts)
        .find(attempt => attempt.status === "started" && attempt.ownerEpoch !== claim.ownerEpoch)?.ownerEpoch;
      if (expiredOwnerEpoch === undefined) return { status: "quiescent", snapshot };
      const superseded = captureStore(() => input.store.tryMarkExpiredOwnerAttemptsSuperseded({
        runId: input.runId,
        currentOwnerEpoch: claim.ownerEpoch,
        expiredOwnerEpoch,
        expectedVersion: snapshot.version,
      }));
      if (Result.isSuccess(superseded)) {
        snapshot = superseded.success;
        yield* checkpoint(input, snapshot);
        continue;
      }
      if (isLeaseLostError(superseded.failure)) return { status: "lease_lost", snapshot };
      if (isVersionMismatchError(superseded.failure)) {
        snapshot = input.store.tryLoadRunSnapshot(input.runId);
        continue;
      }
      snapshot = storeValue(superseded);
    }
  });
}

function drainDerivedTransitions(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  leaseMs: number,
  isLeaseLost: () => boolean,
): Effect.Effect<SchedulerStepResult> {
  return Effect.gen(function* () {
    let snapshot = input.store.tryLoadRunSnapshot(input.runId);
    let progressedBatches = 0;
    for (;;) {
      if (isLeaseLost()) return { status: "lease_lost", snapshot };
      const events = nextSchedulerTransitionEvents(
        snapshot.projection,
        () => input.materialize?.(snapshot) ?? [],
        yield* currentDate,
      );
      if (events.length === 0) return { status: "quiescent", snapshot };
      if (!input.store.heartbeatRun(claim, leaseMs)) return { status: "lease_lost", snapshot };

      const beforeVersion = snapshot.version;
      const appended = captureStore(() => input.store.tryAppendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: `scheduler:derived:${input.runId}:${snapshot.version}`,
        events,
      }));
      if (Result.isFailure(appended)) {
        if (isLeaseLostError(appended.failure)) return { status: "lease_lost", snapshot };
        if (isVersionMismatchError(appended.failure)) {
          snapshot = input.store.tryLoadRunSnapshot(input.runId);
          continue;
        }
        snapshot = storeValue(appended);
      } else {
        snapshot = appended.success;
        if (snapshot.version <= beforeVersion) throw new Error(`Run '${input.runId}' appended derived transitions without advancing its durable version.`);
        yield* checkpoint(input, snapshot);
      }

      progressedBatches += 1;
      if (progressedBatches % COOPERATIVE_YIELD_QUANTUM === 0) {
        if (!input.store.heartbeatRun(claim, leaseMs)) return { status: "lease_lost", snapshot };
        yield* Effect.yieldNow;
      }
    }
  });
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
  attempts: FiberSet.FiberSet<AttemptCommitInput["result"]>;
}): Effect.Effect<void> {
  const attempt: ActiveAttempt = {
    runId: input.input.runId,
    nodeKey: input.instance.nodeKey,
    nodeId: input.instance.nodeId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    ownerEpoch: input.claim.ownerEpoch,
  };
  const startReason = attemptStartReason(input.instance);
  let fiber: Fiber.Fiber<AttemptCommitInput["result"]> | undefined;
  return FiberSet.run(input.attempts, input.input.executor.execute({
      runId: input.input.runId,
      nodeKey: input.instance.nodeKey,
      nodeId: input.instance.nodeId,
      attemptId: input.attemptId,
      attemptNo: input.attemptNo,
      ownerEpoch: input.claim.ownerEpoch,
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(startReason === undefined ? {} : { attemptStartReason: startReason }),
      ...(input.steer === undefined ? {} : { steer: input.steer }),
      interrupt: () => fiber?.interruptUnsafe(),
    }), { startImmediately: true }).pipe(
      Effect.tap(started => Effect.sync(() => {
        fiber = started;
        input.active.set(input.attemptId, {
          attempt,
          instance: input.instance,
          ...(input.executorResource === undefined ? {} : { executorResource: input.executorResource }),
          fiber: started,
        });
      })),
      Effect.asVoid,
    );
}

function commitExecutionResult(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  execution: ActiveExecution,
  resultValue: AttemptCommitInput["result"],
  counters: Counters,
): SchedulerStepResult {
  let result = resultValue;
  if (result.status === "completed" && result.output !== undefined) {
    const normalized = tryNormalizeWorkflowData(result.output, `Node '${execution.instance.nodeId}' output`);
    result = Result.isFailure(normalized)
      ? { status: "failed", reason: normalized.failure.message }
      : { ...result, output: normalized.success as JsonValue };
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
  const committed = captureStore(() => input.store.tryCommitAttemptResult({
    runId: input.runId,
    attemptId,
    ownerEpoch: claim.ownerEpoch,
    result,
    idempotencyKey: `scheduler:commit:${input.runId}:${attemptId}`,
  }));
  if (Result.isFailure(committed)) {
    if (isLeaseLostError(committed.failure)) {
      return { status: "lease_lost", snapshot: input.store.tryLoadRunSnapshot(input.runId) };
    }
    const staleTerminal = staleTerminalStatus(committed.failure);
    if (staleTerminal) {
      if (staleTerminal === "failed") counters.failed += 1;
      else counters.cancelled += 1;
      return { status: "quiescent", snapshot: input.store.tryLoadRunSnapshot(input.runId) };
    }
    return { status: "quiescent", snapshot: storeValue(committed) };
  }
  if (result.status === "completed") counters.completed += 1;
  else if (result.status === "cancelled") counters.cancelled += 1;
  else counters.failed += 1;
  return { status: "quiescent", snapshot: committed.success };
}

function waitForPump(input: {
  wakeup: VersionedWakeup;
  observedWakeVersion: number;
  active: ReadonlyMap<string, ActiveExecution>;
  projection: SchedulerProjection;
  coordinatedWakeup: boolean;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const waits: Effect.Effect<unknown>[] = [input.wakeup.waitForChange(input.observedWakeVersion)];
    for (const execution of input.active.values()) {
      waits.push(Fiber.await(execution.fiber));
    }

    const nearestDeadline = nearestWakeDeadline(input.projection, input.active);
    const now = yield* Clock.currentTimeMillis;
    const deadlineDelay = nearestDeadline === undefined ? undefined : Math.max(0, nearestDeadline - now);
    const fallbackDelay = input.coordinatedWakeup ? undefined : UNCOORDINATED_CONTROL_POLL_MS;
    const delay = minimumDefined(deadlineDelay, fallbackDelay);
    if (delay !== undefined) {
      waits.push(Effect.sleep(Math.min(delay, 2_147_483_647)));
    }
    yield* Effect.raceAll(waits);
  });
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
): Effect.Effect<void, never, Scope.Scope> {
  const heartbeat = Effect.sleep(heartbeatIntervalMs(leaseMs)).pipe(
    Effect.andThen(Effect.sync(() => {
      if (store.heartbeatRun(claim, leaseMs)) return true;
      onLeaseLost();
      abortAll(active);
      return false;
    })),
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.sync(() => {
        onLeaseLost();
        abortAll(active);
        return false;
      });
    }),
    Effect.repeat({ while: ownsLease => ownsLease }),
    Effect.asVoid,
  );
  return heartbeat.pipe(
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  );
}

const currentDate = Clock.currentTimeMillis.pipe(Effect.map(milliseconds => new Date(milliseconds)));

function heartbeatIntervalMs(leaseMs: number): number {
  return Math.max(1, Math.floor(leaseMs / 3));
}

function abortDurablyInterruptedExecutions(projection: SchedulerProjection, active: ReadonlyMap<string, ActiveExecution>): void {
  for (const [attemptId, execution] of active) {
    if (projection.attempts[attemptId]?.status !== "started") execution.fiber.interruptUnsafe();
  }
}

function abortAll(active: ReadonlyMap<string, ActiveExecution>): void {
  for (const execution of active.values()) execution.fiber.interruptUnsafe();
}

function unresolvedExecutionCount(active: ReadonlyMap<string, ActiveExecution>): number {
  return active.size;
}

function unsettledExecutorResources(active: ReadonlyMap<string, ActiveExecution>): ReadonlySet<string> {
  const resources = new Set<string>();
  for (const execution of active.values()) {
    if (execution.executorResource !== undefined) {
      resources.add(execution.executorResource);
    }
  }
  return resources;
}

function firstSettledExecution(active: ReadonlyMap<string, ActiveExecution>): {
  execution: ActiveExecution;
  exit: Exit.Exit<AttemptCommitInput["result"]>;
} | undefined {
  for (const execution of active.values()) {
    const exit = execution.fiber.pollUnsafe();
    if (exit !== undefined) return { execution, exit };
  }
  return undefined;
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

function checkpoint(input: AdvanceRunInput, snapshot: SchedulerSnapshot): Effect.Effect<void> {
  return Effect.suspend(() => input.onCheckpoint?.(snapshot) ?? Effect.void).pipe(
    Effect.ignoreCause,
  );
}

function safeObserver(observer: () => void): void {
  try {
    observer();
  } catch {
    // Owner-local observers cannot alter durable scheduling outcomes.
  }
}

function captureStore<Success>(operation: () => Success): Result.Result<Success, SchedulerStoreError> {
  try {
    return Result.succeed(operation());
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (failure) return Result.fail(failure);
    throw error;
  }
}

function storeValue<Success>(result: Result.Result<Success, SchedulerStoreError>): Success {
  if (Result.isFailure(result)) throw new SchedulerStoreException(result.failure);
  return result.success;
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
