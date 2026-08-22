import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { makeNodeProcessHost } from "@acpus/owned-process";
import { it } from "@effect/vitest";
import { beforeEach, describe, expect, vi } from "vitest";
import { tryLoadRuntimeConfiguration } from "../src/configuration.js";
import type { dispatchCommittedHooksForRun as DispatchCommittedHooksForRun } from "../src/hooks/dispatch.js";
import type { applySchedulerControlIntent as ApplySchedulerControlIntent } from "../src/scheduler/control.js";
import type { createRuntimeRunScheduler as CreateRuntimeRunScheduler, RunExecution, RuntimeRunScheduler } from "../src/scheduler/runtime-runner.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";
import type { RunDetails, RuntimeStoreAdapter } from "../src/store/store.js";

const applySchedulerControlIntent = vi.fn<typeof ApplySchedulerControlIntent>();
const createRuntimeRunScheduler = vi.fn<typeof CreateRuntimeRunScheduler>();
const dispatchCommittedHooksForRun = vi.fn<typeof DispatchCommittedHooksForRun>(() => Result.succeed({ runId: "run-a", eventSequence: 0, dispatched: 0 }));

vi.mock("../src/scheduler/control.js", () => ({ applySchedulerControlIntent }));
vi.mock("../src/scheduler/runtime-runner.js", () => ({ createRuntimeRunScheduler }));
vi.mock("../src/hooks/dispatch.js", () => ({ dispatchCommittedHooksForRun }));

const { RunExecutionSessions } = await import("../src/daemon/sessions.js");

const schedulerStart = vi.fn<RuntimeRunScheduler["start"]>();
let executions: RunExecution[];
let executionInterruptions: ReturnType<typeof vi.fn>[];

function scopedTest(name: string, test: (scope: Scope.Scope) => Promise<void>): void {
  it.effect(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }));
}

beforeEach(() => {
  executions = [];
  executionInterruptions = [];
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
  scopedTest("passes the startup runtime configuration snapshot to the scheduler factory", async scope => {
    const configuration = runtimeConfiguration();
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a", "run-b"), undefined, configuration, makeNodeProcessHost(), scope);

    await startSession(sessions, "run-a");
    await startSession(sessions, "run-b");

    expect(createRuntimeRunScheduler).toHaveBeenCalledOnce();
    expect(createRuntimeRunScheduler).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      maxLeafConcurrency: 7,
      agentHostPolicy: configuration.agentHostPolicy,
    }));
    expect(createRuntimeRunScheduler.mock.calls[0]![0].agentHostPolicy).toBe(configuration.agentHostPolicy);
    expect(schedulerStart.mock.calls.map(([input]) => input.runId)).toEqual(["run-a", "run-b"]);

    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("wakes an active execution only after durable control succeeds", async scope => {
    const order: string[] = [];
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);
    await startSession(sessions, "run-a");
    executions[0]!.wake = vi.fn(() => {
      order.push("wake");
    });
    applySchedulerControlIntent.mockImplementation(() => {
      order.push("control");
      return Effect.succeed({
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

    await control(sessions, {
      requestId: "signal-1",
      runId: "run-a",
      type: "signal",
      nodeId: "approval",
      payload: "approved",
    });

    expect(order).toEqual(["control", "wake"]);
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("bridges steer to the scheduler and returns its durable receipt without replacing the session", async scope => {
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);
    await startSession(sessions, "run-a");
    const abort = registerAgentTurn();
    applySchedulerControlIntent.mockReturnValue(Effect.succeed({
      snapshot: {} as SchedulerSnapshot,
      effect: {
        type: "steer",
        state: "applied",
        steerId: "steer-1",
        requestedTarget: "review",
        target: "review~000000000001",
        delivery: "interrupt_continue",
        fencedAttemptId: "attempt-1",
        continuation: "queued",
      },
      reopened: false,
    }));

    const result = await control(sessions, {
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
      {
        agentSessionId: "session-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        sessionLeaseId: "lease-1",
      },
    );
    expect(Result.getOrThrow(result)).toMatchObject({
      type: "steer",
      steerId: "steer-1",
      target: "review~000000000001",
      delivery: "interrupt_continue",
      fencedAttemptId: "attempt-1",
      continuation: "queued",
    });
    expect(executions[0]!.wake).toHaveBeenCalledOnce();
    expect(executionInterruptions[0]).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("steer");
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("snapshots the private observation fence before waking the steered execution", async scope => {
    const order: string[] = [];
    const store = runtimeStore("run-a");
    store.observationLog.markFenced = vi.fn(() => {
      return Effect.sync(() => { order.push("fence"); });
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);
    await startSession(sessions, "run-a");
    registerAgentTurn();
    executions[0]!.wake = vi.fn(() => {
      order.push("wake");
    });
    applySchedulerControlIntent.mockImplementation(() => {
      order.push("control");
      return Effect.succeed({
        snapshot: {} as SchedulerSnapshot,
        effect: {
          type: "steer",
          state: "applied",
          steerId: "steer-1",
          requestedTarget: "review",
          target: "review~000000000001",
          delivery: "interrupt_continue",
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

    await control(sessions, {
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
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("does not replace an active execution for a no-op resume", async scope => {
    const type = "resume" as const;
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);
    await startSession(sessions, "run-a");
    applySchedulerControlIntent.mockReturnValue(Effect.succeed({
      snapshot: {} as SchedulerSnapshot,
      effect: { type, state: "applied" },
      reopened: false,
    }));

    await control(sessions, { requestId: `${type}-replay`, runId: "run-a", type });

    expect(executionInterruptions[0]).not.toHaveBeenCalled();
    expect(schedulerStart).toHaveBeenCalledOnce();
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("does not quarantine an interrupted session before starting its reopened replacement", async scope => {
    const store = runtimeStore("run-a");
    schedulerStart
      .mockReturnValueOnce({
        ownerEpoch: Effect.succeed(1),
        result: Effect.never,
        wake: vi.fn(),
      })
      .mockImplementationOnce(() => controlledExecution("run-a"));
    applySchedulerControlIntent.mockImplementation(() => {
      store.getRun("run-a")!.eventCount += 1;
      return Effect.succeed({
        snapshot: {} as SchedulerSnapshot,
        effect: { type: "resume", state: "applied" },
        reopened: true,
      });
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);

    await startSession(sessions, "run-a");
    await control(sessions, { requestId: "resume-applied", runId: "run-a", type: "resume" });
    expect(sessions.activeCount()).toBe(1);
    await expect(startSession(sessions, "run-a")).resolves.toMatchObject({ disposition: "already-active" });

    expect(schedulerStart).toHaveBeenCalledTimes(2);
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("interrupts and awaits each owned session Fiber during executor shutdown", async scope => {
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a"), undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);
    await startSession(sessions, "run-a");

    await Effect.runPromise(sessions.stopExecutors(100));

    expect(sessions.activeCount()).toBe(0);
  });

  scopedTest("does not restart an unchanged rejected run and leaves other runs startable", async scope => {
    const failure = new Error("scheduler invariant failed");
    schedulerStart.mockReturnValueOnce({
      ownerEpoch: Effect.succeed(1),
      result: Effect.die(failure),
      wake: vi.fn(),
    });
    const sessions = new RunExecutionSessions("/workspace", runtimeStore("run-a", "run-b"), undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);

    await startSession(sessions, "run-a");
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0), { interval: 1 });

    await expect(startSession(sessions, "run-a")).resolves.toBeDefined();
    await startSession(sessions, "run-b");
    expect(schedulerStart.mock.calls.map(([input]) => input.runId)).toEqual(["run-a", "run-b"]);
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("allows a failed session to restart after durable state changes", async scope => {
    const store = runtimeStore("run-a");
    schedulerStart.mockReturnValueOnce({
      ownerEpoch: Effect.succeed(1),
      result: Effect.die(new Error("scheduler invariant failed")),
      wake: vi.fn(),
    });
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration(), makeNodeProcessHost(), scope);

    await startSession(sessions, "run-a");
    await vi.waitFor(() => expect(sessions.activeCount()).toBe(0), { interval: 1 });
    store.getRun("run-a")!.eventCount += 1;

    await expect(startSession(sessions, "run-a")).resolves.toBeDefined();
    expect(schedulerStart).toHaveBeenCalledTimes(2);
    await Effect.runPromise(sessions.stopExecutors(100));
  });

  scopedTest("fences a hook projection incident without reloading full run details", async scope => {
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
    const sessions = new RunExecutionSessions("/workspace", store, undefined, runtimeConfiguration(), makeNodeProcessHost(), scope, incident);

    await expect(Effect.runPromise(sessions.dispatchHooks("run-a"))).resolves.toBe("quarantined");
    await expect(Effect.runPromise(sessions.dispatchHooks("run-a"))).resolves.toBe("quarantined");
    expect(getRun).not.toHaveBeenCalled();
    expect(dispatchCommittedHooksForRun).toHaveBeenCalledOnce();
    expect(incident).toHaveBeenCalledOnce();
    expect(incident).toHaveBeenCalledWith({ runId: "run-a", source: "hook", error: corruption });
  });
});

function controlledExecution(_runId: string): RunExecution {
  const interrupted = vi.fn();
  executionInterruptions.push(interrupted);
  return {
    ownerEpoch: Effect.succeed(1),
    result: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(interrupted))),
    wake: vi.fn(),
  };
}

function control(
  sessions: InstanceType<typeof RunExecutionSessions>,
  intent: Parameters<InstanceType<typeof RunExecutionSessions>["control"]>[0],
) {
  return Effect.runPromise(Effect.result(sessions.control(intent)));
}

function startSession(
  sessions: InstanceType<typeof RunExecutionSessions>,
  runId: string,
) {
  return Effect.runPromise(sessions.start(runId));
}

function runtimeConfiguration() {
  const configuration = tryLoadRuntimeConfiguration({
    ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY: "7",
    ACPUS_AGENT_RESPONSE_REPAIR_MAX: "1",
  });
  if (Result.isFailure(configuration)) throw new Error(configuration.failure.message);
  return configuration.success;
}

function runtimeStore(...runIds: string[]): RuntimeStoreAdapter {
  const runs = new Map(runIds.map(runId => [runId, run(runId)]));
  return {
    getRun: (runId: string) => runs.get(runId),
    getRunEventVersion: (runId: string) => runs.get(runId)?.eventCount,
    writeNodeProgress: vi.fn(),
    observationLog: { markFenced: vi.fn(() => Promise.resolve()) },
    scheduler: {
      claimRun: vi.fn((runId: string, ownerId: string) => ({
        runId,
        ownerId,
        ownerEpoch: 2,
        leaseExpiresAt: "2026-07-12T00:01:00.000Z",
      })),
      releaseRun: vi.fn(() => true),
      tryPlanAgentSteer: vi.fn((runId: string) => ({
        runId,
        attemptId: "attempt-1",
        nodeKey: "review~000000000001",
        nodeId: "review",
        attemptNo: 1,
      })),
    },
  } as unknown as RuntimeStoreAdapter;
}

function registerAgentTurn() {
  const registry = createRuntimeRunScheduler.mock.calls[0]?.[0].agentTurnRegistry;
  if (!registry) throw new Error("Expected Agent Turn registry.");
  const abort = vi.fn();
  registry.register({
    runId: "run-a",
    nodeKey: "review~000000000001",
    nodeId: "review",
    agentSessionId: "session-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    sessionLeaseId: "lease-1",
    abort,
  });
  return abort;
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
