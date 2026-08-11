import type { WorkflowIR } from "@acpus/core/ir";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "../src/hooks/config.js";
import { dispatchCommittedHooksForRun, type HookContext } from "../src/hooks/dispatch.js";
import type { SchedulerProjection } from "../src/scheduler/types.js";
import { decodeCommittedRuntimeEventRow, type CommittedRuntimeEventRow } from "../src/store/committed-event.js";
import type { FrozenRun, RuntimeStore } from "../src/store/store.js";

describe("hooks events and context", () => {
  it("decodes scheduler envelopes and public run event payloads", () => {
    const decode = (type: string, payload: unknown) => decodeCommittedRuntimeEventRow({
      run_id: "run_1",
      sequence: 1,
      type,
      node_key: null,
      payload_json: JSON.stringify(payload),
      created_at: "2026-07-04T00:00:00.000Z",
      idempotency_key: "event:1",
    }).payload;
    expect(decode("instance.started", { schedulerEventVersion: 1, payload: { nodeKey: "build" } })).toEqual({ nodeKey: "build" });
    expect(decode("run.completed", { output: { ok: true } })).toEqual({ output: { ok: true } });
  });

  it("maps committed events and builds contexts only through the durable dispatch seam", () => {
    const events = [
      row("frame.started", { runId: "run_1", frameKey: "root", frameKind: "root" }, 1),
      row("frame.started", { runId: "run_1", frameKey: "nested", frameKind: "node" }, 2),
      row("run.completed", { output: { shipped: true } }, 3),
      row("run.failed", { message: "bad" }, 4),
      row("run.canceled", { reason: "operator_cancelled" }, 5),
      row("instance.started", { nodeKey: "build~1", attemptId: "attempt-task" }, 6, "build~1"),
      row("instance.completed", { nodeKey: "build~1", attemptId: "attempt-task", output: { ok: true } }, 7, "build~1"),
      row("instance.completed", { nodeKey: "build~1", output: { inherited: true } }, 8, "build~1"),
      row("instance.failed", { nodeKey: "review~1", error: { reason: "expression_resolution_failed" } }, 9, "review~1"),
      row("instance.started", { nodeKey: "review~1", attemptId: "attempt-agent", output: { ignored: true }, error: { message: "ignored" } }, 10, "review~1"),
      row("signal.awaiting", { nodeKey: "approve~1" }, 11, "approve~1"),
      row("attempt.completed", { attemptId: "attempt-task" }, 12),
      row("control.agent_steer_requested", {
        steerId: "steer-1",
        requestedTarget: "review",
        nodeKey: "review~1",
        fencedAttemptId: "attempt-agent",
        instruction: "SECRET correction",
      }, 13),
    ];
    const executionMetadata = [
      { id: 1, attemptId: "attempt-task", kind: "task_attempt", metadata: { nodeKey: "build~1", input: { packageName: "core" } }, createdAt: "2026-07-04T00:00:01.000Z" },
      { id: 2, attemptId: "attempt-agent", kind: "agent_attempt", metadata: { nodeKey: "review~1" }, createdAt: "2026-07-04T00:00:02.000Z" },
    ] satisfies ReturnType<RuntimeStore["getExecutionMetadata"]>;
    const calls: Array<{ event: HookEvent; context: HookContext }> = [];
    const store = runtimeStore(events, executionMetadata);
    const hookRunner = {
      trigger(event: HookEvent, context: HookContext) {
        calls.push({ event, context });
      },
    };

    expect(dispatchCommittedHooksForRun({ cwd: "/workspace", runId: "run_1", store, hookRunner })).toEqual(ok({
      runId: "run_1",
      eventSequence: 13,
      dispatched: 10,
    }));
    expect(calls.map(call => call.event)).toEqual([
      "run.started",
      "run.completed",
      "run.failed",
      "run.canceled",
      "node.started",
      "node.completed",
      "node.completed",
      "node.failed",
      "node.started",
      "run.awaiting",
    ]);
    expect(contextAt(calls, 1)).toMatchObject({
      event: "run.started",
      eventSequence: 1,
      run: { id: "run_1", workflowName: "release", workflowPath: "/workspace/workflow.ts", status: "running" },
    });
    expect(contextAt(calls, 3)).toMatchObject({
      event: "run.completed",
      eventSequence: 3,
      run: { id: "run_1", workflowName: "release", workflowPath: "/workspace/workflow.ts", status: "completed" },
      output: { shipped: true },
    });
    expect(contextAt(calls, 7).node).toMatchObject({
      id: "build",
      key: "build~1",
      kind: "task",
      status: "completed",
      output: { ok: true },
      taskInput: { packageName: "core" },
    });
    expect(contextAt(calls, 8).node).not.toHaveProperty("taskInput");
    expect(contextAt(calls, 10).node).toMatchObject({
      id: "review",
      key: "review~1",
      kind: "agent",
      status: "running",
    });
    expect(contextAt(calls, 10).node).not.toMatchObject({ output: expect.anything(), error: expect.anything() });
    expect(contextAt(calls, 9).node).toMatchObject({ id: "review", status: "failed", error: { message: "expression_resolution_failed" } });
    expect(contextAt(calls, 9).node).not.toHaveProperty("agentPrompt");
    expect(contextAt(calls, 11)).toMatchObject({
      run: { status: "awaiting" },
      signal: { nodeId: "approve", nodeKey: "approve~1", prompt: "Approve release?" },
      node: { id: "approve", key: "approve~1", kind: "signal", status: "awaiting" },
    });

    expect(dispatchCommittedHooksForRun({ cwd: "/workspace", runId: "run_1", store, hookRunner })).toEqual(ok({
      runId: "run_1",
      eventSequence: 13,
      dispatched: 0,
    }));
    expect(calls).toHaveLength(10);
  });
});

function runtimeStore(
  events: readonly CommittedRuntimeEventRow[],
  executionMetadata: ReturnType<RuntimeStore["getExecutionMetadata"]>,
): RuntimeStore {
  let cursor = 0;
  return {
    getFrozenRun: () => frozenRun(),
    getHookDispatchCursor: () => cursor,
    readHookDispatchEvents: (_runId: string, afterSequence: number) => ({
      lastSequence: events.at(-1)?.sequence ?? 0,
      events: events.filter(event => event.sequence > afterSequence).slice(0, 1),
    }),
    compareAndSetHookDispatchCursor: (_runId: string, expectedSequence: number, nextSequence: number) => {
      if (cursor !== expectedSequence) return false;
      cursor = nextSequence;
      return true;
    },
    getExecutionMetadata: () => executionMetadata,
    scheduler: {
      tryLoadRunSnapshot: () => ok({ runId: "run_1", version: events.length, projection: schedulerProjection() }),
    },
  } as unknown as RuntimeStore;
}

function frozenRun(): FrozenRun {
  return {
    ir: workflow(),
    input: {},
    agentOverrides: {},
    meta: { runId: "run_1", workflowName: "release", workflowPath: "workflow.ts", workspaceDir: "/workspace" },
  };
}

function contextAt(calls: readonly { context: HookContext }[], eventSequence: number): HookContext {
  const context = calls.find(call => call.context.eventSequence === eventSequence)?.context;
  if (!context) throw new Error(`Missing hook context for event sequence ${eventSequence}.`);
  return context;
}

function row(type: string, payload: Record<string, unknown>, sequence = 1, nodeKey?: string): CommittedRuntimeEventRow {
  return {
    runId: "run_1",
    sequence,
    type,
    ...(nodeKey === undefined ? {} : { nodeKey }),
    payload,
    createdAt: "2026-07-04T00:00:00.000Z",
    idempotencyKey: `${type}:${sequence}`,
  };
}

function workflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "release",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [
        {
          id: "build",
          kind: "task",
          run: {
            input: {
              kind: "object",
              fields: {
                packageName: {
                  kind: "call",
                  fn: "lift",
                  args: [
                    { kind: "literal", value: "authored" },
                    { kind: "literal", value: "value => { throw new Error(`task input must not re-evaluate: ${value}`); }" },
                  ],
                },
              },
            },
            target: { kind: "inline", source: "export default async () => ({ ok: true })" },
          },
        },
        {
          id: "review",
          kind: "agent",
          run: {
            agent: "reviewer",
            prompt: {
              kind: "call",
              fn: "lift",
              args: [
                { kind: "literal", value: "authored" },
                { kind: "literal", value: "value => { throw new Error(`agent prompt must not re-evaluate: ${value}`); }" },
              ],
            },
          },
        },
        {
          id: "approve",
          kind: "signal",
          run: {
            prompt: { kind: "literal", value: "Approve release?" },
          },
        },
      ],
    },

    diagnostics: [],
  };
}

function schedulerProjection(): SchedulerProjection {
  return {
    run: { runId: "run_1", status: "completed", paused: false },
    frames: { root: { runId: "run_1", frameKey: "root", frameKind: "root", status: "completed", scope: {} } },
    instances: {
      "build~1": { runId: "run_1", nodeKey: "build~1", nodeId: "build", status: "completed", instancePath: [{ kind: "node", nodeId: "build" }], output: { ok: true } },
      "review~1": { runId: "run_1", nodeKey: "review~1", nodeId: "review", status: "completed", instancePath: [{ kind: "node", nodeId: "review" }] },
      "approve~1": { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", status: "awaiting", instancePath: [{ kind: "node", nodeId: "approve" }] },
    },
    attempts: {},
    groups: {},
    groupMembers: {},
    signalWaits: {
      "approve~1": { runId: "run_1", nodeKey: "approve~1", nodeId: "approve", status: "awaiting", renderedPrompt: "Approve release?" },
    },
    branchDecisions: {},
  };
}
