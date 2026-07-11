import type { JsonValue } from "@acpus/expression/ir";
import { advanceRuntimeRun, type RuntimeAdvanceResult } from "../runs/advance-runtime.js";
import type { RuntimeMutationInput, RuntimeMutationResult } from "../runs/use-cases.js";
import type { ActiveAttempt } from "../scheduler/advance.js";
import { applySchedulerControlIntentWithOwnerEpoch, type RunControlIntent } from "../scheduler/control.js";
import type { RunOwnerClaim } from "../scheduler/store-port.js";
import type { HookRunner } from "../hooks/runner.js";
import { triggerHooksForCommittedRowsForRun } from "../scheduler/runtime-runner.js";
import type { RunDetails, RuntimeStore } from "../store/store.js";
import { DaemonRequestError, type DaemonControlIntent } from "./socket.js";
import { CoalescingNodeProgressWriter } from "../progress/writer.js";

type ActiveRunSession = {
  promise?: Promise<RuntimeAdvanceResult>;
  claim?: RunOwnerClaim;
  ownerEpoch?: number;
  ownerEpochWaiters: Array<() => void>;
  activeAttempts: Map<string, AbortController>;
};

export class RunExecutionSessions {
  private readonly sessions = new Map<string, ActiveRunSession>();
  private readonly progressWriter: CoalescingNodeProgressWriter;

  constructor(private readonly cwd: string, private readonly store: RuntimeStore, private readonly hookRunner?: HookRunner) {
    this.progressWriter = new CoalescingNodeProgressWriter(store);
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
    for (const session of this.sessions.values()) {
      if (session.claim) this.store.scheduler.releaseRun(session.claim);
      for (const controller of session.activeAttempts.values()) controller.abort();
    }
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.sessions.values()].flatMap(session => session.promise ? [session.promise] : [])),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  start(runId: string): RunDetails {
    const existing = this.store.getRun(runId);
    if (!existing) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${runId}' was not found.`);
    if (!this.sessions.has(runId) && !isTerminal(existing.status)) {
      const session = createSession();
      this.sessions.set(runId, session);
      session.promise = this.run(runId);
    }
    return existing;
  }

  async control(intent: DaemonControlIntent): Promise<RuntimeMutationResult | undefined> {
    const session = this.sessions.get(intent.runId);
    if (!session) return this.controlWithShortSession(intent);
    if (intent.type === "fork") return await this.fork(intent);
    if (!session.ownerEpoch) {
      await Promise.race([waitForOwnerEpoch(session), session.promise]);
      if (!session.ownerEpoch) return undefined;
    }
    const eventCursor = this.store.getLastRunEventSequence(intent.runId);
    const result = applySchedulerControlIntentWithOwnerEpoch(this.store, controlIntent(intent), session.ownerEpoch);
    this.triggerHooks(intent.runId, eventCursor);
    if (intent.type === "pause" || intent.type === "cancel") {
      for (const controller of session.activeAttempts.values()) controller.abort();
    }
    const run = this.store.getRun(result.runId);
    if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${result.runId}' was not found.`);
    return { run };
  }

  private async controlWithShortSession(intent: DaemonControlIntent): Promise<RuntimeMutationResult> {
    const existing = this.store.getRun(intent.runId);
    if (!existing) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
    const claim = this.store.scheduler.claimRun(intent.runId, `daemon:${process.pid}:${intent.runId}:control`, 30_000);
    if (!claim) throw new DaemonRequestError("CONTROL_CONFLICT", `Run '${intent.runId}' is currently controlled by another owner.`);
    const session = createSession();
    session.claim = claim;
    session.ownerEpoch = claim.ownerEpoch;
    this.sessions.set(intent.runId, session);
    try {
      if (intent.type === "fork") return await this.fork(intent);
      const eventCursor = this.store.getLastRunEventSequence(intent.runId);
      const result = applySchedulerControlIntentWithOwnerEpoch(this.store, controlIntent(intent), claim.ownerEpoch);
      this.triggerHooks(intent.runId, eventCursor);
      const run = this.store.getRun(result.runId);
      if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${result.runId}' was not found.`);
      return { run };
    } finally {
      this.store.scheduler.releaseRun(claim);
      if (this.sessions.get(intent.runId) === session) this.sessions.delete(intent.runId);
    }
  }

  private async fork(intent: Extract<DaemonControlIntent, { type: "fork" }>): Promise<RuntimeMutationResult> {
    const fork = await this.store.forkRun(intent.runId, { ...(intent.input ?? {}), requestId: intent.requestId });
    if (fork.forkCreated) this.triggerHooks(fork.id, 0);
    const run = this.store.getRun(intent.runId);
    if (!run) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
    return { run, forkRunId: fork.id };
  }

  private triggerHooks(runId: string, afterSequence: number): void {
    triggerHooksForCommittedRowsForRun({
      cwd: this.cwd,
      store: this.store,
      runId,
      ...(this.hookRunner === undefined ? {} : { hookRunner: this.hookRunner }),
      afterSequence,
    });
  }

  private async run(runId: string): Promise<RuntimeAdvanceResult> {
    const session = this.sessions.get(runId);
    try {
      return await advanceRuntimeRun(this.cwd, this.store, runId, `daemon:${process.pid}:${runId}`, undefined, {
        onClaim: claim => {
          if (claim.runId === runId && session) {
            session.claim = claim;
            session.ownerEpoch = claim.ownerEpoch;
            resolveOwnerEpochWaiters(session);
          }
        },
        onRelease: claim => {
          if (claim.runId === runId && session?.ownerEpoch === claim.ownerEpoch) {
            delete session.claim;
            delete session.ownerEpoch;
          }
        },
        onActiveAttempt: attempt => {
          if (attempt.runId !== runId || !session) return undefined;
          const dispose = trackActiveAttempt(session, attempt);
          return () => {
            this.progressWriter.flushMatching(progress => progress.runId === attempt.runId && progress.nodeKey === attempt.nodeKey);
            dispose();
          };
        },
        ...(this.hookRunner === undefined ? {} : { hookRunner: this.hookRunner }),
        progressWriter: this.progressWriter,
      });
    } finally {
      this.progressWriter.flushMatching(progress => progress.runId === runId);
      if (session) resolveOwnerEpochWaiters(session);
      if (this.sessions.get(runId) === session) this.sessions.delete(runId);
    }
  }
}

function createSession(): ActiveRunSession {
  return { ownerEpochWaiters: [], activeAttempts: new Map() };
}

function waitForOwnerEpoch(session: ActiveRunSession): Promise<void> {
  if (session.ownerEpoch) return Promise.resolve();
  return new Promise(resolve => session.ownerEpochWaiters.push(resolve));
}

function resolveOwnerEpochWaiters(session: ActiveRunSession): void {
  const waiters = session.ownerEpochWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function trackActiveAttempt(session: ActiveRunSession, attempt: ActiveAttempt): () => void {
  session.activeAttempts.set(attempt.nodeKey, attempt.controller);
  return () => {
    if (session.activeAttempts.get(attempt.nodeKey) === attempt.controller) session.activeAttempts.delete(attempt.nodeKey);
  };
}

function controlIntent(intent: DaemonControlIntent): RunControlIntent {
  if (intent.type === "signal") {
    return {
      requestId: intent.requestId,
      runId: intent.runId,
      type: "signal",
      node: intent.nodeId,
      payload: intent.payload as JsonValue,
      commandIdempotencyKey: intent.requestId,
    };
  }
  const input = intent.input as RuntimeMutationInput | undefined;
  if (intent.type === "pause") return { requestId: intent.requestId, runId: intent.runId, type: "pause" };
  if (intent.type === "resume") return { requestId: intent.requestId, runId: intent.runId, type: "resume" };
  if (intent.type === "retry") return { requestId: intent.requestId, runId: intent.runId, type: "retry", ...(input?.target ? { target: input.target } : {}) };
  if (intent.type === "cancel") return { requestId: intent.requestId, runId: intent.runId, type: "cancel", ...(input?.target ? { target: input.target } : {}) };
  throw new Error(`Unsupported active control '${intent.type}'.`);
}

function isTerminal(status: RunDetails["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
