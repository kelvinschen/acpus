import type { JsonValue } from "@acpus/expression/ir";
import { ResultAsync } from "neverthrow";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./limiter.js";
import type { SchedulerEvent } from "./events.js";
import { ancestorGroupMembersForNode } from "./membership.js";
import { schedulerStoreError, throwSchedulerStoreResult, type AttemptCommitInput, type RunOwnerClaim, type SchedulerSnapshot, type SchedulerStoreError, type SchedulerStorePort, type SchedulerStoreResult } from "./store-port.js";
import type { GroupMember, NodeInstance, SchedulerProjection } from "./types.js";
import { attemptTimeoutEvents, groupCompletionEvents, signalTimeoutEvents } from "./transitions.js";
import { assertWorkflowData } from "../evaluation/admissible.js";

export type NodeAttemptContext = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
  attemptStartReason?: "control_retry" | "pause_resume";
  signal: AbortSignal;
};

export type NodeExecutor = {
  execute(context: NodeAttemptContext): Promise<AttemptCommitInput["result"]>;
};

export type AdvanceRunInput = {
  runId: string;
  ownerId: string;
  store: SchedulerStorePort;
  executor: NodeExecutor;
  leaseMs?: number;
  maxLeafConcurrency?: number;
  limiter?: ConcurrencyLimiter;
  memberForInstance?: (instance: NodeInstance, projection: SchedulerProjection) => GroupMember | undefined;
  localConcurrencyLimitFor?: (groupKey: string, projection: SchedulerProjection) => number | undefined;
  maxAttemptsFor?: (instance: NodeInstance, projection: SchedulerProjection) => number | undefined;
  deadlineAtFor?: (instance: NodeInstance, projection: SchedulerProjection, now: Date) => Date | undefined;
  awaitableEventsFor?: (instance: NodeInstance, projection: SchedulerProjection) => SchedulerEvent[];
  bootstrap?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  now?: () => Date;
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

export type AdvanceRunError = SchedulerStoreError;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_LEAF_CONCURRENCY = 32;

export function tryAdvanceRun(input: AdvanceRunInput): ResultAsync<AdvanceRunSummary, AdvanceRunError> {
  return ResultAsync.fromPromise(
    advanceRun(input),
    error => {
      const storeError = schedulerStoreError(error);
      if (storeError) return storeError;
      throw error;
    },
  );
}

export async function advanceRun(input: AdvanceRunInput): Promise<AdvanceRunSummary> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const claim = input.store.claimRun(input.runId, input.ownerId, leaseMs);
  if (!claim) return summary(input.runId, "lease_lost");
  try {
    const now = input.now ?? (() => new Date());
    const preflight = terminalSummary(unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId)).projection, claim);
    if (preflight) return preflight;

    appendBootstrapEvents(input, claim);
    const deadlineRecovered = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
    const recovered = unwrapStoreResult(input.store.tryLoadRunSnapshot(deadlineRecovered.runId));
    const expiredOwnerEpochs = [...new Set(Object.values(recovered.projection.attempts)
      .filter(attempt => attempt.status === "started" && attempt.ownerEpoch !== claim.ownerEpoch)
      .map(attempt => attempt.ownerEpoch))];
    for (const ownerEpoch of expiredOwnerEpochs) unwrapStoreResult(input.store.tryMarkExpiredOwnerAttemptsSuperseded(input.runId, ownerEpoch));

    const initial = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
    const terminal = terminalSummary(initial.projection, claim);
    if (terminal) return terminal;

    const maxLeafConcurrency = input.maxLeafConcurrency ?? DEFAULT_MAX_LEAF_CONCURRENCY;
    const ready = selectReadyInstances(initial.projection, maxLeafConcurrency, input.memberForInstance, input.localConcurrencyLimitFor);
    if (ready.length === 0) return idleSummary(initial.projection, claim);

    const waitEvents = ready.flatMap(instance => input.awaitableEventsFor?.(instance, initial.projection) ?? []);
    if (waitEvents.length > 0) {
      unwrapStoreResult(input.store.tryAppendSchedulerEvents({
        runId: input.runId,
        expectedVersion: initial.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: `scheduler:await:${input.runId}:${initial.version}`,
        events: waitEvents,
      }));
    }
    const executable = waitEvents.length === 0
      ? ready
      : selectReadyInstances(
        drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor).projection,
        maxLeafConcurrency,
        input.memberForInstance,
        input.localConcurrencyLimitFor,
      );
    if (executable.length === 0) {
      const latest = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
      return terminalSummary(latest.projection, claim) ?? idleSummary(latest.projection, claim);
    }

    const limiter = input.limiter ?? createConcurrencyLimiter(maxLeafConcurrency);
    const counters = { started: 0, completed: 0, failed: 0, cancelled: 0, leaseLost: false };
    const active = new Map<string, AbortController>();
    await Promise.all(executable.map(instance => limiter.add(async () => {
      await runInstance(input, claim, leaseMs, now, instance, counters, active);
      drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
      abortInterruptedActiveAttempts(input.store, input.runId, active);
    })));
    await limiter.onIdle();

    if (counters.leaseLost) {
      limiter.clear();
      return {
        status: "lease_lost",
        runId: input.runId,
        ownerEpoch: claim.ownerEpoch,
        started: counters.started,
        completed: counters.completed,
        failed: counters.failed,
        cancelled: counters.cancelled,
        active: 0,
      };
    }

    const latest = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
    const terminalAfterWork = terminalSummary(latest.projection, claim);
    if (terminalAfterWork) {
      return { ...terminalAfterWork, started: counters.started, completed: counters.completed, failed: counters.failed, cancelled: counters.cancelled };
    }
    const idle = idleSummary(latest.projection, claim);
    return { ...idle, started: counters.started, completed: counters.completed, failed: counters.failed, cancelled: counters.cancelled };
  } finally {
    input.store.releaseRun(claim);
  }
}

function appendBootstrapEvents(input: AdvanceRunInput, claim: RunOwnerClaim): void {
  if (!input.bootstrap) return;
  let snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
  for (let attempts = 0; attempts < 2; attempts += 1) {
    const events = input.bootstrap(snapshot);
    if (events.length === 0) return;
    const appended = input.store.tryAppendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `scheduler:bootstrap:${input.runId}:${snapshot.version}`,
      events,
    });
    if (appended.isOk()) {
      return;
    }
    if (!isVersionMismatchError(appended.error) || attempts === 1) unwrapStoreResult(appended);
    snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
  }
}

export function selectReadyInstances(
  projection: SchedulerProjection,
  maxLeafConcurrency: number,
  memberForInstance: AdvanceRunInput["memberForInstance"],
  localConcurrencyLimitFor: AdvanceRunInput["localConcurrencyLimitFor"],
): NodeInstance[] {
  const active = Object.values(projection.attempts).filter(attempt => attempt.status === "started").length;
  const available = Math.max(0, maxLeafConcurrency - active);
  if (available === 0) return [];

  const localActive = new Map<string, number>();
  for (const member of Object.values(projection.groupMembers)) {
    if (member.status !== "running") continue;
    const limit = localConcurrencyLimitFor?.(member.groupKey, projection);
    if (limit !== undefined) localActive.set(member.groupKey, (localActive.get(member.groupKey) ?? 0) + 1);
  }

  const selected: NodeInstance[] = [];
  for (const instance of Object.values(projection.instances).filter(instance => instance.status === "ready").sort(byReadiness)) {
    if (selected.length >= available) break;
    const members = membersForReadyInstance(instance, projection, memberForInstance);
    if (members.some(member => member.status !== "ready" && member.status !== "running")) continue;
    if (!reserveGroupCapacity(members, projection, localActive, localConcurrencyLimitFor)) continue;
    selected.push(instance);
  }
  return selected;
}

function reserveGroupCapacity(
  members: readonly GroupMember[],
  projection: SchedulerProjection,
  localActive: Map<string, number>,
  localConcurrencyLimitFor: AdvanceRunInput["localConcurrencyLimitFor"],
): boolean {
  const reservations: string[] = [];
  for (const member of members) {
    if (member.status === "running") continue;
    const limit = localConcurrencyLimitFor?.(member.groupKey, projection);
    const used = localActive.get(member.groupKey) ?? 0;
    const pending = reservations.filter(groupKey => groupKey === member.groupKey).length;
    if (limit !== undefined && used + pending >= limit) return false;
    reservations.push(member.groupKey);
  }
  for (const groupKey of reservations) localActive.set(groupKey, (localActive.get(groupKey) ?? 0) + 1);
  return true;
}

function drainDerivedTransitions(
  store: SchedulerStorePort,
  runId: string,
  claim: RunOwnerClaim,
  now: () => Date,
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[],
  maxAttemptsFor?: AdvanceRunInput["maxAttemptsFor"],
): SchedulerSnapshot {
  let snapshot = unwrapStoreResult(store.tryLoadRunSnapshot(runId));
  for (;;) {
    const events =
      retryFailedInstanceEvents(snapshot.projection, maxAttemptsFor);
    if (events.length === 0) events.push(...Object.keys(snapshot.projection.groups).flatMap(groupKey => groupCompletionEvents(snapshot.projection, groupKey)));
    if (events.length === 0) events.push(...(materialize?.(snapshot) ?? []));
    if (events.length === 0) events.push(...attemptTimeoutEvents(snapshot.projection, now()));
    if (events.length === 0) events.push(...signalTimeoutEvents(snapshot.projection, now()));
    if (events.length === 0) return snapshot;
    snapshot = unwrapStoreResult(store.tryAppendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `scheduler:derived:${runId}:${snapshot.version}`,
      events,
    }));
  }
}

function membersForReadyInstance(instance: NodeInstance, projection: SchedulerProjection, override: AdvanceRunInput["memberForInstance"]): GroupMember[] {
  const overridden = override?.(instance, projection);
  return overridden ? [overridden] : ancestorGroupMembersForNode(projection, instance.nodeKey);
}

function retryFailedInstanceEvents(projection: SchedulerProjection, maxAttemptsFor: AdvanceRunInput["maxAttemptsFor"]): SchedulerEvent[] {
  if (!maxAttemptsFor) return [];
  for (const instance of Object.values(projection.instances).filter(instance => instance.status === "failed").sort(byReadiness)) {
    const maxAttempts = maxAttemptsFor(instance, projection);
    if (maxAttempts === undefined) continue;
    const failedAttempts = Object.values(projection.attempts)
      .filter(attempt => attempt.nodeKey === instance.nodeKey && (attempt.status === "failed" || attempt.status === "timed_out"));
    if (failedAttempts.length >= maxAttempts) continue;
    const events: SchedulerEvent[] = [
      {
        type: "instance.retry_requested",
        payload: {
          nodeKey: instance.nodeKey,
          ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
          source: "scheduler",
        },
      },
    ];
    for (const member of ancestorGroupMembersForNode(projection, instance.nodeKey).filter(member => member.status === "failed")) {
      events.push({
        type: "group.member_retry_requested",
        payload: {
          memberKey: member.memberKey,
          readinessSequence: member.readinessSequence,
          source: "scheduler",
        },
      });
    }
    return events;
  }
  return [];
}

async function runInstance(
  input: AdvanceRunInput,
  claim: RunOwnerClaim,
  leaseMs: number,
  now: () => Date,
  instance: NodeInstance,
  counters: { started: number; completed: number; failed: number; cancelled: number; leaseLost: boolean },
  active: Map<string, AbortController>,
): Promise<void> {
  if (!input.store.heartbeatRun(claim, leaseMs)) {
    counters.leaseLost = true;
    return;
  }
  let attempt: { attemptId: string; attemptNo: number };
  const snapshot = unwrapStoreResult(input.store.tryLoadRunSnapshot(input.runId));
  const deadlineAt = input.deadlineAtFor?.(instance, snapshot.projection, now())?.toISOString();
  const started = input.store.tryStartAttempt({
    runId: input.runId,
    nodeKey: instance.nodeKey,
    nodeId: instance.nodeId,
    ownerEpoch: claim.ownerEpoch,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    idempotencyKey: `scheduler:start:${input.runId}:${instance.nodeKey}:${claim.ownerEpoch}`,
  });
  if (started.isOk()) {
    attempt = started.value;
  } else {
    if (isPausedError(started.error)) {
      counters.cancelled += 1;
      return;
    }
    attempt = unwrapStoreResult(started);
  }
  counters.started += 1;

  const controller = new AbortController();
  active.set(instance.nodeKey, controller);
  const monitor = setInterval(() => abortInterruptedActiveAttempts(input.store, input.runId, active), 10);
  monitor.unref?.();
  let result: AttemptCommitInput["result"];
  const startReason = attemptStartReason(instance);
  try {
    result = await input.executor.execute({
      runId: input.runId,
      nodeKey: instance.nodeKey,
      nodeId: instance.nodeId,
      attemptId: attempt.attemptId,
      attemptNo: attempt.attemptNo,
      ownerEpoch: claim.ownerEpoch,
      ...(startReason === undefined ? {} : { attemptStartReason: startReason }),
      signal: controller.signal,
    });
  } catch (error) {
    result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearInterval(monitor);
    active.delete(instance.nodeKey);
  }
  if (result.status === "completed") {
    try {
      assertWorkflowData(result.output, `Node '${instance.nodeId}' output`);
    } catch (error) {
      result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const committed = input.store.tryCommitAttemptResult({
    runId: input.runId,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    result,
    idempotencyKey: `scheduler:commit:${input.runId}:${attempt.attemptId}`,
  });
  if (committed.isErr()) {
    if (isLeaseLostError(committed.error)) {
      counters.leaseLost = true;
      controller.abort();
      return;
    }
    const staleTerminal = staleTerminalStatus(committed.error);
    if (staleTerminal) {
      if (staleTerminal === "failed") counters.failed += 1;
      else counters.cancelled += 1;
      return;
    }
    unwrapStoreResult(committed);
  }

  if (result.status === "completed") counters.completed += 1;
  else if (result.status === "cancelled") counters.cancelled += 1;
  else counters.failed += 1;
}

function attemptStartReason(instance: NodeInstance): NodeAttemptContext["attemptStartReason"] | undefined {
  if (instance.statusReason === "retry") return "control_retry";
  if (instance.statusReason === "paused") return "pause_resume";
  return undefined;
}

function abortInterruptedActiveAttempts(store: SchedulerStorePort, runId: string, active: Map<string, AbortController>): void {
  const projection = unwrapStoreResult(store.tryLoadRunSnapshot(runId)).projection;
  for (const [nodeKey, controller] of active) {
    const instance = projection.instances[nodeKey];
    if (projection.run.status === "paused" || instance?.status === "failed" || instance?.status === "cancelled" || (instance?.status === "ready" && instance.statusReason === "paused")) {
      controller.abort();
    }
  }
}

function terminalSummary(projection: SchedulerProjection, claim: RunOwnerClaim): AdvanceRunSummary | undefined {
  if (projection.run.status === "completed" || projection.run.status === "failed" || projection.run.status === "canceled" || projection.run.status === "paused") {
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
  return undefined;
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

function activeAttemptCount(projection: SchedulerProjection): number {
  return Object.values(projection.attempts).filter(attempt => attempt.status === "started").length;
}

function hasAwaitingWork(projection: SchedulerProjection): boolean {
  return Object.values(projection.instances).some(instance => instance.status === "awaiting")
    || Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
}

function byReadiness(left: NodeInstance, right: NodeInstance): number {
  return (left.readinessSequence ?? Number.MAX_SAFE_INTEGER) - (right.readinessSequence ?? Number.MAX_SAFE_INTEGER)
    || left.nodeKey.localeCompare(right.nodeKey);
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

function staleTerminalStatus(error: SchedulerStoreError): "cancelled" | "failed" | undefined {
  if (error.type !== "terminal-attempt") return undefined;
  if (error.status === "cancelled" || error.status === "superseded") return "cancelled";
  if (error.status === "timed_out" || error.status === "failed") return "failed";
  return undefined;
}

export function completed(output?: JsonValue): AttemptCommitInput["result"] {
  return output === undefined ? { status: "completed" } : { status: "completed", output };
}
