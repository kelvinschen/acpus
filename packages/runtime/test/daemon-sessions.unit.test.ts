import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryLoadRuntimeConfiguration } from "../src/configuration.js";
import type { dispatchCommittedHooksForRun as DispatchCommittedHooksForRun } from "../src/hooks/dispatch.js";
import type { applySchedulerControlIntent as ApplySchedulerControlIntent } from "../src/scheduler/control.js";
import type { createRuntimeRunScheduler as CreateRuntimeRunScheduler, RunExecution, RunExecutionExit, RuntimeRunScheduler } from "../src/scheduler/runtime-runner.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";
import type { RunDetails, RuntimeStore } from "../src/store/store.js";
import { ok } from "neverthrow";

const applySchedulerControlIntent = vi.fn<typeof ApplySchedulerControlIntent>();
const createRuntimeRunScheduler = vi.fn<typeof CreateRuntimeRunScheduler>();
const dispatchCommittedHooksForRun = vi.fn<typeof DispatchCommittedHooksForRun>(() => ok({ runId: "run-a", eventSequence: 0, dispatched: 0 }));

vi.mock("../src/scheduler/control.js", () => ({ applySchedulerControlIntent }));
vi.mock("../src/scheduler/runtime-runner.js", () => ({ createRuntimeRunScheduler }));
vi.mock("../src/hooks/dispatch.js", () => ({ dispatchCommittedHooksForRun }));

const { RunExecutionSessions } = await import("../src/daemon/sessions.js");

const schedulerStart = vi.fn<RuntimeRunScheduler["start"]>();
let executions: RunExecution[];

beforeEach(() => {
  executions = [];
  applySchedulerControlIntent.mockReset();
  createRuntimeRunScheduler.mockReset();
  schedulerStart.mockReset().mockImplementation(({ runId }) => {
    const execution = controlledExecution(runId);
    executions.push(execution);
    return execution;
  });
  createRuntimeRunScheduler.mockReturnValue({ start: schedulerStart });
  dispatchCommittedHooksForRun.mockClear();
});

describe("daemon run execution sessions", () => {
  it("passes the startup runtime configuration snapshot to the scheduler factory", async () => {
    const configuration = runtimeConfiguration();
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a", "run-b"), undefined, configuration);

    sessions.start("run-a");
    sessions.start("run-b");

    expect(createRuntimeRunScheduler).toHaveBeenCalledOnce();
    expect(createRuntimeRunScheduler).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      maxLeafConcurrency: 7,
      agentHostPolicy: configuration.agentHostPolicy,
    }));
    expect(createRuntimeRunScheduler.mock.calls[0]![0].agentHostPolicy).toBe(configuration.agentHostPolicy);
    expect(schedulerStart.mock.calls.map(([input]) => input.runId)).toEqual(["run-a", "run-b"]);

    await sessions.stopExecutors(100);
  });

  it("wakes an active execution only after durable control succeeds", async () => {
    const order: string[] = [];
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration());
    sessions.start("run-a");
    executions[0]!.wake = vi.fn(() => {
      order.push("wake");
    });
    applySchedulerControlIntent.mockImplementation(() => {
      order.push("control");
      return ok({
        snapshot: {} as SchedulerSnapshot,
        effect: {
          type: "signal",
          state: "consumed",
          requestedTarget: "approval",
          target: "approval~000000000001",
          validation: { kind: "raw-string" },
        },
        reopened: false,
      });
    });

    await sessions.control({
      requestId: "signal-1",
      runId: "run-a",
      type: "signal",
      nodeId: "approval",
      payload: "approved",
    });

    expect(order).toEqual(["control", "wake"]);
    await sessions.stopExecutors(100);
  });

  it("bridges steer to the scheduler and returns its durable receipt without replacing the session", async () => {
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration());
    sessions.start("run-a");
    applySchedulerControlIntent.mockReturnValue(ok({
      snapshot: {} as SchedulerSnapshot,
      effect: {
        type: "steer",
        state: "applied",
        steerId: "steer-1",
        requestedTarget: "review",
        target: "review~000000000001",
        fencedAttemptId: "attempt-1",
        continuation: "queued",
      },
      reopened: false,
    }));

    const result = await sessions.control({
      requestId: "steer-1",
      runId: "run-a",
      type: "steer",
      target: "review",
      instruction: "Focus on the failing assertion.",
    });

    expect(applySchedulerControlIntent).toHaveBeenCalledWith(
      expect.anything(),
      {
        requestId: "steer-1",
        runId: "run-a",
        type: "steer",
        target: "review",
        instruction: "Focus on the failing assertion.",
      },
      1,
    );
    expect(result._unsafeUnwrap()).toMatchObject({
      type: "steer",
      steerId: "steer-1",
      target: "review~000000000001",
      fencedAttemptId: "attempt-1",
      continuation: "queued",
    });
    expect(executions[0]!.wake).toHaveBeenCalledOnce();
    expect(executions[0]!.stop).not.toHaveBeenCalled();
    await sessions.stopExecutors(100);
  });

  it("snapshots the private observation fence before waking the steered execution", async () => {
    const order: string[] = [];
    const store = runtimeStore("run-a");
    store.observationLog.markFenced = vi.fn(() => {
      order.push("fence");
      return Promise.resolve();
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration());
    sessions.start("run-a");
    executions[0]!.wake = vi.fn(() => {
      order.push("wake");
    });
    applySchedulerControlIntent.mockImplementation(() => {
      order.push("control");
      return ok({
        snapshot: {} as SchedulerSnapshot,
        effect: {
          type: "steer",
          state: "applied",
          steerId: "steer-1",
          requestedTarget: "review",
          target: "review~000000000001",
          fencedAttemptId: "attempt-1",
          continuation: "queued",
        },
        reopened: false,
        observationFence: {
          runId: "run-a",
          attemptId: "attempt-1",
          eventSequence: 7,
          committedAt: "2026-07-12T00:00:00.000Z",
          reason: "operator_steered",
        },
      });
    });

    await sessions.control({
      requestId: "steer-1",
      runId: "run-a",
      type: "steer",
      target: "review",
      instruction: "Focus.",
    });

    expect(order).toEqual(["control", "fence", "wake"]);
    expect(store.observationLog.markFenced).toHaveBeenCalledWith({
      runId: "run-a",
      attemptId: "attempt-1",
      eventSequence: 7,
      committedAt: "2026-07-12T00:00:00.000Z",
      reason: "operator_steered",
    });
    await sessions.stopExecutors(100);
  });

  it.each(["resume", "retry"] as const)("does not replace an active execution for a no-op %s", async type => {
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration());
    sessions.start("run-a");
    applySchedulerControlIntent.mockReturnValue(ok({
      snapshot: {} as SchedulerSnapshot,
      effect: { type, state: "applied" },
      reopened: false,
    }));

    await sessions.control({ requestId: `${type}-replay`, runId: "run-a", type });

    expect(executions[0]!.stop).not.toHaveBeenCalled();
    expect(schedulerStart).toHaveBeenCalledOnce();
    await sessions.stopExecutors(100);
  });

  it("does not carry a rejected old-session fence into a reopened execution", async () => {
    const store = runtimeStore("run-a");
    let rejectOld!: (error: Error) => void;
    schedulerStart
      .mockReturnValueOnce({
        ownerEpoch: Promise.resolve(1),
        result: new Promise(( _resolve, reject) => {
          rejectOld = reject;
        }),
        wake: vi.fn(),
        stop: vi.fn(() => rejectOld(new Error("old session failed during stop"))),
      })
      .mockReturnValueOnce({
        ownerEpoch: Promise.resolve(2),
        result: Promise.resolve(ok({
          status: "awaiting",
          runId: "run-a",
          ownerEpoch: 2,
          started: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          active: 0,
        })),
        wake: vi.fn(),
        stop: vi.fn(),
      });
    applySchedulerControlIntent.mockImplementation(() => {
      store.getRun("run-a")!.eventCount += 1;
      return ok({
        snapshot: {} as SchedulerSnapshot,
        effect: { type: "resume", state: "applied" },
        reopened: true,
      });
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration());

    sessions.start("run-a");
    await sessions.control({ requestId: "resume-applied", runId: "run-a", type: "resume" });
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0), { interval: 1 });
    sessions.start("run-a");

    expect(schedulerStart).toHaveBeenCalledTimes(3);
    await sessions.stopExecutors(100);
  });

  it("stops each active execution during executor shutdown", async () => {
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration());
    sessions.start("run-a");

    await sessions.stopExecutors(100);

    expect(executions[0]!.stop).toHaveBeenCalledOnce();
  });

  it("does not restart an unchanged rejected run and leaves other runs startable", async () => {
    const failure = new Error("scheduler invariant failed");
    schedulerStart.mockReturnValueOnce({
      ownerEpoch: Promise.resolve(1),
      result: Promise.reject(failure),
      wake: vi.fn(),
      stop: vi.fn(),
    });
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a", "run-b"), undefined, runtimeConfiguration());

    sessions.start("run-a");
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0), { interval: 1 });

    expect(() => sessions.start("run-a")).not.toThrow();
    sessions.start("run-b");
    expect(schedulerStart.mock.calls.map(([input]) => input.runId)).toEqual(["run-a", "run-b"]);
    await sessions.stopExecutors(100);
  });

  it("allows a failed session to restart after durable state changes", async () => {
    const store = runtimeStore("run-a");
    schedulerStart.mockReturnValueOnce({
      ownerEpoch: Promise.resolve(1),
      result: Promise.reject(new Error("scheduler invariant failed")),
      wake: vi.fn(),
      stop: vi.fn(),
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration());

    sessions.start("run-a");
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0), { interval: 1 });
    store.getRun("run-a")!.eventCount += 1;

    expect(() => sessions.start("run-a")).not.toThrow();
    expect(schedulerStart).toHaveBeenCalledTimes(2);
    await sessions.stopExecutors(100);
  });

  it("fences a hook projection incident without reloading full run details", () => {
    const corruption = new Error("scheduler projection is corrupt");
    const incident = vi.fn();
    const store = runtimeStore("run-a");
    const getRun = vi.fn(() => {
      throw corruption;
    });
    store.getRun = getRun;
    dispatchCommittedHooksForRun.mockImplementationOnce(() => {
      throw corruption;
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration(), incident);

    expect(sessions.dispatchHooks("run-a")).toBe("quarantined");
    expect(sessions.dispatchHooks("run-a")).toBe("quarantined");
    expect(getRun).not.toHaveBeenCalled();
    expect(dispatchCommittedHooksForRun).toHaveBeenCalledOnce();
    expect(incident).toHaveBeenCalledOnce();
    expect(incident).toHaveBeenCalledWith({ runId: "run-a", source: "hook", error: corruption });
  });
});

function controlledExecution(runId: string): RunExecution {
  let settle!: (exit: RunExecutionExit) => void;
  const result: RunExecution["result"] = new Promise(resolve => {
    settle = exit => resolve(ok(exit));
  });
  return {
    ownerEpoch: Promise.resolve(1),
    result,
    wake: vi.fn(),
    stop: vi.fn(() => {
      settle({
        status: "completed",
        runId,
        ownerEpoch: 1,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        active: 0,
      });
    }),
  };
}

function runtimeConfiguration() {
  const configuration = tryLoadRuntimeConfiguration({
    ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY: "7",
    ACPUS_AGENT_RESPONSE_REPAIR_MAX: "1",
  });
  if (configuration.isErr()) throw new Error(configuration.error.message);
  return configuration.value;
}

function runtimeStore(...runIds: string[]): RuntimeStore {
  const runs = new Map(runIds.map(runId => [runId, run(runId)]));
  return {
    getRun: (runId: string) => runs.get(runId),
    getRunEventVersion: (runId: string) => runs.get(runId)?.eventCount,
    writeNodeProgress: vi.fn(),
    observationLog: { markFenced: vi.fn(() => Promise.resolve()) },
  } as unknown as RuntimeStore;
}

function run(id: string): RunDetails {
  return {
    id,
    name: id,
    status: "pending",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "sha256:test",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 1,
    execution: { state: "inactive", lastStatus: "pending" },
  };
}
