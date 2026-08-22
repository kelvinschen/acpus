import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeNodeProcessHost } from "@acpus/owned-process";
import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow, z } from "@acpus/core";
import type { JsonValue } from "@acpus/expression/ir";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentHostPolicy } from "../src/configuration.js";
import { appendBranch, appendFanoutItem, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeRunScheduler } from "../src/scheduler/runtime-runner.js";
import { advanceFrozenRun } from "./support/effect-scheduler.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-harness.js";
import { createInlineTaskAttemptHarness, type TaskAttemptRunner } from "./support/task-attempt-harness.js";

const taskMocks = vi.hoisted(() => ({ runTaskAttempt: vi.fn<TaskAttemptRunner>() }));

vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: taskMocks.runTaskAttempt,
}));

let taskAttemptHarness = createInlineTaskAttemptHarness();
beforeEach(() => {
  taskAttemptHarness = createInlineTaskAttemptHarness();
  let failedOnce = false;
  taskMocks.runTaskAttempt.mockReset().mockImplementation(input => {
    if (input.nodeId === "item_task" && taskInputItem(input.request.input) === "fail" && !failedOnce) {
      failedOnce = true;
      return Effect.succeed(Result.fail({ type: "failed" as const, message: "fail once" }));
    }
    return taskAttemptHarness.runAttempt(input);
  });
});

describe("runtime targeted retry completion closure", () => {
  it("restores parent-failed all dependencies and completes without rerunning finished work", async () => {
    await withRuntimeWorkspace("scheduler-targeted-retry-completion-closure", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nestedAllRetryWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, {
          prepared,
          input: { items: ["done", "fail", "recover"] },
          cwd: workspace,
        });
        const itemsBranchPath = appendBranch([], "combine", "items");
        const siblingBranchKey = deriveInstanceKey(appendBranch([], "combine", "sibling"));
        const itemPaths = [0, 1, 2].map(index => appendFanoutItem(itemsBranchPath, "work_items", index));
        const itemMemberKeys = itemPaths.map(deriveInstanceKey);
        const itemTaskKeys = itemPaths.map(path => deriveInstanceKey(appendNode(path, "item_task")));

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "initial-owner",
          store,
        })).resolves.toMatchObject({ status: "failed" });

        const failed = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(failed.groupMembers[itemMemberKeys[0]!]).toMatchObject({ status: "completed" });
        expect(failed.instances[itemTaskKeys[0]!]).toMatchObject({
          status: "completed",
          output: { value: "root-done-0" },
        });
        expect(failed.groupMembers[itemMemberKeys[1]!]).toMatchObject({ status: "failed" });
        expect(failed.instances[itemTaskKeys[1]!]).toMatchObject({ status: "failed" });
        expect(failed.groupMembers[itemMemberKeys[2]!]).toMatchObject({
          status: "cancelled",
          terminalReason: "parent_failed",
        });
        expect(failed.groupMembers[siblingBranchKey]).toMatchObject({
          status: "cancelled",
          terminalReason: "parent_failed",
        });

        const retry = await applySchedulerControlIntent(workspace, store, {
          requestId: `retry:${run.id}:${itemTaskKeys[1]}`,
          runId: run.id,
          type: "retry",
          target: itemTaskKeys[1]!,
        }, { ownerId: "retry-control", advance: false });
        expect(retry.snapshot.projection.instances[itemTaskKeys[1]!]).toMatchObject({
          status: "ready",
          statusReason: "retry",
        });
        expect(retry.snapshot.projection.groupMembers[itemMemberKeys[0]!]).toMatchObject({ status: "completed" });
        expect(retry.snapshot.projection.groupMembers[itemMemberKeys[2]!]).toMatchObject({ status: "ready" });
        expect(retry.snapshot.projection.groupMembers[siblingBranchKey]).toMatchObject({ status: "ready" });

        const execution = createRuntimeRunScheduler({
          processes: makeNodeProcessHost(),
          cwd: workspace,
          store,
          maxLeafConcurrency: 4,
          agentHostPolicy: loadAgentHostPolicy(process.env),
        }).start({ runId: run.id, ownerId: "retry-owner" });
        const exit = Result.getOrThrow((await Effect.runPromise(execution.result)));

        expect(exit).toMatchObject({ status: "completed" });
        const completed = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(completed.frames.root).toMatchObject({
          status: "completed",
          result: {
            values: [
              { value: "root-done-0" },
              { value: "root-fail-1" },
              { value: "root-recover-2" },
            ],
            sibling: "root-sibling",
          },
        });
        expect(completed.groupMembers[itemMemberKeys[2]!]).toMatchObject({ status: "completed" });
        expect(completed.groupMembers[siblingBranchKey]).toMatchObject({ status: "completed" });
        expect(taskAttemptHarness.calls.filter(call => taskInputItem(call.input) === "done")).toHaveLength(1);
        expect(taskAttemptHarness.calls.filter(call => taskInputItem(call.input) === "fail")).toHaveLength(1);
        expect(taskAttemptHarness.calls.filter(call => taskInputItem(call.input) === "recover")).toHaveLength(1);
        expect(taskAttemptHarness.calls.filter(call => call.nodeId === "prepare")).toHaveLength(1);
        expect(taskMocks.runTaskAttempt.mock.calls.filter(([input]) => taskInputItem(input.request.input) === "fail")).toHaveLength(2);
      } finally {
        store.close();
      }
    });
  });
});

function taskInputItem(input: JsonValue): JsonValue | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input.item : undefined;
}

function nestedAllRetryWorkflow() {
  return defineWorkflow({
    name: "scheduler-targeted-retry-completion-closure",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    const prepare = step("prepare").task({
      input: null,
      exec: async () => ({ prefix: "root" }),
    });
    const combined = step("combine").parallel({
      maxConcurrency: 1,
      branches: {
        items() {
          const workItems = step("work_items").fanout({
            over: input.items,
            maxConcurrency: 1,
            do({ item, itemIndex }) {
              const task = step("item_task").task({
                input: { prefix: prepare.output.prefix, item, itemIndex },
                exec: async ({ input: taskInput }) => ({
                  value: `${taskInput.prefix}-${taskInput.item}-${taskInput.itemIndex}`,
                }),
              });
              return { value: task.output.value };
            },
          });
          return { values: workItems.output };
        },
        sibling() {
          const task = step("sibling_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input: taskInput }) => ({ value: `${taskInput.prefix}-sibling` }),
          });
          return { value: task.output.value };
        },
      },
    });
    return {
      values: combined.output.items.values,
      sibling: combined.output.sibling.value,
    };
  });
}
