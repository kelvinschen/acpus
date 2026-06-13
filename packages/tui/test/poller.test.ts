import { describe, expect, it } from "vitest";
import type { NodeExecutionState, RunState } from "@acpus/runtime";
import { snapshotFingerprint } from "../src/poller.js";

const run: RunState = {
  runId: "run_1",
  workflowName: "workflow",
  status: "running",
  irDigest: "ir",
  inputDigest: "input",
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:01.000Z",
  runAttempt: 1
};

const nodes: NodeExecutionState[] = [
  {
    nodeKey: "workflow/task",
    nodeId: "task",
    kind: "run.program",
    state: "running",
    attempt: 1,
    startedAt: "2026-06-11T00:00:01.000Z"
  }
];

describe("snapshotFingerprint", () => {
  it("stays stable for identical snapshots", () => {
    expect(snapshotFingerprint({ ...run }, nodes.map((node) => ({ ...node })))).toBe(
      snapshotFingerprint({ ...run }, nodes.map((node) => ({ ...node })))
    );
  });

  it("changes when run or node render inputs change", () => {
    const base = snapshotFingerprint(run, nodes);

    expect(snapshotFingerprint({ ...run, status: "completed" }, nodes)).not.toBe(base);
    expect(snapshotFingerprint({ ...run, output: { verdict: "ship" } }, nodes)).not.toBe(base);
    expect(snapshotFingerprint({ ...run, error: "workflow output failed" }, nodes)).not.toBe(base);
    expect(snapshotFingerprint(run, [{ ...nodes[0], state: "completed", output: { ok: true } }])).not.toBe(base);
  });

  it("changes when agent telemetry changes", () => {
    const agentNode: NodeExecutionState = {
      nodeKey: "workflow/agent",
      nodeId: "agent",
      kind: "run.agent",
      state: "running",
      attempt: 1,
      agentTelemetry: {
        currentAttempt: 1,
        attempts: [{
          attempt: 1,
          state: "running",
          startedAt: "2026-06-11T00:00:01.000Z",
          updatedAt: "2026-06-11T00:00:01.000Z",
          input: { preview: "prompt", truncated: false, originalBytes: 6, headBytes: 6 },
          tools: {
            totalToolCallCount: 0,
            droppedToolCallCount: 0,
            recentCalls: []
          }
        }]
      }
    };
    const base = snapshotFingerprint(run, [agentNode]);
    const changed = {
      ...agentNode,
      agentTelemetry: {
        currentAttempt: 1,
        attempts: [{
          ...agentNode.agentTelemetry!.attempts[0],
          updatedAt: "2026-06-11T00:00:02.000Z",
          tools: {
            totalToolCallCount: 1,
            droppedToolCallCount: 0,
            recentCalls: []
          }
        }]
      }
    };

    expect(snapshotFingerprint(run, [changed])).not.toBe(base);
  });
});
