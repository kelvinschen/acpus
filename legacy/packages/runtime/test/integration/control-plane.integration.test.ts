import { describe, it, expect, afterEach } from "vitest";
import type { IrNodeKind } from "@acpus/core";
import type { AgentTelemetry, NodeExecutionState, NodeState } from "../../src/types.js";
import type { RunStore } from "../../src/store.js";
import { compileYaml, createTestInterpreter, waitForNodeState } from "../interpreter/helper.js";

describe("Run Control", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
    cleanups.length = 0;
  });

  it("pauses running materialized nodes and the Run", async () => {
    const ir = compileYaml(`
version: 1
name: pause-control
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: slow
      run: agent
      use: coder
      prompt: "slow"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { slow: { output: { ok: true }, delay: 100 } }
    });
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const running = interpreter.runToCompletion(ir, { input: {} }, meta.runId);
    await waitForNodeState(store, meta.runId, "slow", "running", 1000);

    interpreter.pauseRun(meta.runId);
    const finalMeta = await running;

    expect(finalMeta.status).toBe("paused");
    expect(store.readRunMeta(meta.runId)?.status).toBe("paused");
    expect(store.readNodeState(meta.runId, "workflow/slow")?.state).toBe("paused");
  });

  it("cancels cancellable materialized nodes without materializing unvisited nodes", () => {
    const ir = compileYaml(`
version: 1
name: cancel-control
workflow:
  steps:
    - id: first
      run: program
      cmd: "echo first"
    - id: unvisited
      run: program
      cmd: "echo unvisited"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });

    writeNode(store, meta.runId, "workflow", "workflow", "pipeline", "running");
    writeNode(store, meta.runId, "workflow/pending", "pending", "run.program", "pending");
    writeNode(store, meta.runId, "workflow/running", "running", "run.program", "running");
    writeNode(store, meta.runId, "workflow/awaiting", "awaiting", "run.signal", "awaiting");
    writeNode(store, meta.runId, "workflow/paused", "paused", "run.program", "paused");

    interpreter.cancelRun(meta.runId);

    expect(store.readRunMeta(meta.runId)?.status).toBe("cancelled");
    expect(store.readNodeState(meta.runId, "workflow/pending")?.state).toBe("cancelled");
    expect(store.readNodeState(meta.runId, "workflow/running")?.state).toBe("cancelled");
    expect(store.readNodeState(meta.runId, "workflow/awaiting")?.state).toBe("cancelled");
    expect(store.readNodeState(meta.runId, "workflow/paused")?.state).toBe("cancelled");
    expect(store.readNodeState(meta.runId, "workflow/unvisited")).toBeUndefined();
    expect(store.readCheckpoints(meta.runId).map((checkpoint) => [checkpoint.nodeKey, checkpoint.state]).sort()).toEqual([
      ["workflow/awaiting", "cancelled"],
      ["workflow/paused", "cancelled"],
      ["workflow/pending", "cancelled"],
      ["workflow/running", "cancelled"]
    ]);
  });

  it("resumes paused and stale nodes while preserving completed nodes", async () => {
    const ir = compileYaml(`
version: 1
name: resume-control
workflow:
  steps:
    - id: paused
      run: program
      cmd: "echo paused"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });
    meta.status = "paused";
    store.writeRunMeta(meta.runId, meta);

    writeNode(store, meta.runId, "workflow/completed", "completed", "run.program", "completed");
    writeNode(store, meta.runId, "workflow/paused", "paused", "run.program", "paused");
    writeNode(store, meta.runId, "workflow/running", "running", "run.program", "running");
    writeNode(store, meta.runId, "workflow/awaiting", "awaiting", "run.signal", "awaiting");

    await interpreter.resumeRun(meta.runId);

    expect(store.readRunMeta(meta.runId)?.status).toBe("running");
    expect(store.readNodeState(meta.runId, "workflow/completed")?.state).toBe("completed");
    expect(store.readNodeState(meta.runId, "workflow/paused")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/running")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/awaiting")?.state).toBe("pending");
  });

  it("retry resets failed, paused, and cancelled materialized nodes, preserves completed nodes, and increments only runAttempt", () => {
    const ir = compileYaml(`
version: 1
name: retry-control
workflow:
  steps:
    - id: failed
      run: program
      cmd: "echo failed"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });
    meta.status = "failed";
    store.writeRunMeta(meta.runId, meta);

    writeNode(store, meta.runId, "workflow/completed", "completed", "run.program", "completed", { attempt: 3, output: { ok: true } });
    writeNode(store, meta.runId, "workflow/failed", "failed", "run.program", "failed", {
      attempt: 2,
      error: "boom",
      output: { stale: true },
      artifactRefs: ["artifact://runs/run/nodes/workflow/failed/stdout.log"],
      agentTelemetry: staleAgentTelemetry(),
      renderedPrompt: "stale prompt",
      renderedSessionKey: "stale-session",
      completedAt: "2025-01-01T00:01:00Z",
      startedAt: "2025-01-01T00:00:00Z",
      dynamicContext: { item: "old" }
    });
    writeNode(store, meta.runId, "workflow/paused", "paused", "run.program", "paused", {
      attempt: 1,
      error: "Aborted: paused",
      output: { stale: true },
      artifactRefs: ["artifact://runs/run/nodes/workflow/paused/stdout.log"],
      agentTelemetry: staleAgentTelemetry(),
      renderedPrompt: "stale prompt",
      renderedSessionKey: "stale-session",
      completedAt: "2025-01-01T00:01:00Z",
      startedAt: "2025-01-01T00:00:00Z",
      dynamicContext: { item: "old" }
    });
    writeNode(store, meta.runId, "workflow/cancelled", "cancelled", "run.program", "cancelled", {
      attempt: 1,
      error: "Aborted: cancelled",
      output: { stale: true },
      artifactRefs: ["artifact://runs/run/nodes/workflow/cancelled/stdout.log"],
      agentTelemetry: staleAgentTelemetry(),
      renderedPrompt: "stale prompt",
      renderedSessionKey: "stale-session",
      completedAt: "2025-01-01T00:01:00Z",
      startedAt: "2025-01-01T00:00:00Z",
      dynamicContext: { item: "old" }
    });

    interpreter.retryRun(meta.runId);

    expect(store.readRunMeta(meta.runId)?.status).toBe("running");
    expect(store.readRunMeta(meta.runId)?.runAttempt).toBe(2);
    expect(store.readNodeState(meta.runId, "workflow/completed")?.state).toBe("completed");
    expect(store.readNodeState(meta.runId, "workflow/completed")?.attempt).toBe(3);
    expect(store.readNodeState(meta.runId, "workflow/failed")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/failed")?.attempt).toBe(2);
    expect(store.readNodeState(meta.runId, "workflow/paused")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/cancelled")?.state).toBe("pending");
    for (const nodeKey of ["workflow/failed", "workflow/paused", "workflow/cancelled"]) {
      const reset = store.readNodeState(meta.runId, nodeKey);
      expect(reset?.error).toBeUndefined();
      expect(reset?.output).toBeUndefined();
      expect(reset?.artifactRefs).toBeUndefined();
      expect(reset?.completedAt).toBeUndefined();
      expect(reset?.startedAt).toBeUndefined();
      expect(reset?.dynamicContext).toBeUndefined();
      expect(reset?.renderedPrompt).toBeUndefined();
      expect(reset?.renderedSessionKey).toBeUndefined();
      expect(reset?.agentTelemetry).toBeUndefined();
    }
  });

  it("recovers stale running and awaiting nodes to pending", () => {
    const ir = compileYaml(`
version: 1
name: stale-control
workflow:
  steps:
    - id: done
      run: program
      cmd: "echo done"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });

    writeNode(store, meta.runId, "workflow/running", "running", "run.program", "running");
    writeNode(store, meta.runId, "workflow/awaiting", "awaiting", "run.signal", "awaiting");
    store.writeTerminalNodeState(meta.runId, {
      nodeKey: "workflow/completed",
      nodeId: "completed",
      kind: "run.program",
      state: "completed",
      attempt: 1,
      definitionHash: "sha256:completed",
      completedAt: "2025-01-01T00:01:00Z"
    });
    writeNode(store, meta.runId, "workflow/failed", "failed", "run.program", "failed");
    const checkpointsBeforeRecovery = store.readCheckpoints(meta.runId);

    interpreter.recoverStaleNodes(meta.runId);

    expect(store.readNodeState(meta.runId, "workflow/running")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/awaiting")?.state).toBe("pending");
    expect(store.readNodeState(meta.runId, "workflow/completed")?.state).toBe("completed");
    expect(store.readNodeState(meta.runId, "workflow/failed")?.state).toBe("failed");
    expect(store.readCheckpoints(meta.runId)).toEqual(checkpointsBeforeRecovery);
  });

  it("Node Retry rejects non-failed or non-executable nodes and does not increment runAttempt", async () => {
    const ir = compileYaml(`
version: 1
name: node-retry-control
workflow:
  steps:
    - id: failed
      run: program
      cmd: "echo failed"
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });
    meta.status = "failed";
    store.writeRunMeta(meta.runId, meta);

    writeNode(store, meta.runId, "workflow/completed", "completed", "run.program", "completed");
    writeNode(store, meta.runId, "workflow/failed-composite", "failed-composite", "pipeline", "failed");

    await expect(interpreter.retryNode(meta.runId, "workflow/completed")).rejects.toThrow(/only failed executable nodes are retryable/);
    await expect(interpreter.retryNode(meta.runId, "workflow/failed-composite")).rejects.toThrow(/only failed executable nodes are retryable/);
    expect(store.readRunMeta(meta.runId)?.runAttempt).toBe(1);
  });
});

function writeNode(
  store: RunStore,
  runId: string,
  nodeKey: string,
  nodeId: string,
  kind: IrNodeKind,
  state: NodeState,
  extra: Partial<NodeExecutionState> = {}
): void {
  store.writeNodeState(runId, {
    nodeKey,
    nodeId,
    kind,
    definitionHash: `sha256:${nodeId}`,
    state,
    attempt: 1,
    ...extra
  });
}

function staleAgentTelemetry(): AgentTelemetry {
  return {
    currentAttempt: 1,
    attempts: [{
      attempt: 1,
      state: "completed",
      startedAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:30Z",
      context: { used: 10, size: 100, updatedAt: "2025-01-01T00:00:30Z" },
      input: { preview: "old prompt", truncated: false, originalBytes: 10, headBytes: 10 },
      tools: {
        totalToolCallCount: 0,
        droppedToolCallCount: 0,
        recentCalls: []
      }
    }]
  };
}
