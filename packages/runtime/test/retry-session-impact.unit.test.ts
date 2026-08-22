import * as Result from "effect/Result";
import type { NodeIR, AdmittedWorkflowIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import { planRetrySessionImpact } from "../src/scheduler/retry-session-impact.js";
import type { FrozenSchedulerRun } from "../src/scheduler/settle.js";
import type { SchedulerSnapshot } from "../src/scheduler/store-port.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";

describe("Retry Session impact planning", () => {
  it("returns the exact sorted and deduplicated local Session set", () => {
    const frozen = frozenWorkflow([agent("first"), agent("second"), task("other")]);
    const snapshot = snapshotWithInstances([
      ["first~1", "first"],
      ["second~1", "second"],
      ["other~1", "other"],
    ]);

    expect(Result.getOrThrow(planRetrySessionImpact({
      frozen,
      snapshot,
      reexecutedNodeKeys: ["second~1", "first~1", "other~1"],
      materializedSessions: [
        { agentSessionId: "session-z", nodeKey: "second~1" },
        { agentSessionId: "session-a", nodeKey: "first~1" },
        { agentSessionId: "session-z", nodeKey: "second~1" },
        { agentSessionId: "unaffected", nodeKey: "not-reexecuted" },
      ],
    }))).toEqual({
      agentSessionIds: ["session-a", "session-z"],
    });
  });

  it("rejects an explicit shared Agent even before Session materialization", () => {
    const frozen = frozenWorkflow([agent("shared", "conversation")]);
    const snapshot = snapshotWithInstances([["shared~1", "shared"]]);

    expect(Result.getOrThrow(Result.flip(planRetrySessionImpact({
      frozen,
      snapshot,
      reexecutedNodeKeys: ["shared~1"],
    })))).toEqual({
      type: "shared_session_retry_requires_fork",
      nodeKey: "shared~1",
    });
  });
});

function frozenWorkflow(nodes: NodeIR[]): FrozenSchedulerRun {
  const ir: AdmittedWorkflowIR = {
    irVersion: 8,
    name: "retry-session-impact",
    agents: { reviewer: { kind: "agent_definition", use: "codex" } },
    root: { nodes, output: { kind: "object", fields: {} } },
    diagnostics: [],
  };
  return { ir, input: {}, meta: {} };
}

function agent(id: string, sessionKey?: string): Extract<NodeIR, { kind: "agent" }> {
  return {
    id,
    kind: "agent",
    run: {
      agent: "reviewer",
      prompt: { kind: "literal", value: "Review" },
      ...(sessionKey === undefined
        ? {}
        : { sessionKey: { kind: "literal", value: sessionKey } }),
    },
  };
}

function task(id: string): Extract<NodeIR, { kind: "task" }> {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "literal", value: null },
      target: { kind: "inline", source: "async function task() {}" },
    },
  };
}

function snapshotWithInstances(instances: ReadonlyArray<readonly [nodeKey: string, nodeId: string]>): SchedulerSnapshot {
  const events: SchedulerEvent[] = [
    { type: "frame.started", payload: { runId: "run", frameKey: "root", frameKind: "root" } },
    ...instances.map(([nodeKey, nodeId]) => ({
      type: "instance.ready" as const,
      payload: { runId: "run", nodeKey, nodeId, parentFrameKey: "root", instancePath: [] },
    })),
  ];
  return {
    runId: "run",
    version: events.length,
    projection: applySchedulerEvents(createSchedulerProjection("run"), events),
  };
}
