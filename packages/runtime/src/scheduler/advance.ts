import type { JsonValue } from "@acpus/expression/ir";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./limiter.js";
import type { SchedulerEvent } from "./events.js";
import type { AttemptCommitInput, RunOwnerClaim, SchedulerSnapshot, SchedulerStorePort } from "./store-port.js";
import type { GroupMember, NodeInstance, SchedulerProjection } from "./types.js";
import { attemptTimeoutEvents, groupCompletionEvents, signalTimeoutEvents } from "./transitions.js";

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
  bootstrap?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[];
  now?: () => Date;
};

export type AdvanceRunSummary = {
  status: "completed" | "failed" | "paused" | "awaiting" | "idle" | "lease_lost";
  runId: string;
  ownerEpoch?: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_LEAF_CONCURRENCY = 32;

export async function advanceRun(input: AdvanceRunInput): Promise<AdvanceRunSummary> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const claim = input.store.claimRun(input.runId, input.ownerId, leaseMs);
  if (!claim) return summary(input.runId, "lease_lost");
  try {
    const now = input.now ?? (() => new Date());
    const preflight = terminalSummary(input.store.loadRunSnapshot(input.runId).projection, claim);
    if (preflight) return preflight;

    appendBootstrapEvents(input, claim);
    const deadlineRecovered = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
    const recovered = input.store.loadRunSnapshot(deadlineRecovered.runId);
    const expiredOwnerEpochs = [...new Set(Object.values(recovered.projection.attempts)
      .filter(attempt => attempt.status === "started" && attempt.ownerEpoch !== claim.ownerEpoch)
      .map(attempt => attempt.ownerEpoch))];
    for (const ownerEpoch of expiredOwnerEpochs) input.store.markExpiredOwnerAttemptsSuperseded(input.runId, ownerEpoch);

    const initial = drainDerivedTransitions(input.store, input.runId, claim, now, input.materialize, input.maxAttemptsFor);
    const terminal = terminalSummary(initial.projection, claim);
    if (terminal) return terminal;

    const maxLeafConcurrency = input.maxLeafConcurrency ?? DEFAULT_MAX_LEAF_CONCURRENCY;
    const ready = selectReadyInstances(initial.projection, maxLeafConcurrency, input.memberForInstance, input.localConcurrencyLimitFor);
    if (ready.length === 0) return idleSummary(initial.projection, claim);

    const limiter = input.limiter ?? createConcurrencyLimiter(maxLeafConcurrency);
    const counters = { started: 0, completed: 0, failed: 0, cancelled: 0, leaseLost: false };
    const active = new Map<string, AbortController>();
    await Promise.all(ready.map(instance => limiter.add(async () => {
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
  let snapshot = input.store.loadRunSnapshot(input.runId);
  for (let attempts = 0; attempts < 2; attempts += 1) {
    const events = input.bootstrap(snapshot);
    if (events.length === 0) return;
    try {
      input.store.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: `scheduler:bootstrap:${input.runId}:${snapshot.version}`,
        events,
      });
      return;
    } catch (error) {
      if (!isVersionMismatchError(error) || attempts === 1) throw error;
      snapshot = input.store.loadRunSnapshot(input.runId);
    }
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
    const member = memberForReadyInstance(instance, projection, memberForInstance);
    if (member) {
      const continuingRunningMember = member.status === "running" && member.memberKey === instance.parentFrameKey;
      if (member.status !== "ready" && !continuingRunningMember) continue;
      if (continuingRunningMember) {
        selected.push(instance);
        continue;
      }
      const limit = localConcurrencyLimitFor?.(member.groupKey, projection);
      const used = localActive.get(member.groupKey) ?? 0;
      if (limit !== undefined && used >= limit) continue;
      localActive.set(member.groupKey, used + 1);
    }
    selected.push(instance);
  }
  return selected;
}

function drainDerivedTransitions(
  store: SchedulerStorePort,
  runId: string,
  claim: RunOwnerClaim,
  now: () => Date,
  materialize?: (snapshot: SchedulerSnapshot) => SchedulerEvent[],
  maxAttemptsFor?: AdvanceRunInput["maxAttemptsFor"],
): SchedulerSnapshot {
  let snapshot = store.loadRunSnapshot(runId);
  for (;;) {
    const events =
      retryFailedInstanceEvents(snapshot.projection, maxAttemptsFor);
    if (events.length === 0) events.push(...Object.keys(snapshot.projection.groups).flatMap(groupKey => groupCompletionEvents(snapshot.projection, groupKey)));
    if (events.length === 0) events.push(...(materialize?.(snapshot) ?? []));
    if (events.length === 0) events.push(...attemptTimeoutEvents(snapshot.projection, now()));
    if (events.length === 0) events.push(...signalTimeoutEvents(snapshot.projection, now()));
    if (events.length === 0) return snapshot;
    snapshot = store.appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `scheduler:derived:${runId}:${snapshot.version}`,
      events,
    });
  }
}

function memberForReadyInstance(instance: NodeInstance, projection: SchedulerProjection, override: AdvanceRunInput["memberForInstance"]): GroupMember | undefined {
  return override?.(instance, projection)
    ?? projection.groupMembers[instance.nodeKey]
    ?? (instance.parentFrameKey === undefined ? undefined : projection.groupMembers[instance.parentFrameKey]);
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
    const directMember = projection.groupMembers[instance.nodeKey];
    if (directMember?.status === "failed") {
      events.push({
        type: "group.member_retry_requested",
        payload: {
          memberKey: directMember.memberKey,
          readinessSequence: directMember.readinessSequence,
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
  const snapshot = input.store.loadRunSnapshot(input.runId);
  const deadlineAt = input.deadlineAtFor?.(instance, snapshot.projection, now())?.toISOString();
  try {
    attempt = input.store.startAttempt({
      runId: input.runId,
      nodeKey: instance.nodeKey,
      nodeId: instance.nodeId,
      ownerEpoch: claim.ownerEpoch,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      idempotencyKey: `scheduler:start:${input.runId}:${instance.nodeKey}:${claim.ownerEpoch}`,
    });
  } catch (error) {
    if (isPausedError(error)) {
      counters.cancelled += 1;
      return;
    }
    throw error;
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

  try {
    input.store.commitAttemptResult({
      runId: input.runId,
      attemptId: attempt.attemptId,
      ownerEpoch: claim.ownerEpoch,
      result,
      idempotencyKey: `scheduler:commit:${input.runId}:${attempt.attemptId}`,
    });
  } catch (error) {
    if (isLeaseLostError(error)) {
      counters.leaseLost = true;
      controller.abort();
      return;
    }
    const staleTerminal = staleTerminalStatus(error);
    if (staleTerminal) {
      if (staleTerminal === "failed") counters.failed += 1;
      else counters.cancelled += 1;
      return;
    }
    throw error;
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
  const projection = store.loadRunSnapshot(runId).projection;
  for (const [nodeKey, controller] of active) {
    const instance = projection.instances[nodeKey];
    if (projection.run.status === "paused" || instance?.status === "failed" || instance?.status === "cancelled" || (instance?.status === "ready" && instance.statusReason === "paused")) {
      controller.abort();
    }
  }
}

function terminalSummary(projection: SchedulerProjection, claim: RunOwnerClaim): AdvanceRunSummary | undefined {
  if (projection.run.status === "completed" || projection.run.status === "failed" || projection.run.status === "paused") {
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

function isLeaseLostError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("owner epoch") || error.message.includes("not active"));
}

function isPausedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("is paused");
}

function isVersionMismatchError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("version mismatch");
}

function staleTerminalStatus(error: unknown): "cancelled" | "failed" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message.includes("already cancelled") || error.message.includes("already superseded")) return "cancelled";
  if (error.message.includes("already timed_out") || error.message.includes("already failed")) return "failed";
  return undefined;
}

export function completed(output?: JsonValue): AttemptCommitInput["result"] {
  return output === undefined ? { status: "completed" } : { status: "completed", output };
}
