import type {
  InspectionView,
} from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RuntimePool } from "./runtime-pool.js";
import type {
  OpenedWorkspaceRuntime,
  RuntimePoolOpenFailure,
} from "./runtime-pool.js";
import {
  type AdmittedRunLink,
  type RunLink,
  type StoredNotice,
  type SupervisorStateStore,
} from "./run-links.js";
import {
  isParkedProjection,
  isTerminalProjection,
  projectStoredRun,
  type StoredRunProjection,
} from "./run-projection.js";
import { deriveNotice, userControlMessage } from "./notices.js";
import type {
  ParentSessionAgentAdapter,
} from "./session-agent.js";

type RevisionPulse = {
  revision: number;
  deferred: Deferred.Deferred<void, Error>;
};

const SUPERVISION_DISPOSED = new Error("Acpus supervision was disposed.");

export type SupervisionOptions = {
  runtimes: RuntimePool;
  store: SupervisorStateStore;
  admit: (
    admissionRequestId: string,
    run: { id: string; name: string },
  ) => Effect.Effect<AdmittedRunLink, Error>;
  notices?: ParentSessionAgentAdapter;
  report?: (error: unknown, context: string) => void;
};

export function makeAcpusSupervision(
  options: SupervisionOptions,
): Effect.Effect<AcpusSupervision, never, Scope.Scope> {
  return AcpusSupervision.make(options);
}

export class AcpusSupervision {
  static make(
    options: SupervisionOptions,
  ): Effect.Effect<AcpusSupervision, never, Scope.Scope> {
    return Effect.gen(function* () {
      const reconciliations = yield* FiberMap.make<string, void, Error>();
      const observers = yield* FiberMap.make<string, void, Error>();
      const notices = yield* FiberSet.make<void, Error>();
      const ready = yield* Deferred.make<void, Error>();
      const supervision = new AcpusSupervision(
        options,
        reconciliations,
        observers,
        notices,
        ready,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => supervision.closePulses()));
      yield* supervision.startupReconciliation().pipe(
        Effect.catchCause(cause => supervision.reportCause(cause, "startup reconciliation")),
        Effect.andThen(Deferred.succeed(ready, undefined)),
        Effect.forkScoped,
      );
      return supervision;
    });
  }

  private readonly admission = Semaphore.makeUnsafe(1);
  private readonly closingObservers = new Set<string>();
  private readonly activityPulses = new Map<string, RevisionPulse>();
  private closed = false;

  private constructor(
    private readonly options: SupervisionOptions,
    private readonly reconciliations: FiberMap.FiberMap<string, void, Error>,
    private readonly observers: FiberMap.FiberMap<string, void, Error>,
    private readonly noticeFibers: FiberSet.FiberSet<void, Error>,
    private readonly ready: Deferred.Deferred<void, Error>,
  ) {}

  whenReady(): Effect.Effect<void, Error> {
    return Deferred.await(this.ready);
  }

  reconcileRun(link: RunLink): Effect.Effect<void, Error> {
    if (!isAdmittedRunLink(link)) return Effect.void;
    const supervision = this;
    const key = runKey(link);
    return this.admission.withPermit(Effect.suspend(() => {
      const current = FiberMap.getUnsafe(supervision.reconciliations, key);
      if (Option.isSome(current)) return Effect.succeed(current.value);
      return FiberMap.run(
        supervision.reconciliations,
        key,
        supervision.reconcile(link),
      );
    })).pipe(Effect.flatMap(Fiber.join));
  }

  openLinkedRuntime(
    link: RunLink,
  ): Effect.Effect<OpenedWorkspaceRuntime, RuntimePoolOpenFailure | Error> {
    const supervision = this;
    return Effect.gen(function* () {
      const opened = yield* Effect.result(supervision.options.runtimes.open(link.workspace));
      const detectedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const unavailable = Result.isFailure(opened) ? {
        reason: opened.failure.type,
        detail: opened.failure.message,
        detectedAt,
      } : undefined;
      const committed = yield* supervision.options.store.setRunUnavailable({
        link,
        ...(unavailable === undefined ? {} : { unavailable }),
      });
      if (committed.changed) {
        supervision.wakeSession(link.parentSessionId, committed.revision);
      }
      return yield* Effect.fromResult(opened);
    });
  }

  waitForActivityRevision(
    sessionId: string,
    afterRevision: number,
  ): Effect.Effect<void, Error> {
    const supervision = this;
    return Effect.gen(function* () {
      if (supervision.closed) return yield* Effect.fail(SUPERVISION_DISPOSED);
      const current = yield* supervision.options.store.readSession(sessionId);
      if (current.revision !== afterRevision) return;
      const pulse = yield* Effect.suspend(() => {
        if (supervision.closed) return Effect.fail(SUPERVISION_DISPOSED);
        const existing = supervision.activityPulses.get(sessionId);
        if (existing !== undefined && existing.revision !== afterRevision) {
          return Effect.succeed(undefined);
        }
        if (existing !== undefined) return Effect.succeed(existing.deferred);
        const deferred = Deferred.makeUnsafe<void, Error>();
        supervision.activityPulses.set(sessionId, { revision: afterRevision, deferred });
        return Effect.succeed(deferred);
      });
      if (pulse !== undefined) yield* Deferred.await(pulse);
    });
  }

  private startupReconciliation(): Effect.Effect<void, Error> {
    const supervision = this;
    return this.options.store.listReconciliationLinks().pipe(Effect.flatMap(links =>
      Effect.forEach(
        links,
        link => supervision.reconcileStartupLink(link).pipe(
          Effect.catchCause(cause => supervision.reportCause(
            cause,
            `startup reconciliation for ${link.runId ?? link.admissionRequestId}`,
          )),
        ),
        { concurrency: "unbounded", discard: true },
      )));
  }

  private reconcileStartupLink(link: RunLink): Effect.Effect<void, Error> {
    if (link.runId !== undefined) {
      return this.reconcileRun(link);
    }
    const supervision = this;
    return Effect.gen(function* () {
      const opened = yield* Effect.result(supervision.openLinkedRuntime(link));
      if (Result.isFailure(opened)) return;
      const admission = yield* Effect.result(
        opened.success.runtime.findAdmission(link.admissionRequestId),
      );
      if (Result.isFailure(admission)) {
        return yield* Effect.fail(new Error(admission.failure.message));
      }
      if (admission.success === undefined) return;
      const admitted = yield* supervision.options.admit(
        link.admissionRequestId,
        admission.success,
      );
      yield* supervision.reconcileRun(admitted);
    });
  }

  private reconcile(link: AdmittedRunLink): Effect.Effect<void, Error> {
    const supervision = this;
    return Effect.gen(function* () {
      const opened = yield* Effect.result(supervision.openLinkedRuntime(link));
      if (Result.isFailure(opened)) return;
      const projection = yield* supervision.readProjection(opened.success.runtime, link);
      yield* supervision.commit(link, projection);
      yield* supervision.scheduleNoticeDelivery(link.parentSessionId);
      if (isTerminalProjection(projection) || isParkedProjection(projection)) return;
      yield* supervision.startObserver(opened.success.runtime, link);
    });
  }

  private startObserver(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
  ): Effect.Effect<void> {
    const supervision = this;
    const key = runKey(link);
    return Effect.gen(function* () {
      const current = FiberMap.getUnsafe(supervision.observers, key);
      if (Option.isSome(current)) {
        if (!supervision.closingObservers.has(key)) return;
        yield* Fiber.await(current.value);
        if (FiberMap.hasUnsafe(supervision.observers, key)) return;
      }
      const observer = supervision.observe(runtime, link, key).pipe(
        Effect.catchCause(cause => supervision.reportCause(
          cause,
          `observer for run ${link.runId}`,
        )),
        Effect.ensuring(Effect.sync(() => supervision.closingObservers.delete(key))),
      );
      yield* FiberMap.run(supervision.observers, key, observer, { onlyIfMissing: true });
    });
  }

  private observe(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
    key: string,
  ): Effect.Effect<void, Error> {
    const supervision = this;
    return Effect.scoped(Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      const observations = runtime.observeInspection({
        view: { kind: "run", runId: link.runId, structure: "materialized" },
        until: "decision-boundary",
        updates: "activity",
      }, signal).pipe(
        Stream.map(value => ({ type: "value" as const, value })),
        Stream.catch(failure => Stream.succeed({ type: "failure" as const, failure })),
      );
      yield* Stream.runForEachWhile(observations, observed => {
        if (observed.type === "failure") {
          return Effect.sync(() => {
            supervision.report(
              new Error(observed.failure.message),
              `Runtime observation for run ${link.runId}`,
            );
            return false;
          });
        }
        return Effect.gen(function* () {
          const value = observed.value;
          const view = value.kind === "update"
            ? yield* supervision.readRunView(runtime, link.runId)
            : value.view;
          if (view.kind !== "run") {
            return yield* Effect.fail(
              new Error(`Run '${link.runId}' returned an unexpected observation view.`),
            );
          }
          const projection = projectStoredRun(link, view);
          const closing = isTerminalProjection(projection)
            || isParkedProjection(projection)
            || value.kind === "closed";
          if (closing) supervision.closingObservers.add(key);
          yield* supervision.commit(link, projection);
          yield* supervision.scheduleNoticeDelivery(link.parentSessionId);
          return !closing;
        });
      });
    }));
  }

  private readProjection(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
  ): Effect.Effect<StoredRunProjection, Error> {
    return this.readRunView(runtime, link.runId).pipe(
      Effect.map(view => projectStoredRun(link, view)),
    );
  }

  private readRunView(
    runtime: WorkspaceRuntime,
    runId: string,
  ): Effect.Effect<Extract<InspectionView, { kind: "run" }>, Error> {
    return Effect.result(runtime.inspect({
      kind: "run",
      runId,
      structure: "materialized",
    })).pipe(Effect.flatMap(inspected => {
      if (Result.isFailure(inspected)) {
        return Effect.fail(new Error(inspected.failure.message));
      }
      if (inspected.success.kind !== "run") {
        return Effect.fail(new Error(
          `Run '${runId}' returned an unexpected inspection view.`,
        ));
      }
      return Effect.succeed(inspected.success);
    }));
  }

  private commit(
    link: AdmittedRunLink,
    projection: StoredRunProjection,
  ): Effect.Effect<void, Error> {
    const derived = deriveNotice({
      runId: projection.runId,
      task: { name: link.workflowName, occurrence: link.occurrence },
      status: projection.status,
      updatedAt: projection.updatedAt,
      ...(projection.actionRequirement === undefined
        ? {}
        : {
            actionRequired: {
              kind: "signal",
              signal: projection.actionRequirement.selector,
              ...(projection.actionRequirement.prompt === undefined
                ? {}
                : { prompt: projection.actionRequirement.prompt }),
              ...(projection.actionRequirement.expected === undefined
                ? {}
                : { expected: projection.actionRequirement.expected }),
            },
          }),
      ...(projection.failure?.message === undefined
        ? {}
        : { terminalSummary: projection.failure.message }),
    });
    const notice = derived === undefined
      ? undefined
      : storedNotice(link, projection, derived.id);
    const supervision = this;
    return this.options.store.commitObservation({
      link,
      projection,
      ...(notice === undefined ? {} : { notice }),
    }).pipe(Effect.tap(committed => Effect.sync(() => {
      if (committed.wakeWaiters) {
        supervision.wakeSession(link.parentSessionId, committed.revision);
      }
    })), Effect.asVoid);
  }

  scheduleNoticeDelivery(sessionId?: string): Effect.Effect<void> {
    const delivery = this.deliverPendingNotices(sessionId).pipe(
      Effect.catchCause(cause => this.reportCause(cause, "attention delivery")),
    );
    return FiberSet.run(this.noticeFibers, delivery).pipe(Effect.asVoid);
  }

  private deliverPendingNotices(sessionId?: string): Effect.Effect<void, Error> {
    const adapter = this.options.notices;
    if (adapter === undefined) return Effect.void;
    const supervision = this;
    return this.options.store.pendingNotices().pipe(Effect.flatMap(notices => Effect.forEach(
      notices,
      notice => {
        if (sessionId !== undefined && notice.parentSessionId !== sessionId) return Effect.void;
        return Effect.tryPromise({
          try: () => adapter.deliver({
            id: notice.id,
            sessionId: notice.parentSessionId,
            message: noticeMessage(notice),
          }),
          catch: error => error instanceof Error ? error : new Error(String(error)),
        }).pipe(
          Effect.flatMap(delivered => delivered.delivered
            ? supervision.options.store.markNoticeDelivered(notice.id)
            : Effect.void),
          Effect.catchCause(cause => supervision.reportCause(cause, `notice ${notice.id}`)),
        );
      },
      { concurrency: 1, discard: true },
    )));
  }

  private wakeSession(sessionId: string, revision: number): void {
    if (this.closed) return;
    const current = this.activityPulses.get(sessionId);
    const next = Deferred.makeUnsafe<void, Error>();
    this.activityPulses.set(sessionId, { revision, deferred: next });
    if (current !== undefined) Deferred.doneUnsafe(current.deferred, Effect.void);
  }

  private closePulses(): void {
    if (this.closed) return;
    this.closed = true;
    Deferred.doneUnsafe(this.ready, Effect.fail(SUPERVISION_DISPOSED));
    for (const pulse of this.activityPulses.values()) {
      Deferred.doneUnsafe(pulse.deferred, Effect.fail(SUPERVISION_DISPOSED));
    }
    this.activityPulses.clear();
  }

  private report(error: unknown, context: string): void {
    (this.options.report ?? defaultReport)(error, context);
  }

  private reportCause<E>(cause: Cause.Cause<E>, context: string): Effect.Effect<void, E> {
    return Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.sync(() => this.report(Cause.squash(cause), context));
  }
}

function storedNotice(
  link: AdmittedRunLink,
  projection: StoredRunProjection,
  id: string,
): StoredNotice {
  const kind = isTerminalProjection(projection)
    ? projection.status as StoredNotice["kind"]
    : "signal";
  return {
    id,
    parentSessionId: link.parentSessionId,
    workspace: link.workspace,
    runId: link.runId,
    task: { name: link.workflowName, occurrence: link.occurrence },
    kind,
    projectionUpdatedAt: projection.updatedAt,
    ...(projection.actionRequirement === undefined
      ? {}
      : {
          signal: {
            selector: projection.actionRequirement.selector,
            ...(projection.actionRequirement.prompt === undefined
              ? {}
              : { prompt: projection.actionRequirement.prompt }),
            ...(projection.actionRequirement.expected === undefined
              ? {}
              : { expected: projection.actionRequirement.expected }),
          },
        }),
    ...(projection.failure?.message === undefined
      ? {}
      : { terminalSummary: projection.failure.message }),
  };
}

function noticeMessage(notice: StoredNotice) {
  if (notice.kind === "user-control") {
    const control = notice.control;
    if (control === undefined) throw new Error(`Stored Acpus notice '${notice.id}' has no control fact.`);
    return userControlMessage(notice.id, control.outcome === "applied"
      ? {
          kind: "acpus-control-event",
          actor: "user",
          operation: "cancel",
          task: notice.task,
          outcome: "applied",
          taskStatus: "canceled",
        }
      : {
          kind: "acpus-control-event",
          actor: "user",
          operation: "cancel",
          task: notice.task,
          outcome: "rejected",
          taskStatus: control.taskStatus,
          reason: control.reason ?? "temporarily-unavailable",
        });
  }
  const derived = deriveNotice({
    runId: notice.runId,
    task: notice.task,
    status: notice.kind === "signal" ? "awaiting" : notice.kind,
    updatedAt: notice.projectionUpdatedAt,
    ...(notice.signal === undefined
      ? {}
      : {
          actionRequired: {
            kind: "signal",
            signal: notice.signal.selector,
            ...(notice.signal.prompt === undefined ? {} : { prompt: notice.signal.prompt }),
            ...(notice.signal.expected === undefined ? {} : { expected: notice.signal.expected }),
          },
        }),
    ...(notice.terminalSummary === undefined
      ? {}
      : { terminalSummary: notice.terminalSummary }),
  });
  if (derived === undefined || derived.id !== notice.id) {
    throw new Error(`Stored Acpus notice '${notice.id}' is inconsistent.`);
  }
  return derived.message;
}

function runKey(link: AdmittedRunLink): string {
  return `${link.workspace}\0${link.runId}`;
}

function isAdmittedRunLink(link: RunLink): link is AdmittedRunLink {
  return link.runId !== undefined
    && link.workflowName !== undefined
    && link.occurrence !== undefined;
}

function defaultReport(error: unknown, context: string): void {
  console.error(`[acpus/dsh] ${context}:`, error);
}
