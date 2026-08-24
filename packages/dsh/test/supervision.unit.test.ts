import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { InspectionError, InspectionObservation } from "@acpus/runtime";
import type { RunLink, SupervisorStateStore } from "../src/host/run-links.js";
import { projectStoredRun } from "../src/host/run-projection.js";
import { makeAcpusSupervision } from "../src/host/supervision.js";

describe("process-owned Acpus supervision", () => {
  it("retains safe Agent identity independently of activity pulses", () => {
    const view = {
      kind: "run",
      run: { id: "run-1", name: "Example", status: "running", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:01.000Z" },
      counts: { total: 1, running: 1 },
      tree: [{
        type: "item",
        subject: { selector: "worker", label: "Worker", kind: "agent" },
        state: { status: "running" },
        agent: {
          name: "claude",
          telemetry: {
            inputTokens: 12_000,
            outputTokens: 2_400,
            totalTokens: 14_400,
            contextWindow: { used: 12_000, size: 32_000 },
          },
        },
        children: [],
      }],
    } as never;

    const projection = projectStoredRun(admittedLink(), view);

    expect(projection.activity[0]).toMatchObject({
      agent: {
        name: "claude",
        telemetry: {
          inputTokens: 12_000,
          outputTokens: 2_400,
          totalTokens: 14_400,
          contextWindow: { used: 12_000, size: 32_000 },
        },
      },
    });
  });

  it("keeps authored composites and every materialized structural occurrence", () => {
    const item = (kind: string, label: string, children: unknown[], status = "running") => ({
      type: "item",
      subject: { selector: `${kind}-${label}`, label, kind },
      state: { status },
      children,
    });
    const view = {
      kind: "run",
      run: { id: "run-1", name: "Example", status: "running", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:01.000Z" },
      counts: { total: 1, running: 1 },
      tree: [item("if", "risk_gate", [
        item("branch", "high_risk", [
          item("fanout", "review_targets", [
            item("fanout_item", "item[1]", [
              item("loop", "refine_review", []),
            ]),
          ]),
        ]),
      ])],
    } as never;

    const projection = projectStoredRun(admittedLink(), view);
    const replay = projectStoredRun(admittedLink(), view);

    expect(projection.activity).toMatchObject([{
      kind: "if",
      label: "risk_gate",
      children: [{
        kind: "branch",
        label: "high_risk",
        children: [{
          kind: "fanout",
          label: "review_targets",
          children: [{
            kind: "fanout_item",
            label: "item[1]",
            children: [{ kind: "loop", label: "refine_review" }],
          }],
        }],
      }],
    }]);
    expect(projection.activity[0]?.activityId).toMatch(/^[a-f0-9]{32}$/u);
    expect(replay.activity[0]?.activityId).toBe(projection.activity[0]?.activityId);
    expect(projection.activity[0]?.children[0]?.activityId)
      .not.toBe(projection.activity[0]?.activityId);
  });

  it("drops stale Signal attention from terminal projections", () => {
    const projection = projectStoredRun(
      admittedLink(),
      runView("canceled", true),
    );

    expect(projection.actionRequirement).toBeUndefined();
    expect(projection.status).toBe("canceled");
  });

  it.effect("recovers provisional admissions at startup and does not observe terminal runs", () => Effect.scoped(Effect.gen(function* () {
    const provisional = link();
    const admitted = admittedLink();
    const store = storeStub([provisional]);
    const runtime = runtimeStub(runView("completed"));
    const admit = vi.fn(() => Effect.succeed(admitted));
    const supervision = yield* makeAcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit,
      report: error => { throw error; },
    });

    yield* supervision.whenReady();

    expect(store.commitObservation).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith("admission-1", expect.objectContaining({ id: "run-1", name: "Example" }));
    expect(runtime.observeInspection).not.toHaveBeenCalled();
  })));

  it.effect("does not reopen the workspace for retained terminal history", () => Effect.scoped(Effect.gen(function* () {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    store.readSession.mockReturnValue(Effect.succeed({
      sessionId: admitted.parentSessionId,
      revision: 1,
      runs: [projectStoredRun(admitted, runView("completed"))],
    }));
    store.listReconciliationLinks.mockReturnValue(Effect.succeed([]));
    const open = vi.fn(() => Effect.die(new Error("workspace is missing")));
    const report = vi.fn();
    const supervision = yield* makeAcpusSupervision({
      runtimes: { open } as never,
      store,
      admit: vi.fn(() => Effect.never),
      report,
    });

    yield* supervision.whenReady();

    expect(open).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  })));

  it.effect("degrades a non-terminal task when its workspace is unavailable", () => Effect.scoped(Effect.gen(function* () {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    store.setRunUnavailable.mockReturnValue(Effect.succeed({ revision: 2, changed: true }));
    const report = vi.fn();
    const supervision = yield* makeAcpusSupervision({
      runtimes: {
        open: vi.fn(() => Effect.fail({
          type: "workspace-unavailable" as const,
          workspace: admitted.workspace,
          message: "Restore the original path and retry.",
        })),
      } as never,
      store,
      admit: vi.fn(() => Effect.never),
      report,
    });

    yield* supervision.whenReady();

    expect(store.setRunUnavailable).toHaveBeenCalledWith({
      link: admitted,
      unavailable: {
        reason: "workspace-unavailable",
        detail: "Restore the original path and retry.",
        detectedAt: expect.any(String),
      },
    });
    expect(report).not.toHaveBeenCalled();
  })));

  it.effect("parks Signal runs and admits at most one observer per run", () => Effect.gen(function* () {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    let view = runView("awaiting", true);
    const runtime = runtimeStub(() => view);
    yield* Effect.scoped(Effect.gen(function* () {
      const supervision = yield* makeAcpusSupervision({
        runtimes: pool(runtime),
        store,
        admit: vi.fn(() => Effect.never),
        report: error => { throw error; },
      });
      yield* supervision.whenReady();
      expect(runtime.observeInspection).not.toHaveBeenCalled();

      view = runView("running");
      yield* Effect.all([
        supervision.reconcileRun(admitted),
        supervision.reconcileRun(admitted),
      ], { concurrency: "unbounded" });
      yield* Effect.yieldNow;
      expect(runtime.observeInspection).toHaveBeenCalledTimes(1);
      expect(runtime.observeInspection).toHaveBeenCalledWith(
        expect.objectContaining({
          view: { kind: "run", runId: "run-1", structure: "materialized" },
          updates: "activity",
        }),
        expect.any(AbortSignal),
      );
      yield* supervision.reconcileRun(admitted);
      expect(runtime.observeInspection).toHaveBeenCalledTimes(1);
    }));
    expect(runtime.aborted).toBe(true);
  }));

  it.effect("replaces an observer that is parking while reconciliation is requested", () => Effect.scoped(Effect.gen(function* () {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    const parkingCommit = yield* Deferred.make<void>();
    const parkingStarted = yield* Deferred.make<void>();
    let commitCount = 0;
    store.commitObservation.mockImplementation(() => Effect.gen(function* () {
      const count = ++commitCount;
      if (count === 2) {
        yield* Deferred.succeed(parkingStarted, undefined);
        yield* Deferred.await(parkingCommit);
      }
      return {
        revision: count,
        projectionChanged: true,
        noticeInserted: false,
        wakeWaiters: true,
      };
    }));
    let view = runView("running");
    let observations = 0;
    const runtime = runtimeStub(() => view);
    runtime.observeInspection.mockImplementation(() => {
      observations += 1;
      return observations === 1
        ? Stream.make({
          kind: "closed",
          reason: "awaiting-input",
          view: runView("awaiting", true),
        } as const)
        : Stream.fromEffect(Effect.never);
    });
    const supervision = yield* makeAcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(() => Effect.never),
      report: error => { throw error; },
    });

    yield* Deferred.await(parkingStarted);
    view = runView("running");
    const reconciled = yield* Effect.forkChild(supervision.reconcileRun(admitted));
    yield* Deferred.succeed(parkingCommit, undefined);
    yield* Fiber.join(reconciled);

    expect(runtime.observeInspection).toHaveBeenCalledTimes(2);
  })));

  it.effect("does not lose revision wakes and releases independent waiters on close", () => Effect.gen(function* () {
    let revision = 3;
    const store = storeStub([]);
    store.readSession.mockImplementation(sessionId => Effect.succeed({
      sessionId,
      revision,
      runs: [],
    }));
    store.setRunUnavailable.mockImplementation(() => Effect.sync(() => {
      revision += 1;
      return { revision, changed: true };
    }));
    const scope = yield* Scope.make("parallel");
    const supervision = yield* Scope.provide(scope)(makeAcpusSupervision({
      runtimes: pool(runtimeStub(runView("completed"))),
      store,
      admit: vi.fn(() => Effect.never),
    }));
    yield* supervision.whenReady();
    const first = yield* Effect.forkChild(supervision.waitForActivityRevision("session-1", 3));
    const second = yield* Effect.forkChild(supervision.waitForActivityRevision("session-1", 3));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    expect(second.pollUnsafe()).toBeUndefined();

    yield* Effect.result(supervision.openLinkedRuntime(admittedLink()));
    yield* Fiber.join(second);
    expect(revision).toBe(4);

    yield* Effect.result(supervision.openLinkedRuntime(admittedLink()));
    yield* supervision.waitForActivityRevision("session-1", 4);

    const disposedWaiter = yield* Effect.forkChild(
      supervision.waitForActivityRevision("session-1", 5),
    );
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    const disposed = yield* Effect.flip(Fiber.join(disposedWaiter));
    expect(disposed.message).toBe("Acpus supervision was disposed.");
  }));

  it.effect("reports one failed startup link without blocking the remaining links", () => Effect.scoped(Effect.gen(function* () {
    const first = admittedLink();
    const second = {
      ...link(),
      admissionRequestId: "admission-2",
      runId: "run-2",
      workflowName: "Example",
      occurrence: 1,
    };
    const store = storeStub([first, second]);
    const runtime = runtimeStub(runView("completed"));
    runtime.inspect.mockImplementation(input =>
      input.runId === "run-1"
        ? Effect.die(new Error("first inspection failed"))
        : okResult(runView("completed", false, "run-2")));
    runtime.findAdmission.mockImplementation(requestId => okResult({
      id: requestId === "admission-1" ? "run-1" : "run-2",
      requestId,
      name: "Example",
      status: "completed",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
    }));
    const report = vi.fn();
    const supervision = yield* makeAcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(() => Effect.never),
      report,
    });

    yield* supervision.whenReady();

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "first inspection failed" }),
      "startup reconciliation for run-1",
    );
    expect(store.commitObservation).toHaveBeenCalledTimes(1);
  })));

  it.effect("interrupts startup and keyed reconciliation when the Host Scope closes", () => Effect.gen(function* () {
    const startupStarted = yield* Deferred.make<void>();
    const startupInterrupted = yield* Deferred.make<void>();
    const reconciliationStarted = yield* Deferred.make<void>();
    const reconciliationInterrupted = yield* Deferred.make<void>();
    const store = storeStub([]);
    store.listReconciliationLinks.mockReturnValue(
      Deferred.succeed(startupStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(startupInterrupted, undefined)),
      ),
    );
    const scope = yield* Scope.make("parallel");
    const supervision = yield* Scope.provide(scope)(makeAcpusSupervision({
      runtimes: {
        open: vi.fn(() => Deferred.succeed(reconciliationStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(reconciliationInterrupted, undefined)),
        )),
      } as never,
      store,
      admit: vi.fn(() => Effect.never),
    }));
    yield* Deferred.await(startupStarted);
    const reconciliation = yield* Effect.forkChild(
      supervision.reconcileRun(admittedLink()),
    );
    yield* Deferred.await(reconciliationStarted);

    yield* Scope.close(scope, Exit.void);

    yield* Deferred.await(startupInterrupted);
    yield* Deferred.await(reconciliationInterrupted);
    expect(Exit.isFailure(yield* Fiber.await(reconciliation))).toBe(true);
  }));

  it.effect("interrupts observer defects locally and owns notice delivery in the Host Scope", () => Effect.gen(function* () {
    const store = storeStub([]);
    store.pendingNotices.mockReturnValue(Effect.succeed([{
      id: "notice-1",
      parentSessionId: "session-1",
      workspace: "/workspace",
      runId: "run-1",
      task: { name: "Example", occurrence: 1 },
      kind: "user-control",
      projectionUpdatedAt: "2026-08-14T00:00:01.000Z",
      control: {
        actor: "user",
        operation: "cancel",
        outcome: "applied",
        taskStatus: "canceled",
      },
    }]));
    const deliveryStarted = Deferred.makeUnsafe<void>();
    const deliver = vi.fn(() => {
      Deferred.doneUnsafe(deliveryStarted, Effect.void);
      return new Promise<never>(() => {});
    });
    const markNoticeDelivered = store.markNoticeDelivered;
    const report = vi.fn();
    const runtime = runtimeStub(runView("running"));
    runtime.observeInspection.mockReturnValue(Stream.fromEffect(
      Effect.die(new Error("observer defect")),
    ));
    const scope = yield* Scope.make("parallel");
    const supervision = yield* Scope.provide(scope)(makeAcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(() => Effect.never),
      notices: { deliver } as never,
      report,
    }));
    yield* supervision.whenReady();
    yield* supervision.reconcileRun(admittedLink());
    yield* Effect.yieldNow;
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "observer defect" }),
      "observer for run run-1",
    );

    yield* Deferred.await(deliveryStarted);
    expect(deliver).toHaveBeenCalledOnce();
    yield* Scope.close(scope, Exit.void);
    expect(markNoticeDelivered).not.toHaveBeenCalled();
  }));
});

function link(): RunLink {
  return {
    workspace: "/workspace",
    admissionRequestId: "admission-1",
    parentSessionId: "session-1",
    generation: 1,
  };
}

function storeStub(links: RunLink[]) {
  return {
    listLinks: vi.fn(() => Effect.succeed(links)),
    listReconciliationLinks: vi.fn(() => Effect.succeed(links)),
    readSession: vi.fn<SupervisorStateStore["readSession"]>((sessionId: string) => Effect.succeed({
      sessionId,
      revision: 0,
      runs: [],
    })),
    commitObservation: vi.fn(() => Effect.succeed({
      revision: 1,
      projectionChanged: true,
      noticeInserted: false,
      wakeWaiters: true,
    })),
    setRunUnavailable: vi.fn(() => Effect.succeed({ revision: 0, changed: false })),
    pendingNotices: vi.fn<SupervisorStateStore["pendingNotices"]>(() => Effect.succeed([])),
    markNoticeDelivered: vi.fn(() => Effect.void),
    prepareCancel: vi.fn(() => Effect.never),
    settleCancel: vi.fn(() => Effect.void),
    pendingControls: vi.fn(() => Effect.succeed([])),
  } satisfies SupervisorStateStore;
}

function admittedLink(): RunLink & { runId: string; workflowName: string; occurrence: number } {
  return {
    ...link(),
    runId: "run-1",
    workflowName: "Example",
    occurrence: 1,
  };
}

function pool(runtime: ReturnType<typeof runtimeStub>) {
  return {
    open: vi.fn(() => Effect.succeed({ workspace: "/workspace", runtime })),
  } as never;
}

function runtimeStub(
  projected: ReturnType<typeof runView> | (() => ReturnType<typeof runView>),
) {
  const runtime = {
    aborted: false,
    inspect: vi.fn((_input: { runId: string }) => okResult(
      typeof projected === "function" ? projected() : projected,
    )),
    findAdmission: vi.fn((requestId: string) => okResult({
      id: "run-1",
      requestId,
      name: "Example",
      status: "running",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
    })),
    observeInspection: vi.fn((
      _input: unknown,
      _signal?: AbortSignal,
    ): Stream.Stream<InspectionObservation, InspectionError> => Stream.fromEffect(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => {
        runtime.aborted = true;
      }))),
    )),
  };
  return runtime;
}

function runView(status: string, signal = false, runId = "run-1") {
  return {
    kind: "run" as const,
    run: {
      id: runId,
      name: "Example",
      status,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
      ...(status === "failed" ? { failure: { origin: "run", message: "failed" } } : {}),
    },
    counts: {
      total: 1,
      running: status === "running" ? 1 : 0,
      awaiting: status === "awaiting" ? 1 : 0,
      completed: status === "completed" ? 1 : 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
      mixed: 0,
    },
    tree: signal ? [{
      type: "item",
      subject: { selector: "worker", label: "Worker", kind: "agent" },
      state: { status: "awaiting" },
      attention: {
        kind: "awaiting-input",
        signal: "approval",
        prompt: "Approve?",
        expected: "boolean",
      },
      children: [],
    }] : [],
  } as never;
}

function okResult<T>(value: T) {
  return Effect.succeed(value);
}
