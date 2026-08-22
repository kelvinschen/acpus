import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { makeNodeProcessHost } from "@acpus/owned-process";
import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow, z } from "@acpus/core";
import type { WorkflowIR } from "@acpus/core/ir";
import { lift } from "@acpus/expression";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeNodeExecutor as createRuntimeNodeExecutorProduction, type RuntimeNodeExecutorInput } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun } from "./support/effect-scheduler.js";
import { openRuntimeStoreAdapter, type RuntimeStoreAdapter } from "../src/store/store.js";
import { createInlineTaskAttemptHarness, type TaskAttemptRunner } from "./support/task-attempt-harness.js";
import { prepareSyntheticWorkflow, runtimeRow, withRuntimeWorkspace } from "./support/runtime-harness.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { rootFrameStarted } from "./support/scheduler.js";
import { type AgentHostPolicy } from "../src/configuration.js";

const taskMocks = vi.hoisted(() => ({ runTaskAttempt: vi.fn<TaskAttemptRunner>() }));

vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: taskMocks.runTaskAttempt,
}));

let taskAttemptHarness = createInlineTaskAttemptHarness();
beforeEach(() => {
  taskAttemptHarness = createInlineTaskAttemptHarness();
  taskMocks.runTaskAttempt.mockReset().mockImplementation(input => taskAttemptHarness.runAttempt(input));
});
type TestRuntimeNodeExecutorInput = Omit<RuntimeNodeExecutorInput, "agentHostPolicy" | "ir" | "processes">
  & Partial<Pick<RuntimeNodeExecutorInput, "processes">>
  & { ir: WorkflowIR; taskAttemptRunner?: TaskAttemptRunner };
const taskOnlyAgentHostPolicy: AgentHostPolicy = { responseRepair: { type: "valid", max: 0 } };
function createRuntimeNodeExecutor(input: TestRuntimeNodeExecutorInput) {
  const { taskAttemptRunner, ...productionInput } = input;
  if (taskAttemptRunner) taskMocks.runTaskAttempt.mockImplementation(taskAttemptRunner);
  const executor = createRuntimeNodeExecutorProduction({
    ...productionInput,
    processes: productionInput.processes ?? makeNodeProcessHost(),
    agentHostPolicy: taskOnlyAgentHostPolicy,
  } as RuntimeNodeExecutorInput);
  return {
    executeEffect(context: Parameters<typeof executor.execute>[0]) {
      ensureTestInstance(input.store, context.runId, context.nodeKey, context.nodeId);
      return executor.execute(context);
    },
    execute(context: Parameters<typeof executor.execute>[0]) {
      ensureTestInstance(input.store, context.runId, context.nodeKey, context.nodeId);
      return Effect.runPromise(executor.execute(context));
    },
  };
}

const testRunClaims = new WeakMap<RuntimeStoreAdapter, Map<string, NonNullable<ReturnType<RuntimeStoreAdapter["scheduler"]["claimRun"]>>>>();

function ensureTestInstance(store: RuntimeStoreAdapter, runId: string, nodeKey: string, nodeId: string): void {
  const scheduler = throwingSchedulerStore(store.scheduler);
  let snapshot = scheduler.loadRunSnapshot(runId);
  if (snapshot.projection.instances[nodeKey] && snapshot.projection.frames.root) return;
  let claims = testRunClaims.get(store);
  if (!claims) {
    claims = new Map();
    testRunClaims.set(store, claims);
  }
  let claim = claims.get(runId);
  if (!claim) {
    claim = store.scheduler.claimRun(runId, `task-test-${runId}`, 60_000);
    if (!claim) throw new Error(`expected test claim for run '${runId}'`);
    claims.set(runId, claim);
  }
  if (!snapshot.projection.frames.root) {
    snapshot = scheduler.appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `task-test:${runId}:root:${snapshot.version}`,
      events: [rootFrameStarted(runId, nodeId, nodeKey)],
    });
  }
  if (!snapshot.projection.instances[nodeKey]) {
    scheduler.appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `task-test:${runId}:${nodeKey}:ready:${snapshot.version}`,
      events: [{
        type: "instance.ready",
        payload: {
          runId,
          nodeKey,
          nodeId,
          instancePath: [{ kind: "node", nodeId }],
          parentFrameKey: "root",
          readinessSequence: Object.keys(snapshot.projection.instances).length + 1,
        },
      }],
    });
  }
}

function startTestAttempt(store: RuntimeStoreAdapter, runId: string, nodeKey: string, nodeId: string) {
  ensureTestInstance(store, runId, nodeKey, nodeId);
  const claim = testRunClaims.get(store)?.get(runId);
  if (!claim) throw new Error(`Expected test claim for run '${runId}'.`);
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey,
    nodeId,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `task-test:${runId}:${nodeKey}:attempt`,
  });
  return { ...attempt, ownerEpoch: claim.ownerEpoch };
}

describe("scheduler task and signal leaf executor", () => {
  it("runs one task invocation per scheduler-visible attempt", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-single-attempt", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, failingInvocationTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const executor = createRuntimeNodeExecutor({
            cwd: workspace,
            ir: prepared.ir,
            scope: {},
            store,
          });
          const attempt = startTestAttempt(store, run.id, "retry_task.dynamic", "retry_task");

          await expect(executor.execute({
            runId: run.id,
            nodeId: "retry_task",
            nodeKey: "retry_task.dynamic",
            attemptId: attempt.attemptId,
            attemptNo: attempt.attemptNo,
            ownerEpoch: attempt.ownerEpoch,
          })).resolves.toEqual({ status: "failed", reason: "first invocation fails" });
          expect(taskAttemptHarness.calls).toHaveLength(1);
          expect(taskAttemptHarness.calls[0]).toMatchObject({
            nodeId: "retry_task",
            nodeKey: "retry_task.dynamic",
            attempt: 1,
            input: null,
            cwd: workspace,
          });
        } finally {
          store.close();
        }
      });
    });

  it("persists task configuration type failures through scheduler and public run details", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-task-resolution-type", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, wrongTypeTaskConfigWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { cwd: "workspace" }, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({
            status: "failed",
            started: 1,
            failed: 1,
          });

          const expectedError = expect.objectContaining({
            reason: "expression_resolution_failed",
            type: "type",
            field: "Task node 'build' cwd",
            expected: "string",
            actual: "number",
          });
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts)[0]).toMatchObject({
            status: "failed",
            terminalReason: "expression_resolution_failed",
            error: expectedError,
          });
          expect(store.getRun(run.id)?.dynamic?.attempts[0]).toMatchObject({ error: expectedError });
        } finally {
          store.close();
        }
      });
    });

  it("persists signal evaluation failures without creating an attempt", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-signal-resolution-evaluation", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, failingSignalPromptWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { prompt: "approve" }, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed" });

          const expectedError = expect.objectContaining({
            reason: "expression_resolution_failed",
            type: "evaluation",
            field: "Signal node 'approve' prompt",
            message: "lift(...) callback threw: signal prompt exploded: approve",
          });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(Object.values(projection.instances)[0]).toMatchObject({
            status: "failed",
            statusReason: "expression_resolution_failed",
            error: expectedError,
          });
          expect(Object.values(projection.attempts)).toHaveLength(0);
          expect(store.getRun(run.id)?.dynamic?.nodeInstances[0]).toMatchObject({ error: expectedError });
        } finally {
          store.close();
        }
      });
    });

  it("persists task timeout as a scheduler attempt deadline", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-attempt-deadline", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, timeoutTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { timeout: "5s" }, cwd: workspace });
          const now = new Date();
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(now);
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

          expect(runtimeRow(workspace, "SELECT deadline_at FROM node_attempts WHERE run_id = ?", run.id)).toMatchObject({
            deadline_at: new Date(now.getTime() + 5_000).toISOString(),
          });
        } finally {
          vi.useRealTimers();
          store.close();
        }
      });
    });

  it("commits an unrepresentable task deadline as a constraint failure", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-task-deadline-range", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, timeoutTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { timeout: String(Number.MAX_SAFE_INTEGER) }, cwd: workspace });
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
          })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

          expect(taskAttemptHarness.calls).toHaveLength(0);
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts)[0]).toMatchObject({
            status: "failed",
            terminalReason: "expression_resolution_failed",
            error: {
              reason: "expression_resolution_failed",
              type: "constraint",
              field: "task node 'timeout_task' timeout",
              expected: "duration with a representable persisted deadline",
            },
          });
        } finally {
          vi.useRealTimers();
          store.close();
        }
      });
    });

  it("classifies an already-expired task deadline as timed_out", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-expired-task-deadline", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, timeoutTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { timeout: "0ms" }, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({
            status: "failed",
            started: 1,
            failed: 1,
          });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(Object.values(projection.attempts)[0]).toMatchObject({ status: "timed_out", terminalReason: "timed_out" });
          expect(Object.values(projection.instances)[0]).toMatchObject({ status: "failed", statusReason: "timed_out" });
        } finally {
          store.close();
        }
      });
    });

  it("interrupts a Task attempt through its Node Effect Fiber", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-pre-aborted", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, abortStatusTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          let interrupted = false;
          const executor = createRuntimeNodeExecutor({
            cwd: workspace,
            ir: prepared.ir,
            scope: {},
            store,
            taskAttemptRunner: () => Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })),
            ),
          });
          const attempt = startTestAttempt(store, run.id, "abort_task.dynamic", "abort_task");

          const fiber = Effect.runFork(executor.executeEffect({
            runId: run.id,
            nodeId: "abort_task",
            nodeKey: "abort_task.dynamic",
            attemptId: attempt.attemptId,
            attemptNo: attempt.attemptNo,
            ownerEpoch: attempt.ownerEpoch,
          }));
          await vi.waitFor(() => expect(taskMocks.runTaskAttempt).toHaveBeenCalledOnce());
          await Effect.runPromise(Fiber.interrupt(fiber));
          const exit = await Effect.runPromise(Fiber.await(fiber));
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(interrupted).toBe(true);
          expect(taskMocks.runTaskAttempt.mock.calls[0]?.[0]).toMatchObject({
            nodeId: "abort_task",
            cwd: workspace,
            request: {
              input: null,
              artifact: {
                nodeKey: "abort_task.dynamic",
                attempt: attempt.attemptNo,
              },
            },
          });
        } finally {
          store.close();
        }
      });
    });
});

function abortStatusTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-abort",
  }).build(({ step }) => {
    step("abort_task").task({
      input: null,
      exec: async ({ abortSignal }) => ({ aborted: abortSignal.aborted }),
    });
    return {};
  });
}

function failingInvocationTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-retry",
  }).build(({ step }) => {
    step("retry_task").task({
      input: null,
      exec: async () => {
        throw new Error("first invocation fails");
      },
    });
    return {};
  });
}

function wrongTypeTaskConfigWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-task-resolution-type",
    inputSchema: z.object({ cwd: z.string() }),
  }).build(({ input, step }) => {
    step("build").task({
      input: null,
      cwd: lift(input.cwd, value => value.length) as any,
      exec: async () => ({ ok: true }),
    });
    return {};
  });
}

function failingSignalPromptWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-resolution-evaluation",
    inputSchema: z.object({ prompt: z.string() }),
  }).build(({ input, step }) => {
    step("approve").signal({
      prompt: lift(input.prompt, value => { throw new Error(`signal prompt exploded: ${value}`); }),
    });
    return {};
  });
}

function timeoutTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-timeout-deadline",
    inputSchema: z.object({ timeout: z.string() }),
  }).build(({ input, step }) => {
    const task = step("timeout_task").task({
      timeout: input.timeout,
      input: null,
      exec: async () => ({ ok: true }),
    });
    return { ok: task.output.ok };
  });
}
