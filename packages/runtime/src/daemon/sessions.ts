import { applySchedulerControlIntent, type RunControlIntent, type SchedulerControlEffect } from "../scheduler/control.js";
import {
  createRuntimeRunScheduler,
  triggerHooksForCommittedRowsForRun,
  type RunExecution,
  type RunExecutionExit,
  type RuntimeHookCursor,
  type RuntimeRunScheduler,
} from "../scheduler/runtime-runner.js";
import type { HookRunner } from "../hooks/runner.js";
import type { RunDetails, RuntimeStore } from "../store/store.js";
import { DaemonRequestError, type DaemonControlIntent, type DaemonControlResult } from "./socket.js";
import { CoalescingNodeProgressWriter } from "../progress/writer.js";
import type { RuntimeConfiguration } from "../configuration.js";

type ActiveRunSession = {
  execution: RunExecution;
  promise: Promise<RunExecutionExit>;
};

type ExecutionFailure = {
  eventCount: number;
};

export class RunExecutionSessions {
  private readonly sessions = new Map<string, ActiveRunSession>();
  private readonly failures = new Map<string, ExecutionFailure>();
  private readonly progressWriter: CoalescingNodeProgressWriter;
  private readonly scheduler: RuntimeRunScheduler;

  constructor(
    private readonly cwd: string,
    private readonly store: RuntimeStore,
    private readonly hookRunner: HookRunner | undefined,
    runtimeConfiguration: RuntimeConfiguration,
  ) {
    this.progressWriter = new CoalescingNodeProgressWriter(store);
    this.scheduler = createRuntimeRunScheduler({
      cwd,
      store,
      maxLeafConcurrency: runtimeConfiguration.runMaxLeafConcurrency,
      agentHostPolicy: runtimeConfiguration.agentHostPolicy,
      ...(hookRunner === undefined ? {} : { hookRunner }),
      progressWriter: this.progressWriter,
    });
  }

  activeCount(): number {
    return this.sessions.size;
  }

  hookActiveCount(): number {
    return this.hookRunner?.activeCount() ?? 0;
  }

  async drainHooks(): Promise<void> {
    await this.hookRunner?.drain();
  }

  async stopExecutors(timeoutMs: number): Promise<void> {
    for (const session of this.sessions.values()) session.execution.stop();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.sessions.values()].map(session => session.promise)),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  start(runId: string): RunDetails {
    const existing = this.store.getRun(runId);
    if (!existing) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${runId}' was not found.`);
    if (isTerminal(existing.status)) {
      this.failures.delete(runId);
      return existing;
    }
    const failure = this.failures.get(runId);
    if (failure?.eventCount === existing.eventCount) return existing;
    if (failure) this.failures.delete(runId);
    if (!this.sessions.has(runId)) this.startExecution(runId);
    return existing;
  }

  async control(intent: DaemonControlIntent): Promise<DaemonControlResult | undefined> {
    const session = this.sessions.get(intent.runId);
    if (!session) return this.controlWithShortSession(intent);
    if (intent.type === "fork") return this.fork(intent);

    const ownerEpoch = await session.execution.ownerEpoch;
    if (ownerEpoch === undefined) return undefined;
    const { effect, reopened } = applySchedulerControlIntent(this.store, controlIntent(intent), ownerEpoch);
    session.execution.wake();

    const restartsSession = reopened;
    const endsSession = intent.type === "pause" || intent.type === "cancel" && intent.target === undefined;
    if (restartsSession) session.execution.stop();
    if (restartsSession || endsSession) await Promise.allSettled([session.promise]);

    const run = this.store.getRun(intent.runId);
    if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
    if (restartsSession && !this.sessions.has(intent.runId)) this.startExecution(intent.runId);
    return controlResult(effect, run);
  }

  private startExecution(runId: string): void {
    this.failures.delete(runId);
    const execution = this.scheduler.start({ runId, ownerId: `daemon:${process.pid}:${runId}` });
    const session: ActiveRunSession = { execution, promise: execution.result };
    session.promise = session.promise.finally(() => {
      this.progressWriter.flushMatching(progress => progress.runId === runId);
      if (this.sessions.get(runId) === session) this.sessions.delete(runId);
    });
    this.sessions.set(runId, session);
    void session.promise.catch(() => {
      if (this.sessions.has(runId)) return;
      const run = this.store.getRun(runId);
      if (run) this.failures.set(runId, { eventCount: run.eventCount });
    });
  }

  private async controlWithShortSession(intent: DaemonControlIntent): Promise<DaemonControlResult> {
    const existing = this.store.getRun(intent.runId);
    if (!existing) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
    const claim = this.store.scheduler.claimRun(intent.runId, `daemon:${process.pid}:${intent.runId}:control`, 30_000);
    if (!claim) throw new DaemonRequestError("CONTROL_CONFLICT", `Run '${intent.runId}' is currently controlled by another owner.`);
    const hookCursor = { sequence: this.store.getLastRunEventSequence(intent.runId) };
    let result: DaemonControlResult;
    let reopened = false;
    try {
      if (intent.type === "fork") return await this.fork(intent);
      const control = applySchedulerControlIntent(this.store, controlIntent(intent), claim.ownerEpoch);
      reopened = control.reopened;
      this.triggerHooks(intent.runId, hookCursor);
      const run = this.store.getRun(intent.runId);
      if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
      result = controlResult(control.effect, run);
    } finally {
      this.store.scheduler.releaseRun(claim);
    }
    if ((continuesAfterShortControl(intent) || reopened)
      && !this.sessions.has(intent.runId)
      && !isTerminal(result.run.status)) {
      this.start(intent.runId);
    }
    return result;
  }

  private async fork(intent: Extract<DaemonControlIntent, { type: "fork" }>): Promise<DaemonControlResult> {
    const fork = await this.store.forkRun(intent.runId, {
      requestId: intent.requestId,
      ...(intent.target === undefined ? {} : { target: intent.target }),
      ...(intent.prepared === undefined ? {} : { prepared: intent.prepared }),
      ...(intent.input === undefined ? {} : { input: intent.input }),
      ...(intent.agentOverrides === undefined ? {} : { agentOverrides: intent.agentOverrides }),
      ...(intent.unsafeReuse === undefined ? {} : { unsafeReuse: intent.unsafeReuse }),
    });
    if (fork.forkCreated) this.triggerHooks(fork.id, { sequence: 0 });
    const run = this.store.getRun(fork.id);
    if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Fork run '${fork.id}' was not found.`);
    return { type: "fork", state: "applied", sourceRunId: intent.runId, run };
  }

  private triggerHooks(runId: string, hookCursor: RuntimeHookCursor): void {
    triggerHooksForCommittedRowsForRun({
      cwd: this.cwd,
      store: this.store,
      runId,
      ...(this.hookRunner === undefined ? {} : { hookRunner: this.hookRunner }),
      hookCursor,
    });
  }
}

function continuesAfterShortControl(intent: DaemonControlIntent): boolean {
  return intent.type === "signal"
    || intent.type === "cancel" && intent.target !== undefined;
}

function controlIntent(intent: DaemonControlIntent): RunControlIntent {
  if (intent.type === "signal") {
    return {
      requestId: intent.requestId,
      runId: intent.runId,
      type: "signal",
      node: intent.nodeId,
      payload: intent.payload,
      commandIdempotencyKey: intent.requestId,
    };
  }
  if (intent.type === "pause") return { requestId: intent.requestId, runId: intent.runId, type: "pause" };
  if (intent.type === "resume") return { requestId: intent.requestId, runId: intent.runId, type: "resume" };
  if (intent.type === "retry") return { requestId: intent.requestId, runId: intent.runId, type: "retry", ...(intent.target === undefined ? {} : { target: intent.target }) };
  if (intent.type === "cancel") return { requestId: intent.requestId, runId: intent.runId, type: "cancel", ...(intent.target === undefined ? {} : { target: intent.target }) };
  throw new Error(`Unsupported active control '${intent.type}'.`);
}

function controlResult(effect: SchedulerControlEffect, run: RunDetails): DaemonControlResult {
  if (effect.type === "pause") return { ...effect, run };
  if (effect.type === "resume") return { ...effect, run };
  if (effect.type === "retry") return { ...effect, run };
  if (effect.type === "cancel") return { ...effect, run };
  if (effect.type === "signal") return { ...effect, run };
  return assertNever(effect);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler control effect: ${String(value)}`);
}

function isTerminal(status: RunDetails["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
