import { applySchedulerControlIntent, type RunControlIntent, type SchedulerControlEffect, type SchedulerControlFailure, type SchedulerControlResult } from "../scheduler/control.js";
import {
  createRuntimeRunScheduler,
  type RunExecution,
  type RunExecutionExit,
  type RunExecutionFailure,
  type RuntimeRunScheduler,
} from "../scheduler/runtime-runner.js";
import { dispatchCommittedHooksForRun } from "../hooks/dispatch.js";
import type { HookRunner } from "../hooks/runner.js";
import type { ForkRunFailure, RunDetails, RuntimeStoreAdapter } from "../store/store.js";
import {
  makeRuntimeStoreService,
  type RuntimeStoreBusy,
  type RuntimeStoreShape,
} from "../store/service.js";
import type { RuntimeControlIntent, RuntimeControlResult } from "../runtime-contracts.js";
import { CoalescingNodeProgressWriter } from "../progress/writer.js";
import type { RuntimeConfiguration } from "../configuration.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type { ProcessHostShape } from "@acpus/owned-process";
import { randomUUID } from "node:crypto";
import { AgentTurnExecutionRegistry, type AgentTurnProof } from "../execution/agent-turn-registry.js";
import { schedulerStoreError, type SchedulerStoreError } from "../scheduler/store-port.js";

type ActiveRunSession = {
  execution: RunExecution;
  fiber: Fiber.Fiber<Result.Result<RunExecutionExit, RunExecutionFailure>>;
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
  | RuntimeStoreBusy
  | ForkRunFailure
  | { type: "run-not-controllable"; runId: string; message: string }
  | { type: "agent-session-neutralization-failed"; runId: string; message: string };

export class RunExecutionSessions {
  private readonly sessions = new Map<string, ActiveRunSession>();
  private readonly failures = new Map<string, IncidentFence>();
  private readonly hookFailures = new Map<string, IncidentFence>();
  private readonly progressWriter: CoalescingNodeProgressWriter;
  private readonly scheduler: RuntimeRunScheduler;
  private readonly agentTurnRegistry = new AgentTurnExecutionRegistry();
  private readonly runtimeStore: RuntimeStoreShape;

  constructor(
    private readonly cwd: string,
    private readonly store: RuntimeStoreAdapter,
    private readonly hookRunner: HookRunner | undefined,
    runtimeConfiguration: RuntimeConfiguration,
    processes: ProcessHostShape,
    private readonly scope: Scope.Scope,
    private readonly onRunIncident: (incident: RunIncident) => void = () => undefined,
    private readonly agentSessionSupervisor?: AgentSessionSupervisor,
    runtimeOwnerEpoch = 0,
    private readonly runtimeAuthorityOwnerId = randomUUID(),
  ) {
    this.runtimeStore = makeRuntimeStoreService(store);
    this.progressWriter = new CoalescingNodeProgressWriter(store);
    this.scheduler = createRuntimeRunScheduler({
      cwd,
      store,
      maxLeafConcurrency: runtimeConfiguration.runMaxLeafConcurrency,
      agentHostPolicy: runtimeConfiguration.agentHostPolicy,
      processes,
      runtimeOwnerEpoch,
      ...(agentSessionSupervisor === undefined ? {} : { agentSessionSupervisor }),
      agentTurnRegistry: this.agentTurnRegistry,
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

  provesAgentTurn(proof: AgentTurnProof): boolean {
    return this.agentTurnRegistry.proves(proof);
  }

  drainHooks(): Effect.Effect<void> {
    return this.hookRunner?.drain() ?? Effect.void;
  }

  dispatchHooks(runId: string): Effect.Effect<"dispatched" | "retry" | "quarantined"> {
    if (!this.shouldDispatchHooks(runId)) return Effect.succeed("quarantined");
    return Effect.sync(() => {
      const result = dispatchCommittedHooksForRun({
        cwd: this.cwd,
        store: this.store,
        runId,
        ...(this.hookRunner === undefined ? {} : { hookRunner: this.hookRunner }),
      });
      return Result.isFailure(result) ? "retry" as const : "dispatched" as const;
    }).pipe(
        Effect.catchCause(cause => Effect.sync(() => {
          this.recordHookIncident(runId, Cause.squash(cause));
          return "quarantined" as const;
        })),
      );
  }

  stopExecutors(timeoutMs: number): Effect.Effect<void> {
    const entries = [...this.sessions.entries()];
    for (const [, session] of entries) session.fiber.interruptUnsafe();
    return Fiber.awaitAll(entries.map(([, session]) => session.fiber)).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.succeed(undefined),
      }),
      Effect.tap(exits => Effect.sync(() => {
        if (exits === undefined) return;
        for (const [runId, session] of entries) {
          if (this.sessions.get(runId) === session) this.sessions.delete(runId);
        }
      })),
      Effect.asVoid,
    );
  }

  start(runId: string): Effect.Effect<RunSessionStart, RuntimeStoreBusy> {
    const sessions = this;
    return Effect.gen(function* () {
      const existing = yield* sessions.runtimeStore.getRun(runId);
      if (!existing) throw new Error(`Run '${runId}' was not found.`);
      if (isTerminal(existing.status)) {
        sessions.failures.delete(runId);
        return { disposition: "terminal" as const, run: existing };
      }
      const eventVersion = yield* sessions.runtimeStore.getRunEventVersion(runId);
      if (eventVersion === undefined) throw new Error(`Run '${runId}' was not found.`);
      const failure = sessions.failures.get(runId);
      if (failure?.eventVersion === eventVersion) {
        return { disposition: "quarantined" as const, run: existing };
      }
      if (failure) sessions.failures.delete(runId);
      if (sessions.sessions.has(runId)) {
        return { disposition: "already-active" as const, run: existing };
      }
      yield* sessions.startExecution(runId);
      return { disposition: "started" as const, run: existing };
    });
  }

  control(intent: RuntimeControlIntent): Effect.Effect<RuntimeControlResult, RunSessionControlFailure> {
    if (intent.type === "fork") return this.fork(intent);
    return this.controlResult(intent);
  }

  private controlResult(
    intent: Exclude<RuntimeControlIntent, { type: "fork" }>,
  ): Effect.Effect<RuntimeControlResult, RunSessionControlFailure> {
    const sessions = this;
    return Effect.gen(function* () {
      const session = sessions.sessions.get(intent.runId);
      if (!session) return yield* sessions.controlWithShortSession(intent);

      const ownerEpoch = yield* session.execution.ownerEpoch;
      if (ownerEpoch === undefined) {
        return yield* Effect.fail({
          type: "run-not-controllable" as const,
          runId: intent.runId,
          message: `Control '${intent.type}' could not be applied to run '${intent.runId}'.`,
        });
      }
      const control = yield* intent.type === "retry"
        ? sessions.applyRetry(intent, ownerEpoch)
        : sessions.applyControl(intent, ownerEpoch);
      const { effect, reopened } = control;
      if (control.observationFence) {
        yield* sessions.runtimeStore.observationLog.markFenced(control.observationFence).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      session.execution.wake();

      const restartsSession = reopened;
      const endsSession = intent.type === "pause" || intent.type === "cancel" && intent.target === undefined;
      if (restartsSession) session.fiber.interruptUnsafe();
      if (restartsSession || endsSession) {
        yield* Fiber.await(session.fiber);
        if (sessions.sessions.get(intent.runId) === session) sessions.sessions.delete(intent.runId);
      }

      const run = yield* sessions.runtimeStore.getRun(intent.runId);
      if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
      if (restartsSession && !sessions.sessions.has(intent.runId)) yield* sessions.startExecution(intent.runId);
      return daemonControlResult(effect, run);
    });
  }

  private startExecution(runId: string): Effect.Effect<void> {
    const sessions = this;
    return Effect.gen(function* () {
      yield* sessions.progressWriter.start(sessions.scope);
      sessions.failures.delete(runId);
      const execution = sessions.scheduler.start({
        runId,
        ownerId: `runtime-authority:${sessions.runtimeAuthorityOwnerId}:${runId}`,
      });
      let session!: ActiveRunSession;
      const observed = execution.result.pipe(
        Effect.tapCause(cause => Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => {
            const eventVersion = sessions.store.getRunEventVersion(runId);
            if (eventVersion === undefined) return;
            sessions.failures.set(runId, { eventVersion });
            try {
              sessions.onRunIncident({ runId, source: "execution", error: Cause.squash(cause) });
            } catch {}
          })),
        Effect.ensuring(Effect.sync(() => {
          sessions.progressWriter.flushMatching(progress => progress.runId === runId);
          if (sessions.sessions.get(runId) === session) sessions.sessions.delete(runId);
        })),
      );
      const fiber = yield* Effect.forkIn(observed, sessions.scope, { startImmediately: false });
      session = { execution, fiber };
      sessions.sessions.set(runId, session);
    });
  }

  private controlWithShortSession(
    intent: Exclude<RuntimeControlIntent, { type: "fork" }>,
  ): Effect.Effect<RuntimeControlResult, RunSessionControlFailure> {
    const sessions = this;
    return Effect.gen(function* () {
      const existing = yield* sessions.runtimeStore.getRun(intent.runId);
      if (!existing) {
        return yield* Effect.fail({
          type: "run-not-found" as const,
          runId: intent.runId,
          message: `Run '${intent.runId}' was not found.`,
        });
      }
      const claim = yield* sessions.runtimeStore.scheduler.claimRun(
        intent.runId,
        `runtime-authority:${sessions.runtimeAuthorityOwnerId}:${intent.runId}:control`,
        30_000,
      );
      if (!claim) {
        return yield* Effect.fail({
          type: "run-not-controllable" as const,
          runId: intent.runId,
          message: `Control '${intent.type}' could not be applied to run '${intent.runId}'.`,
        });
      }
      const settled = yield* Effect.acquireUseRelease(
        Effect.succeed(claim),
        ownedClaim => Effect.gen(function* () {
          const control = yield* intent.type === "retry"
            ? sessions.applyRetry(intent, ownedClaim.ownerEpoch)
            : sessions.applyControl(intent, ownedClaim.ownerEpoch);
          if (control.observationFence) {
            yield* sessions.runtimeStore.observationLog.markFenced(control.observationFence).pipe(
              Effect.catch(() => Effect.void),
            );
          }
          yield* sessions.triggerHooks(intent.runId);
          const run = yield* sessions.runtimeStore.getRun(intent.runId);
          if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
          return { result: daemonControlResult(control.effect, run), reopened: control.reopened };
        }),
        ownedClaim => sessions.runtimeStore.scheduler.releaseRun(ownedClaim),
      );
      if (!sessions.sessions.has(intent.runId)) {
        if (settled.reopened) yield* sessions.startExecution(intent.runId);
        else if (continuesAfterShortControl(intent) && !isTerminal(settled.result.run.status)) {
          yield* sessions.start(intent.runId);
        }
      }
      return settled.result;
    });
  }

  private applyRetry(
    intent: Extract<RuntimeControlIntent, { type: "retry" }>,
    ownerEpoch: number,
  ): Effect.Effect<SchedulerControlResult, RunSessionControlFailure> {
    const sessions = this;
    return Effect.scoped(Effect.gen(function* () {
    const idempotencyKey = `scheduler:control:${intent.requestId}`;
    const planned = yield* sessions.runtimeStore.scheduler.tryPlanRetry({
      runId: intent.runId,
      idempotencyKey,
      target: intent.target,
    });
    if (planned.duplicate) {
      return {
        snapshot: planned.snapshot,
        reopened: false,
        effect: { type: "retry", state: "applied", target: intent.target } as const,
      };
    }
    if (planned.sessions.length > 0 && !sessions.agentSessionSupervisor) {
      return yield* Effect.fail({
        type: "agent-session-neutralization-failed" as const,
        runId: intent.runId,
        message: "Agent Session supervisor is unavailable.",
      });
    }
    const commit = (neutralizedAgentSessionIds: readonly string[]) => sessions.runtimeStore.scheduler.tryCommitRetry({
      runId: intent.runId,
      ownerEpoch,
      expectedVersion: planned.snapshot.version,
      idempotencyKey,
      target: intent.target,
      neutralizedAgentSessionIds,
    });
    if (planned.sessions.length === 0) {
      const committed = yield* commit([]);
      return {
        snapshot: committed,
        reopened: committed.version > planned.snapshot.version,
        effect: { type: "retry", state: "applied", target: intent.target } as const,
      };
    }
    const signal = yield* Effect.abortSignal;
    const committed = yield* sessions.agentSessionSupervisor!.withSessionsNeutralized(
      { sessions: planned.sessions, signal },
      evidence => captureSchedulerFailure(() => sessions.store.scheduler.tryCommitRetry({
        runId: intent.runId,
        ownerEpoch,
        expectedVersion: planned.snapshot.version,
        idempotencyKey,
        target: intent.target,
        neutralizedAgentSessionIds: evidence.map(item => item.session.agentSessionId),
      })),
    ).pipe(Effect.mapError(failure => {
      if (failure.type === "commit") return failure.error;
      const message = failure.type === "acquire"
        ? failure.error.message
        : failure.type === "neutralize"
          ? failure.errors.map(error => error.message).join("; ")
          : failure.message;
      return { type: "agent-session-neutralization-failed" as const, runId: intent.runId, message };
    }));
    return {
      snapshot: committed,
      reopened: committed.version > planned.snapshot.version,
      effect: { type: "retry", state: "applied", target: intent.target } as const,
    };
    }));
  }

  private applyControl(
    intent: Exclude<RuntimeControlIntent, { type: "retry" | "fork" }>,
    ownerEpoch: number,
  ): Effect.Effect<SchedulerControlResult, RunSessionControlFailure> {
    if (intent.type !== "steer") {
      return applySchedulerControlIntent(this.runtimeStore, controlIntent(intent), ownerEpoch);
    }
    const sessions = this;
    return Effect.gen(function* () {
      const planned = yield* sessions.runtimeStore.scheduler.tryPlanAgentSteer(intent.runId, intent.target);
      const execution = sessions.agentTurnRegistry.get(planned.attemptId);
      const proof = execution?.runId === planned.runId
        && execution.nodeKey === planned.nodeKey
        ? {
            agentSessionId: execution.agentSessionId,
            attemptId: execution.attemptId,
            turnId: execution.turnId,
            sessionLeaseId: execution.sessionLeaseId,
          }
        : undefined;
      const applied = yield* applySchedulerControlIntent(
        sessions.runtimeStore,
        controlIntent(intent),
        ownerEpoch,
        proof,
      );
      if (execution) execution.abort("steer");
      return applied;
    });
  }

  private fork(
    intent: Extract<RuntimeControlIntent, { type: "fork" }>,
  ): Effect.Effect<RuntimeControlResult, RunSessionControlFailure> {
    const sessions = this;
    return Effect.gen(function* () {
      const fork = yield* sessions.runtimeStore.forkRun(intent.runId, {
        requestId: intent.requestId,
        ...(intent.target === undefined ? {} : { target: intent.target }),
        ...(intent.prepared === undefined ? {} : { prepared: intent.prepared }),
        ...(intent.input === undefined ? {} : { input: intent.input }),
        ...(intent.agentInjections === undefined ? {} : { agentInjections: intent.agentInjections }),
      });
      if (fork.forkCreated) yield* sessions.triggerHooks(fork.id);
      const run = yield* sessions.runtimeStore.getRun(fork.id);
      if (!run) throw new Error(`Fork run '${fork.id}' was not found.`);
      return { type: "fork" as const, state: "applied" as const, sourceRunId: intent.runId, run };
    });
  }

  private triggerHooks(runId: string): Effect.Effect<void> {
    return this.dispatchHooks(runId).pipe(Effect.asVoid);
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

function captureSchedulerFailure<Success>(
  operation: () => Success,
): Result.Result<Success, SchedulerStoreError> {
  try {
    return Result.succeed(operation());
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (failure) return Result.fail(failure);
    throw error;
  }
}

function continuesAfterShortControl(intent: RuntimeControlIntent): boolean {
  return intent.type === "signal"
    || intent.type === "steer"
    || intent.type === "cancel" && intent.target !== undefined;
}

function controlIntent(intent: Exclude<RuntimeControlIntent, { type: "retry" | "fork" }>): RunControlIntent {
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
