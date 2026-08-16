import type {
  InspectionView,
} from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import type { RuntimePool } from "./runtime-pool.js";
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

type RevisionWaiter = {
  afterRevision: number;
  resolve(): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  abort(): void;
};

export type SupervisionOptions = {
  runtimes: RuntimePool;
  store: SupervisorStateStore;
  admit: (
    admissionRequestId: string,
    run: { id: string; name: string },
  ) => Promise<AdmittedRunLink>;
  notices?: ParentSessionAgentAdapter;
  report?: (error: unknown, context: string) => void;
};

export class AcpusSupervision {
  private readonly observers = new Map<string, {
    controller: AbortController;
    task: Promise<void>;
    closing: boolean;
  }>();
  private readonly reconciliations = new Map<string, Promise<void>>();
  private readonly activityWaiters = new Map<string, Set<RevisionWaiter>>();
  private startupTask: Promise<void> = Promise.resolve();
  private started = false;
  private disposed = false;

  constructor(private readonly options: SupervisionOptions) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startupTask = this.startupReconciliation().catch(error =>
      this.report(error, "startup reconciliation"));
  }

  async whenReady(): Promise<void> {
    await this.startupTask;
  }

  async reconcileRun(link: RunLink): Promise<void> {
    if (this.disposed || link.runId === undefined) return;
    if (!isAdmittedRunLink(link)) return;
    const admittedLink = link;
    const key = runKey(admittedLink);
    const current = this.reconciliations.get(key) ?? Promise.resolve();
    const pending = current.then(
      () => this.reconcile(admittedLink),
      () => this.reconcile(admittedLink),
    ).finally(() => {
      if (this.reconciliations.get(key) === pending) {
        this.reconciliations.delete(key);
      }
    });
    this.reconciliations.set(key, pending);
    return pending;
  }

  async waitForActivityRevision(
    sessionId: string,
    afterRevision: number,
    signal: AbortSignal,
  ): Promise<void> {
    return this.waitForRevision(
      this.activityWaiters,
      sessionId,
      afterRevision,
      signal,
      () => true,
    );
  }

  private async waitForRevision(
    registry: Map<string, Set<RevisionWaiter>>,
    sessionId: string,
    afterRevision: number,
    signal: AbortSignal,
    shouldWake: (runs: readonly StoredRunProjection[]) => boolean,
  ): Promise<void> {
    if (this.disposed) throw new Error("Acpus supervision was disposed.");
    signal.throwIfAborted();
    const current = await this.options.store.readSession(sessionId);
    if (current.revision !== afterRevision && shouldWake(current.runs)) return;
    if (this.disposed) throw new Error("Acpus supervision was disposed.");
    let registered: RevisionWaiter | undefined;
    await new Promise<void>((resolve, reject) => {
      const waiters = registry.get(sessionId) ?? new Set<RevisionWaiter>();
      const waiter: RevisionWaiter = {
        afterRevision,
        resolve,
        reject,
        signal,
        abort: () => reject(signal.reason),
      };
      registered = waiter;
      waiters.add(waiter);
      registry.set(sessionId, waiters);
      signal.addEventListener("abort", waiter.abort, { once: true });
      void this.options.store.readSession(sessionId).then(latest => {
        if (latest.revision !== afterRevision && shouldWake(latest.runs)) resolve();
      }, reject);
    }).finally(() => {
      const waiters = registry.get(sessionId);
      if (waiters === undefined || registered === undefined) return;
      registered.signal.removeEventListener("abort", registered.abort);
      waiters.delete(registered);
      if (waiters.size === 0) registry.delete(sessionId);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const observer of this.observers.values()) observer.controller.abort();
    for (const registry of [this.activityWaiters]) {
      for (const waiters of registry.values()) {
        for (const waiter of waiters) waiter.reject(new Error("Acpus supervision was disposed."));
      }
      registry.clear();
    }
    await Promise.allSettled([
      this.startupTask,
      ...[...this.observers.values()].map(observer => observer.task),
      ...this.reconciliations.values(),
    ]);
    this.observers.clear();
    this.reconciliations.clear();
  }

  private async startupReconciliation(): Promise<void> {
    const links = await this.options.store.listLinks();
    await Promise.all(links.map(async link => {
      try {
        await this.reconcileStartupLink(link);
      } catch (error) {
        this.report(
          error,
          `startup reconciliation for ${link.runId ?? link.admissionRequestId}`,
        );
      }
    }));
  }

  private async reconcileStartupLink(link: RunLink): Promise<void> {
    if (link.runId !== undefined) {
      await this.reconcileRun(link);
      return;
    }
    const runtime = (await this.options.runtimes.open(link.workspace)).runtime;
    const admission = await runtime.findAdmission(link.admissionRequestId);
    if (admission.isErr()) throw new Error(admission.error.message);
    if (admission.value === undefined) return;
    await this.reconcileRun(
      await this.options.admit(link.admissionRequestId, admission.value),
    );
  }

  private async reconcile(link: AdmittedRunLink): Promise<void> {
    if (this.disposed) return;
    const runtime = (await this.options.runtimes.open(link.workspace)).runtime;
    if (this.disposed) return;
    const projection = await this.readProjection(runtime, link);
    await this.commit(link, projection);
    if (this.disposed) return;
    this.scheduleNoticeDelivery(link.parentSessionId);
    if (isTerminalProjection(projection) || isParkedProjection(projection)) return;
    await this.startObserver(runtime, link);
  }

  private async startObserver(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
  ): Promise<void> {
    if (this.disposed) return;
    const key = runKey(link);
    const current = this.observers.get(key);
    if (current !== undefined) {
      if (!current.closing) return;
      await current.task;
      if (this.disposed || this.observers.has(key)) return;
    }
    const controller = new AbortController();
    const task = this.observe(runtime, link, key, controller.signal)
      .catch(error => this.report(error, `observer for run ${link.runId}`))
      .finally(() => {
        if (this.observers.get(key)?.task === task) this.observers.delete(key);
      });
    this.observers.set(key, { controller, task, closing: false });
  }

  private async observe(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
    key: string,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const observed of runtime.observeInspection({
      view: { kind: "run", runId: link.runId, structure: "materialized" },
      until: "decision-boundary",
      updates: "activity",
    }, signal)) {
      if (observed.isErr()) {
        this.report(
          new Error(observed.error.message),
          `Runtime observation for run ${link.runId}`,
        );
        return;
      }
      const value = observed.value;
      const view = value.kind === "update"
        ? await this.readRunView(runtime, link.runId)
        : value.view;
      if (view.kind !== "run") {
        throw new Error(`Run '${link.runId}' returned an unexpected observation view.`);
      }
      const projection = projectStoredRun(link, view);
      const closing = isTerminalProjection(projection)
        || isParkedProjection(projection)
        || value.kind === "closed";
      if (closing) {
        const observer = this.observers.get(key);
        if (observer !== undefined) observer.closing = true;
      }
      await this.commit(link, projection);
      if (this.disposed) return;
      this.scheduleNoticeDelivery(link.parentSessionId);
      if (closing) return;
    }
  }

  private async readProjection(
    runtime: WorkspaceRuntime,
    link: AdmittedRunLink,
  ): Promise<StoredRunProjection> {
    return projectStoredRun(link, await this.readRunView(runtime, link.runId));
  }

  private async readRunView(
    runtime: WorkspaceRuntime,
    runId: string,
  ): Promise<Extract<InspectionView, { kind: "run" }>> {
    const inspected = await runtime.inspect({ kind: "run", runId, structure: "materialized" });
    if (inspected.isErr()) throw new Error(inspected.error.message);
    if (inspected.value.kind !== "run") {
      throw new Error(`Run '${runId}' returned an unexpected inspection view.`);
    }
    return inspected.value;
  }

  private async commit(
    link: AdmittedRunLink,
    projection: StoredRunProjection,
  ): Promise<void> {
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
    const committed = await this.options.store.commitObservation({
      link,
      projection,
      ...(notice === undefined ? {} : { notice }),
    });
    if (committed.wakeWaiters) {
      this.wakeSession(this.activityWaiters, link.parentSessionId, committed.revision);
    }
  }

  scheduleNoticeDelivery(sessionId?: string): void {
    void this.deliverPendingNotices(sessionId).catch(error =>
      this.report(error, "attention delivery"));
  }

  private async deliverPendingNotices(sessionId?: string): Promise<void> {
    if (this.disposed) return;
    const adapter = this.options.notices;
    if (adapter === undefined) return;
    const notices = await this.options.store.pendingNotices();
    for (const notice of notices) {
      if (this.disposed) return;
      if (sessionId !== undefined && notice.parentSessionId !== sessionId) continue;
      try {
        const delivered = await adapter.deliver({
          id: notice.id,
          sessionId: notice.parentSessionId,
          message: noticeMessage(notice),
        });
        if (delivered.delivered) {
          await this.options.store.markNoticeDelivered(notice.id);
        }
      } catch (error) {
        this.report(error, `notice ${notice.id}`);
      }
    }
  }

  private wakeSession(
    registry: Map<string, Set<RevisionWaiter>>,
    sessionId: string,
    revision: number,
  ): void {
    const waiters = registry.get(sessionId);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) {
      if (waiter.afterRevision === revision) continue;
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiters.delete(waiter);
      waiter.resolve();
    }
    if (waiters.size === 0) registry.delete(sessionId);
  }

  private report(error: unknown, context: string): void {
    (this.options.report ?? defaultReport)(error, context);
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
