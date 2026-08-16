import { applySchedulerControlIntent, type RunControlIntent, type SchedulerControlEffect, type SchedulerControlFailure } from "../scheduler/control.js";
import {
  createRuntimeRunScheduler,
  type RunExecution,
  type RunExecutionExit,
  type RunExecutionFailure,
  type RuntimeRunScheduler,
} from "../scheduler/runtime-runner.js";
import { dispatchCommittedHooksForRun } from "../hooks/dispatch.js";
import type { HookRunner } from "../hooks/runner.js";
import type { ForkRunFailure, RunDetails, RuntimeStore } from "../store/store.js";
import type { RuntimeControlIntent, RuntimeControlResult } from "../runtime-contracts.js";
import { CoalescingNodeProgressWriter } from "../progress/writer.js";
import type { RuntimeConfiguration } from "../configuration.js";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { ManagedAcpExecutor } from "@acpus/agent-executor";
import { randomUUID } from "node:crypto";

type ActiveRunSession = {
  execution: RunExecution;
  promise: Promise<Result<RunExecutionExit, RunExecutionFailure>>;
};

type IncidentFence = {
  eventVersion: number;
};

export type RunSessionStart = {
  disposition: "started" | "already-active" | "terminal" | "quarantined";
  run: RunDetails;
};

export type RunIncident = {
  runId: string;
  source: "execution" | "hook";
  error: unknown;
};

export type RunSessionControlFailure = SchedulerControlFailure
  | ForkRunFailure
  | { type: "run-not-controllable"; runId: string; message: string };

export class RunExecutionSessions {
  private readonly sessions = new Map<string, ActiveRunSession>();
  private readonly failures = new Map<string, IncidentFence>();
  private readonly hookFailures = new Map<string, IncidentFence>();
  private readonly progressWriter: CoalescingNodeProgressWriter;
  private readonly scheduler: RuntimeRunScheduler;

  constructor(
    private readonly cwd: string,
    private readonly store: RuntimeStore,
    private readonly hookRunner: HookRunner | undefined,
    runtimeConfiguration: RuntimeConfiguration,
    private readonly onRunIncident: (incident: RunIncident) => void = () => undefined,
    managedAcpExecutor?: ManagedAcpExecutor,
    private readonly runtimeAuthorityOwnerId = randomUUID(),
  ) {
    this.progressWriter = new CoalescingNodeProgressWriter(store);
    this.scheduler = createRuntimeRunScheduler({
      cwd,
      store,
      maxLeafConcurrency: runtimeConfiguration.runMaxLeafConcurrency,
      agentHostPolicy: runtimeConfiguration.agentHostPolicy,
      ...(managedAcpExecutor === undefined ? {} : { managedAcpExecutor }),
      ...(hookRunner === undefined ? {} : { hookRunner }),
      shouldDispatchHooks: runId => this.shouldDispatchHooks(runId),
      onHookIncident: (runId, error) => this.recordHookIncident(runId, error),
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

  dispatchHooks(runId: string): "dispatched" | "retry" | "quarantined" {
    if (!this.shouldDispatchHooks(runId)) return "quarantined";
    try {
      const result = dispatchCommittedHooksForRun({
        cwd: this.cwd,
        store: this.store,
        runId,
        ...(this.hookRunner === undefined ? {} : { hookRunner: this.hookRunner }),
      });
      return result.isErr() ? "retry" : "dispatched";
    } catch (error) {
      this.recordHookIncident(runId, error);
      return "quarantined";
    }
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

  start(runId: string): RunSessionStart {
    const existing = this.store.getRun(runId);
    if (!existing) throw new Error(`Run '${runId}' was not found.`);
    if (isTerminal(existing.status)) {
      this.failures.delete(runId);
      return { disposition: "terminal", run: existing };
    }
    const eventVersion = this.store.getRunEventVersion(runId);
    if (eventVersion === undefined) throw new Error(`Run '${runId}' was not found.`);
    const failure = this.failures.get(runId);
    if (failure?.eventVersion === eventVersion) return { disposition: "quarantined", run: existing };
    if (failure) this.failures.delete(runId);
    if (this.sessions.has(runId)) return { disposition: "already-active", run: existing };
    this.startExecution(runId);
    return { disposition: "started", run: existing };
  }

  control(intent: RuntimeControlIntent): ResultAsync<RuntimeControlResult, RunSessionControlFailure> {
    return new ResultAsync(this.controlResult(intent));
  }

  private async controlResult(intent: RuntimeControlIntent): Promise<Result<RuntimeControlResult, RunSessionControlFailure>> {
    const session = this.sessions.get(intent.runId);
    if (!session) return this.controlWithShortSession(intent);
    if (intent.type === "fork") return this.fork(intent);

    const ownerEpoch = await session.execution.ownerEpoch;
    if (ownerEpoch === undefined) {
      return err({ type: "run-not-controllable", runId: intent.runId, message: `Control '${intent.type}' could not be applied to run '${intent.runId}'.` });
    }
    const applied = applySchedulerControlIntent(this.store, controlIntent(intent), ownerEpoch);
    if (applied.isErr()) return err(applied.error);
    const control = applied.value;
    const { effect, reopened } = control;
    const fenceFlush = control.observationFence
      ? this.store.observationLog.markFenced(control.observationFence)
      : undefined;
    session.execution.wake();
    if (fenceFlush) await fenceFlush.catch(() => {});

    const restartsSession = reopened;
    const endsSession = intent.type === "pause" || intent.type === "cancel" && intent.target === undefined;
    if (restartsSession) session.execution.stop();
    if (restartsSession || endsSession) await Promise.allSettled([session.promise]);

    const run = this.store.getRun(intent.runId);
    if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
    if (restartsSession && !this.sessions.has(intent.runId)) this.startExecution(intent.runId);
    return ok(daemonControlResult(effect, run));
  }

  private startExecution(runId: string): void {
    this.failures.delete(runId);
    const execution = this.scheduler.start({
      runId,
      ownerId: `runtime-authority:${this.runtimeAuthorityOwnerId}:${runId}`,
    });
    const session: ActiveRunSession = { execution, promise: execution.result };
    session.promise = session.promise.finally(() => {
      this.progressWriter.flushMatching(progress => progress.runId === runId);
      if (this.sessions.get(runId) === session) this.sessions.delete(runId);
    });
    this.sessions.set(runId, session);
    void session.promise.catch(error => {
      if (this.sessions.has(runId)) return;
      const eventVersion = this.store.getRunEventVersion(runId);
      if (eventVersion === undefined) return;
      this.failures.set(runId, { eventVersion });
      try {
        this.onRunIncident({ runId, source: "execution", error });
      } catch {}
    });
  }

  private async controlWithShortSession(intent: RuntimeControlIntent): Promise<Result<RuntimeControlResult, RunSessionControlFailure>> {
    const existing = this.store.getRun(intent.runId);
    if (!existing) return err({ type: "run-not-found", runId: intent.runId, message: `Run '${intent.runId}' was not found.` });
    const claim = this.store.scheduler.claimRun(
      intent.runId,
      `runtime-authority:${this.runtimeAuthorityOwnerId}:${intent.runId}:control`,
      30_000,
    );
    if (!claim) {
      return err({ type: "run-not-controllable", runId: intent.runId, message: `Control '${intent.type}' could not be applied to run '${intent.runId}'.` });
    }
    let result: RuntimeControlResult;
    let reopened = false;
    try {
      if (intent.type === "fork") return await this.fork(intent);
      const applied = applySchedulerControlIntent(this.store, controlIntent(intent), claim.ownerEpoch);
      if (applied.isErr()) return err(applied.error);
      const control = applied.value;
      reopened = control.reopened;
      if (control.observationFence) {
        await this.store.observationLog.markFenced(control.observationFence).catch(() => {});
      }
      this.triggerHooks(intent.runId);
      const run = this.store.getRun(intent.runId);
      if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
      result = daemonControlResult(control.effect, run);
    } finally {
      this.store.scheduler.releaseRun(claim);
    }
    if ((continuesAfterShortControl(intent) || reopened)
      && !this.sessions.has(intent.runId)
      && !isTerminal(result.run.status)) {
      this.start(intent.runId);
    }
    return ok(result);
  }

  private async fork(intent: Extract<RuntimeControlIntent, { type: "fork" }>): Promise<Result<RuntimeControlResult, RunSessionControlFailure>> {
    const fork = await this.store.forkRun(intent.runId, {
      requestId: intent.requestId,
      ...(intent.target === undefined ? {} : { target: intent.target }),
      ...(intent.prepared === undefined ? {} : { prepared: intent.prepared }),
      ...(intent.input === undefined ? {} : { input: intent.input }),
      ...(intent.agentOverrides === undefined ? {} : { agentOverrides: intent.agentOverrides }),
    });
    if (fork.isErr()) return err(fork.error);
    if (fork.value.forkCreated) this.triggerHooks(fork.value.id);
    const run = this.store.getRun(fork.value.id);
    if (!run) throw new Error(`Fork run '${fork.value.id}' was not found.`);
    return ok({ type: "fork", state: "applied", sourceRunId: intent.runId, run });
  }

  private triggerHooks(runId: string): void {
    this.dispatchHooks(runId);
  }

  private shouldDispatchHooks(runId: string): boolean {
    const failure = this.hookFailures.get(runId);
    if (!failure) return true;
    const eventVersion = this.store.getRunEventVersion(runId);
    if (eventVersion === undefined) {
      this.hookFailures.delete(runId);
      return false;
    }
    if (eventVersion === failure.eventVersion) return false;
    this.hookFailures.delete(runId);
    return true;
  }

  private recordHookIncident(runId: string, error: unknown): void {
    const eventVersion = this.store.getRunEventVersion(runId);
    if (eventVersion === undefined || this.hookFailures.get(runId)?.eventVersion === eventVersion) return;
    this.hookFailures.set(runId, { eventVersion });
    try {
      this.onRunIncident({ runId, source: "hook", error });
    } catch {}
  }
}

function continuesAfterShortControl(intent: RuntimeControlIntent): boolean {
  return intent.type === "signal"
    || intent.type === "steer"
    || intent.type === "cancel" && intent.target !== undefined;
}

function controlIntent(intent: RuntimeControlIntent): RunControlIntent {
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
  if (intent.type === "steer") {
    return {
      requestId: intent.requestId,
      runId: intent.runId,
      type: "steer",
      target: intent.target,
      instruction: intent.instruction,
    };
  }
  throw new Error(`Unsupported active control '${intent.type}'.`);
}

function daemonControlResult(effect: SchedulerControlEffect, run: RunDetails): RuntimeControlResult {
  if (effect.type === "pause") return { ...effect, run };
  if (effect.type === "resume") return { ...effect, run };
  if (effect.type === "retry") return { ...effect, run };
  if (effect.type === "cancel") return { ...effect, run };
  if (effect.type === "steer") return { ...effect, run };
  if (effect.type === "signal") return { ...effect, run };
  return assertNever(effect);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler control effect: ${String(value)}`);
}

function isTerminal(status: RunDetails["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
