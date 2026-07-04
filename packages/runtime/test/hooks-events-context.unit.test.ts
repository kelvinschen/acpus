import type { WorkflowIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import type { EvaluationScope } from "../src/evaluation/evaluator.js";
import { buildHookContext } from "../src/hooks/context.js";
import { decodeRuntimeEventPayload, mapRuntimeEventToHookEvent, type CommittedRuntimeEventRow } from "../src/hooks/events.js";
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
    expect(decodeRuntimeEventPayload(JSON.stringify({ schedulerEventVersion: 1, payload: { nodeKey: "build" } }), "instance.started")).toEqual({ nodeKey: "build" });
    expect(decodeRuntimeEventPayload(JSON.stringify({ output: { ok: true } }), "run.completed")).toEqual({ output: { ok: true } });
  });

  it("builds run, task, agent, and signal hook context fields", () => {
    const ir = workflow();
    const projection = schedulerProjection();
    const baseScope: EvaluationScope = {
      input: { packageName: "core" },
      nodes: { prepare: { status: "completed", output: { tag: "ready" } } },
      meta: { runId: "run_1", workflowName: "release", workspaceDir: "/workspace" },
      fanout: {},
      loop: {},
    };

    expect(buildHookContext({
      row: row("frame.started", { runId: "run_1", frameKey: "root", frameKind: "root" }, 41),
      hookEvent: "run.started",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      baseScope,
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
      baseScope,
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
      baseScope,
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
      baseScope,
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
      baseScope,
    }).node).not.toMatchObject({ output: expect.anything(), error: expect.anything() });

    expect(buildHookContext({
      row: row("signal.awaiting", { nodeKey: "approve~1" }, 45, "approve~1"),
      hookEvent: "run.awaiting",
      projection,
      ir,
      workspaceDir: "/workspace",
      workflowPath: "/workspace/workflow.ts",
      baseScope,
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
    irVersion: 2,
    name: "release",
    agents: {},
    root: {
      nodes: [
        {
          id: "build",
          kind: "task",
          run: {
            kind: "task_run",
            input: { packageName: { kind: "ref", path: ["input", "packageName"] } },
            target: { kind: "inline", runtime: "node", source: "export default async () => ({ ok: true })" },
          },
        },
        {
          id: "review",
          kind: "agent",
          run: {
            kind: "agent_run",
            agent: "reviewer",
            prompt: {
              kind: "template",
              parts: [
                { kind: "text", value: "Review " },
                { kind: "expr", expr: { kind: "ref", path: ["nodes", "prepare", "output", "tag"] } },
              ],
            },
          },
        },
        {
          id: "approve",
          kind: "signal",
          run: {
            kind: "signal_run",
            prompt: { kind: "template", parts: [{ kind: "text", value: "Approve release?" }] },
          },
        },
      ],
    },
    outputs: {},
    lock: { acpusCoreVersion: "0.0.0", generatedAt: "2026-07-04T00:00:00.000Z", notes: [] },
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
