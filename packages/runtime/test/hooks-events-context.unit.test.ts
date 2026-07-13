import type { WorkflowIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { buildHookContext } from "../src/hooks/context.js";
import { decodeCommittedRuntimeEventRow, mapRuntimeEventToHookEvent, type CommittedRuntimeEventRow } from "../src/hooks/events.js";
import type { SchedulerProjection } from "../src/scheduler/types.js";

describe("hooks events and context", () => {
  it("maps supported committed runtime rows to hook events", () => {
    expect(mapRuntimeEventToHookEvent(row("frame.started", { runId: "run_1", frameKey: "root", frameKind: "root" }))).toBe("run.started");
    expect(mapRuntimeEventToHookEvent(row("run.completed", { output: { ok: true } }))).toBe("run.completed");
    expect(mapRuntimeEventToHookEvent(row("run.failed", { message: "bad" }))).toBe("run.failed");
    expect(mapRuntimeEventToHookEvent(row("run.canceled", { reason: "operator_cancelled" }))).toBe("run.canceled");
    expect(mapRuntimeEventToHookEvent(row("instance.started", { nodeKey: "build" }))).toBe("node.started");
    expect(mapRuntimeEventToHookEvent(row("instance.completed", { nodeKey: "build" }))).toBe("node.completed");
    expect(mapRuntimeEventToHookEvent(row("instance.failed", { nodeKey: "build" }))).toBe("node.failed");
    expect(mapRuntimeEventToHookEvent(row("signal.awaiting", { nodeKey: "approve", nodeId: "approve" }))).toBe("run.awaiting");
  });

  it("does not map unrelated scheduler rows", () => {
    expect(mapRuntimeEventToHookEvent(row("frame.started", { runId: "run_1", frameKey: "node", frameKind: "node" }))).toBeUndefined();
    expect(mapRuntimeEventToHookEvent(row("attempt.completed", { attemptId: "attempt_1" }))).toBeUndefined();
  });

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

  it("builds run, task, agent, and signal hook context fields", () => {
    const ir = workflow();
    const projection = schedulerProjection();
    const executionMetadata = [
      { id: 1, kind: "task_attempt", metadata: { nodeKey: "build~1", input: { packageName: "core" } }, createdAt: "2026-07-04T00:00:01.000Z" },
      { id: 2, kind: "agent_attempt", metadata: { nodeKey: "review~1" }, createdAt: "2026-07-04T00:00:02.000Z" },
    ];

    expect(buildHookContext({
      row: row("frame.started", { runId: "run_1", frameKey: "root", frameKind: "root" }, 41),
      hookEvent: "run.started",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
    })).toMatchObject({
      event: "run.started",
      eventSequence: 41,
      run: { id: "run_1", workflowName: "release", workflowPath: "/workspace/workflow.ts", status: "running" },
    });

    expect(buildHookContext({
      row: row("run.completed", { output: { shipped: true } }, 42),
      hookEvent: "run.completed",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
    })).toMatchObject({
      event: "run.completed",
      eventSequence: 42,
      run: { id: "run_1", workflowName: "release", workflowPath: "/workspace/workflow.ts", status: "completed" },
      output: { shipped: true },
    });

    expect(buildHookContext({
      row: row("instance.completed", { nodeKey: "build~1", output: { ok: true } }, 43, "build~1"),
      hookEvent: "node.completed",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
    }).node).toMatchObject({
      id: "build",
      key: "build~1",
      kind: "task",
      status: "completed",
      output: { ok: true },
      taskInput: { packageName: "core" },
    });

    expect(buildHookContext({
      row: row("instance.started", { nodeKey: "review~1", output: { ignored: true }, error: { message: "ignored" } }, 44, "review~1"),
      hookEvent: "node.started",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
      agentPrompts: new Map([["review~1", "Review ready"]]),
    }).node).toMatchObject({
      id: "review",
      key: "review~1",
      kind: "agent",
      status: "running",
      agentPrompt: "Review ready",
    });
    expect(buildHookContext({
      row: row("instance.started", { nodeKey: "review~1", output: { ignored: true }, error: { message: "ignored" } }, 44, "review~1"),
      hookEvent: "node.started",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
    }).node).not.toMatchObject({ output: expect.anything(), error: expect.anything() });

    const unresolvedAgent = buildHookContext({
      row: row("instance.failed", { nodeKey: "review~1", error: { reason: "expression_resolution_failed" } }, 45, "review~1"),
      hookEvent: "node.failed",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata: [],
    });
    expect(unresolvedAgent.node).toMatchObject({ id: "review", status: "failed" });
    expect(unresolvedAgent.node).not.toHaveProperty("agentPrompt");

    expect(buildHookContext({
      row: row("signal.awaiting", { nodeKey: "approve~1" }, 46, "approve~1"),
      hookEvent: "run.awaiting",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      executionMetadata,
    })).toMatchObject({
      run: { status: "awaiting" },
      signal: { nodeId: "approve", nodeKey: "approve~1", prompt: "Approve release?" },
      node: { id: "approve", key: "approve~1", kind: "signal", status: "awaiting" },
    });
  });
});

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
    irVersion: 5,
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
              packageName: {
                kind: "call",
                fn: "lift",
                args: [
                  { kind: "literal", value: "authored" },
                  { kind: "literal", value: "value => { throw new Error(`task input must not re-evaluate: ${value}`); }" },
                ],
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
