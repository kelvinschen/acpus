import { describe, expect, it, vi } from "vitest";
import type { RunLink, SupervisorStateStore } from "../src/host/run-links.js";
import { projectStoredRun } from "../src/host/run-projection.js";
import { AcpusSupervision } from "../src/host/supervision.js";

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

  it("recovers provisional admissions at startup and does not observe terminal runs", async () => {
    const provisional = link();
    const admitted = admittedLink();
    const store = storeStub([provisional]);
    const runtime = runtimeStub(runView("completed"));
    const admit = vi.fn(async () => admitted);
    const supervision = new AcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit,
      report: error => { throw error; },
    });

    supervision.start();
    await vi.waitFor(() => expect(store.commitObservation).toHaveBeenCalledTimes(1));

    expect(admit).toHaveBeenCalledWith("admission-1", expect.objectContaining({ id: "run-1", name: "Example" }));
    expect(runtime.observeInspection).not.toHaveBeenCalled();
    await supervision.dispose();
  });

  it("parks awaiting Signal runs and starts exactly one observer after reconciliation", async () => {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    let view = runView("awaiting", true);
    const runtime = runtimeStub(() => view);
    const supervision = new AcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(),
      report: error => { throw error; },
    });

    supervision.start();
    await vi.waitFor(() => expect(store.commitObservation).toHaveBeenCalledTimes(1));
    expect(runtime.observeInspection).not.toHaveBeenCalled();

    view = runView("running");
    await Promise.all([
      supervision.reconcileRun(admitted),
      supervision.reconcileRun(admitted),
    ]);
    await vi.waitFor(() => expect(runtime.observeInspection).toHaveBeenCalledTimes(1));
    expect(runtime.observeInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        view: { kind: "run", runId: "run-1", structure: "materialized" },
        updates: "activity",
      }),
      expect.any(AbortSignal),
    );
    await supervision.reconcileRun(admitted);
    expect(runtime.observeInspection).toHaveBeenCalledTimes(1);

    await supervision.dispose();
    expect(runtime.aborted).toBe(true);
  });

  it("replaces an observer that is parking while reconciliation is requested", async () => {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    const parkingCommit = deferred<void>();
    let commitCount = 0;
    store.commitObservation.mockImplementation(async () => {
      commitCount += 1;
      if (commitCount === 2) await parkingCommit.promise;
      return {
        revision: commitCount,
        projectionChanged: true,
        noticeInserted: false,
        wakeWaiters: true,
      };
    });
    let view = runView("running");
    let observations = 0;
    const runtime = runtimeStub(() => view);
    runtime.observeInspection.mockImplementation(async function* (_input, signal) {
      observations += 1;
      if (observations === 1) {
        yield okValue({
          kind: "closed",
          reason: "decision-boundary",
          view: runView("awaiting", true),
        });
        return;
      }
      await new Promise<void>(resolve => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const supervision = new AcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(),
      report: error => { throw error; },
    });

    supervision.start();
    await vi.waitFor(() => expect(store.commitObservation).toHaveBeenCalledTimes(2));
    view = runView("running");
    const reconciled = supervision.reconcileRun(admitted);
    parkingCommit.resolve();
    await reconciled;

    expect(runtime.observeInspection).toHaveBeenCalledTimes(2);
    await supervision.dispose();
  });

  it("wakes concurrent equal-revision waiters independently and rejects them on disposal", async () => {
    let revision = 3;
    const store = storeStub([]);
    store.readSession.mockImplementation(async sessionId => ({
      sessionId,
      revision,
      runs: [],
    }));
    const supervision = new AcpusSupervision({
      runtimes: pool(runtimeStub(runView("completed"))),
      store,
      admit: vi.fn(),
    });
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const first = supervision.waitForActivityRevision("session-1", 3, firstSignal.signal);
    const second = supervision.waitForActivityRevision("session-1", 3, secondSignal.signal);
    await vi.waitFor(() => expect(store.readSession).toHaveBeenCalledTimes(4));

    firstSignal.abort(new Error("first aborted"));
    await expect(first).rejects.toThrow("first aborted");
    let secondSettled = false;
    void second.then(
      () => { secondSettled = true; },
      () => { secondSettled = true; },
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);

    revision = 4;
    await supervision.dispose();
    await expect(second).rejects.toThrow("disposed");
  });

  it("reports one failed startup link without blocking the remaining links", async () => {
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
        ? Promise.reject(new Error("first inspection failed"))
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
    const supervision = new AcpusSupervision({
      runtimes: pool(runtime),
      store,
      admit: vi.fn(),
      report,
    });

    supervision.start();
    await supervision.whenReady();

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "first inspection failed" }),
      "startup reconciliation for run-1",
    );
    expect(store.commitObservation).toHaveBeenCalledTimes(1);
    await supervision.dispose();
  });

  it("does not deliver a notice after disposal starts during projection commit", async () => {
    const admitted = admittedLink();
    const store = storeStub([admitted]);
    const committed = deferred<void>();
    store.commitObservation.mockImplementation(async () => {
      await committed.promise;
      return {
        revision: 1,
        projectionChanged: true,
        noticeInserted: true,
        wakeWaiters: true,
      };
    });
    vi.mocked(store.pendingNotices).mockResolvedValue([{
      id: "notice-1",
      parentSessionId: "session-1",
      workspace: "/workspace",
      runId: "run-1",
      task: { name: "Example", occurrence: 1 },
      kind: "completed",
      projectionUpdatedAt: "2026-08-14T00:00:01.000Z",
    }]);
    const deliver = vi.fn();
    const supervision = new AcpusSupervision({
      runtimes: pool(runtimeStub(runView("completed"))),
      store,
      admit: vi.fn(),
      notices: { deliver } as never,
    });

    supervision.start();
    await vi.waitFor(() => expect(store.commitObservation).toHaveBeenCalledOnce());
    const disposed = supervision.dispose();
    committed.resolve();
    await disposed;

    expect(deliver).not.toHaveBeenCalled();
  });
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
    listLinks: vi.fn(async () => links),
    readSession: vi.fn(async sessionId => ({
      sessionId,
      revision: 0,
      runs: [],
    })),
    commitObservation: vi.fn(async () => ({
      revision: 1,
      projectionChanged: true,
      noticeInserted: false,
      wakeWaiters: true,
    })),
    pendingNotices: vi.fn(async () => []),
    markNoticeDelivered: vi.fn(async () => undefined),
    prepareCancel: vi.fn(),
    settleCancel: vi.fn(),
    pendingControls: vi.fn(async () => []),
  } satisfies SupervisorStateStore as SupervisorStateStore & {
    listLinks: ReturnType<typeof vi.fn>;
    readSession: ReturnType<typeof vi.fn>;
    commitObservation: ReturnType<typeof vi.fn>;
  };
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
    open: vi.fn(async () => ({ workspace: "/workspace", runtime })),
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
    observeInspection: vi.fn(async function* (
      _input: unknown,
      signal?: AbortSignal,
    ): AsyncGenerator<ReturnType<typeof okValue>, void, unknown> {
      await new Promise<void>(resolve => {
        signal?.addEventListener("abort", () => {
          runtime.aborted = true;
          resolve();
        }, { once: true });
      });
    }),
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
  return Promise.resolve({
    value,
    isOk: () => true,
    isErr: () => false,
  });
}

function okValue<T>(value: T) {
  return {
    value,
    isOk: () => true,
    isErr: () => false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
