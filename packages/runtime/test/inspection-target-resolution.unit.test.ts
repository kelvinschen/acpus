import { describe, expect, it } from "vitest";
import type { AdmittedWorkflowIR } from "@acpus/core/ir";
import { resolveTargetState } from "../src/inspection/projection.js";
import {
  deriveOccurrenceRef,
  resolveOccurrenceRefCandidate,
} from "../src/scheduler/occurrence-ref.js";
import { resolveInspectionTarget } from "../src/inspection/target-resolution.js";
import type { RunInspectionStaticNode } from "../src/inspection/types.js";
import type { RunDetails } from "../src/store/store.js";

const staticNodes: RunInspectionStaticNode[] = [
  { nodeId: "batch", kind: "fanout", order: 0, path: ["batch"] },
  { nodeId: "verify", kind: "task", order: 1, path: ["batch", "verify"] },
];

describe("inspection occurrence targets", () => {
  it("derives fixed eight-hex refs from branch, Fanout, Loop, and mixed paths", () => {
    expect(deriveOccurrenceRef([{ kind: "node", nodeId: "verify" }])).toBe("@75de35d6");
    expect(deriveOccurrenceRef([
      { kind: "node", nodeId: "batch" },
      { kind: "fanout", nodeId: "batch", itemIndex: 0 },
      { kind: "node", nodeId: "verify" },
    ])).toBe("@6119a202");
    expect(deriveOccurrenceRef([
      { kind: "node", nodeId: "batch" },
      { kind: "fanout", nodeId: "batch", itemIndex: 1 },
      { kind: "node", nodeId: "loop" },
      { kind: "loop", nodeId: "loop", iter: 2 },
      { kind: "node", nodeId: "verify" },
    ])).toBe("@9d4669a0");
    expect(deriveOccurrenceRef([{ kind: "branch", nodeId: "gate", branchId: "then" }])).toBe("@65606a87");
  });

  it("fails closed for a colliding pure lookup without a hash seam", () => {
    expect(resolveOccurrenceRefCandidate("@11111111", [
      { ref: "@11111111", value: "first~full-key" },
      { ref: "@11111111", value: "second~full-key" },
    ])).toEqual({
      kind: "collision",
      target: "@11111111",
      candidates: ["first~full-key", "second~full-key"],
    });
  });

  it("returns deep candidates in occurrence-path order, then resolves a ref and exact attempt", () => {
    const run = repeatedRun();
    const candidates = resolveInspectionTarget({
      run,
      staticNodes,
      target: "verify",
    });
    expect(candidates).toMatchObject({
      kind: "candidates",
      candidates: {
        target: "verify",
        entries: [{
          selector: "@6119a202",
          status: "completed",
          breadcrumb: "batch › batch[0] › verify",
        }, {
          selector: "@9d4669a0",
          status: "running",
          breadcrumb: "batch › batch[1] › loop › loop#2 › verify",
        }],
      },
    });

    expect(resolveInspectionTarget({ run, staticNodes, target: "@9d4669a0" }))
      .toEqual({ kind: "resolved", target: "verify~item-1-round-2" });
    expect(resolveInspectionTarget({ run, staticNodes, target: "@9d4669a0#2" }))
      .toEqual({ kind: "resolved", target: "verify-attempt-2" });
    expect(resolveInspectionTarget({ run, staticNodes, target: "verify~item-0" }))
      .toEqual({ kind: "resolved", target: "verify~item-0" });
  });

  it("returns every occurrence and resolves the first, middle, and last candidate", () => {
    const run = thirteenOccurrencesRun();
    const resolution = resolveInspectionTarget({ run, staticNodes, target: "verify" });
    if (resolution.kind !== "candidates") throw new Error("Expected ambiguous occurrence candidates.");

    expect(resolution.candidates.entries).toHaveLength(13);
    expect(resolution.candidates.entries.map(entry => entry.breadcrumb)).toEqual(
      Array.from({ length: 13 }, (_, itemIndex) => `batch › batch[${itemIndex}] › verify`),
    );
    for (const itemIndex of [0, 6, 12]) {
      expect(resolveInspectionTarget({
        run,
        staticNodes,
        target: resolution.candidates.entries[itemIndex]!.selector,
      })).toEqual({ kind: "resolved", target: `verify~item-${itemIndex}` });
    }
  });

  it("resolves a composite context ref to its frame key", () => {
    expect(resolveInspectionTarget({
      run: repeatedRun(),
      staticNodes,
      target: deriveOccurrenceRef([{ kind: "node", nodeId: "batch" }]),
    })).toEqual({ kind: "resolved", target: "batch~frame" });
  });

  it("treats a missing persisted InstancePath as an inspection invariant", () => {
    const run = repeatedRun();
    delete run.dynamic!.nodeInstances[0]!.instancePath;
    expect(() => resolveInspectionTarget({ run, staticNodes, target: "verify" }))
      .toThrow("Materialized occurrence 'verify~item-0' has no instance path.");
  });
});

describe("resolved inspection target state", () => {
  it("prefers the selected attempt's runtime Task input and orders attempts by attempt number", () => {
    const ir = taskWorkflow();
    const run = singleNodeRun("work", "work~1");

    expect(resolvedState(ir, run, "work").summary.input).toEqual({
      kind: "authored",
      value: "\"authored\"",
    });

    run.dynamic!.attempts = [{
      attemptId: "attempt-1",
      nodeKey: "work~1",
      nodeId: "work",
      attemptNo: 1,
      status: "failed",
      startedAt: "2026-07-29T00:00:03.000Z",
      finishedAt: "2026-07-29T00:00:04.000Z",
    }, {
      attemptId: "attempt-2",
      nodeKey: "work~1",
      nodeId: "work",
      attemptNo: 2,
      status: "started",
      startedAt: "2026-07-29T00:00:01.000Z",
    }];
    run.dynamic!.executionMetadata = [{
      id: 1,
      attemptId: "attempt-2",
      kind: "task_attempt",
      metadata: { input: ["runtime", 2] },
      createdAt: "2026-07-29T00:00:02.000Z",
    }];

    const details = resolvedState(ir, run, "work");

    expect(details.summary).toMatchObject({
      input: { kind: "runtime", value: ["runtime", 2] },
      latestAttempt: {
        attemptId: "attempt-2",
        attemptNo: 2,
      },
    });
  });

  it("exposes narrow node output only from the scheduler-accepted durable result", () => {
    const ir = taskWorkflow();
    const run = singleNodeRun("work", "work~1");
    run.dynamic!.nodeInstances[0] = {
      ...run.dynamic!.nodeInstances[0]!,
      status: "completed",
      output: { authoritative: true },
      acceptedAttemptId: "attempt-2",
    };
    run.dynamic!.attempts = [{
      attemptId: "attempt-1",
      nodeKey: "work~1",
      nodeId: "work",
      attemptNo: 1,
      status: "completed",
      result: { candidate: "historical" },
      startedAt: "2026-07-29T00:00:01.000Z",
      finishedAt: "2026-07-29T00:00:02.000Z",
    }, {
      attemptId: "attempt-2",
      nodeKey: "work~1",
      nodeId: "work",
      attemptNo: 2,
      status: "completed",
      result: { candidate: "accepted but not authoritative" },
      startedAt: "2026-07-29T00:00:03.000Z",
      finishedAt: "2026-07-29T00:00:04.000Z",
    }];
    run.dynamic!.progress = [{
      nodeKey: "work~1",
      nodeId: "work",
      attemptId: "attempt-2",
      kind: "task",
      status: "completed",
      output: { tail: "progress candidate", totalBytes: 18, truncated: false },
      updatedAt: "2026-07-29T00:00:05.000Z",
    }];

    expect(resolvedState(ir, run, "work~1").summary.output).toEqual({ authoritative: true });
    expect(resolvedState(ir, run, "attempt-2").summary.output).toEqual({ authoritative: true });
    expect(resolvedState(ir, run, "attempt-1").summary).not.toHaveProperty("output");
  });

  it("projects the effective Agent model and terminal metadata fallback", () => {
    const ir = agentWorkflow();
    const run = singleNodeRun("review", "review~1");
    run.dynamic!.nodeInstances[0]!.status = "completed";
    run.dynamic!.attempts = [{
      attemptId: "attempt-1",
      nodeKey: "review~1",
      nodeId: "review",
      attemptNo: 1,
      status: "completed",
      startedAt: "2026-07-29T00:00:01.000Z",
      finishedAt: "2026-07-29T00:00:04.000Z",
    }];
    run.dynamic!.executionMetadata = [{
      id: 1,
      attemptId: "attempt-1",
      kind: "agent_attempt",
      metadata: {
        turnCount: 2,
        turns: [{
          turn: 2,
          summary: {
            stopReason: "end_turn",
            context: { used: 4_000, size: 20_000, updatedAt: "2026-07-29T00:00:05.000Z" },
            tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
          },
        }],
      },
      createdAt: "2026-07-29T00:00:04.000Z",
    }];

    const details = resolvedState(ir, run, "review");

    expect(details.summary.agent).toMatchObject({
      key: "reviewer",
      backend: { kind: "use", name: "claude" },
      model: "opus",
      turnCount: 2,
      lastObservedAt: "2026-07-29T00:00:05.000Z",
      context: { used: 4_000, size: 20_000 },
      tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      stopReason: "end_turn",
    });
  });

  it("retains complete ACP failure evidence for the narrow node read", () => {
    const ir = agentWorkflow();
    const run = singleNodeRun("review", "review~1");
    run.dynamic!.nodeInstances[0]!.status = "failed";
    run.dynamic!.nodeInstances[0]!.statusReason = "provider_exit";
    run.dynamic!.nodeInstances[0]!.error = {
      origin: "provider",
      code: "provider_exit",
      message: "Provider configuration failed.",
      upstream: {
        source: "acp",
        operation: "open_session",
        exitCode: 1,
        code: "RUNTIME",
        origin: "cli",
        protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
        data: { details: "credential helper failed", nested: { preserved: true } },
      },
    };

    const details = resolvedState(ir, run, "review");

    expect(details.summary.failure).toEqual({
      origin: "provider",
      code: "provider_exit",
      message: "Provider configuration failed.",
      upstream: {
        source: "acp",
        operation: "open_session",
        exitCode: 1,
        code: "RUNTIME",
        origin: "cli",
        protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
        data: { details: "credential helper failed", nested: { preserved: true } },
      },
    });
  });
});

function repeatedRun(): RunDetails {
  return {
    id: "run-1",
    name: "inspection",
    status: "running",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "digest",
    progressVersion: 1,
    input: {},
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
    eventCount: 0,
    nodeCount: 2,
    hooks: [],
    execution: { state: "active", lastStatus: "running" },
    dynamic: {
      version: 1,
      progressVersion: 1,
      frames: [{
        frameKey: "batch~frame",
        nodeKey: "batch~frame",
        nodeId: "batch",
        instancePath: [{ kind: "node", nodeId: "batch" }],
        frameKind: "node",
        status: "running",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:01.000Z",
      }],
      nodeInstances: [{
        nodeKey: "verify~item-0",
        nodeId: "verify",
        instancePath: [
          { kind: "node", nodeId: "batch" },
          { kind: "fanout", nodeId: "batch", itemIndex: 0 },
          { kind: "node", nodeId: "verify" },
        ],
        status: "completed",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:01.000Z",
      }, {
        nodeKey: "verify~item-1-round-2",
        nodeId: "verify",
        instancePath: [
          { kind: "node", nodeId: "batch" },
          { kind: "fanout", nodeId: "batch", itemIndex: 1 },
          { kind: "node", nodeId: "loop" },
          { kind: "loop", nodeId: "loop", iter: 2 },
          { kind: "node", nodeId: "verify" },
        ],
        status: "running",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:01.000Z",
      }],
      attempts: [{
        attemptId: "verify-attempt-1",
        nodeKey: "verify~item-0",
        nodeId: "verify",
        attemptNo: 1,
        status: "completed",
        startedAt: "2026-07-29T00:00:00.000Z",
        finishedAt: "2026-07-29T00:00:01.000Z",
      }, {
        attemptId: "verify-attempt-1-round-2",
        nodeKey: "verify~item-1-round-2",
        nodeId: "verify",
        attemptNo: 1,
        status: "failed",
        startedAt: "2026-07-29T00:00:00.000Z",
        finishedAt: "2026-07-29T00:00:01.000Z",
      }, {
        attemptId: "verify-attempt-2",
        nodeKey: "verify~item-1-round-2",
        nodeId: "verify",
        attemptNo: 2,
        status: "started",
        startedAt: "2026-07-29T00:00:01.000Z",
      }],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    },
  };
}

function thirteenOccurrencesRun(): RunDetails {
  const run = repeatedRun();
  run.dynamic!.nodeInstances = Array.from({ length: 13 }, (_, offset) => {
    const itemIndex = 12 - offset;
    return {
      nodeKey: `verify~item-${itemIndex}`,
      nodeId: "verify",
      instancePath: [
        { kind: "node" as const, nodeId: "batch" },
        { kind: "fanout" as const, nodeId: "batch", itemIndex },
        { kind: "node" as const, nodeId: "verify" },
      ],
      status: "completed" as const,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:01.000Z",
    };
  });
  run.dynamic!.attempts = [];
  return run;
}

function taskWorkflow(): AdmittedWorkflowIR {
  return {
    irVersion: 8,
    name: "resolved-task",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "work",
        kind: "task",
        run: {
          input: { kind: "literal", value: "authored" },
          target: { kind: "inline", source: "async function task() {}" },
        },
      }],
    },
    diagnostics: [],
  };
}

function agentWorkflow(): AdmittedWorkflowIR {
  return {
    irVersion: 8,
    name: "resolved-agent",
    agents: {
      reviewer: {
        kind: "agent_definition",
        use: "claude",
        model: "sonnet",
        config: { model: "opus" },
      },
    },
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "review",
        kind: "agent",
        run: { agent: "reviewer", prompt: { kind: "literal", value: "Review" } },
      }],
    },
    diagnostics: [],
  };
}

function singleNodeRun(nodeId: string, nodeKey: string): RunDetails {
  return {
    id: "run-resolved",
    name: "resolved-target",
    status: "running",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: "digest",
    progressVersion: 0,
    input: {},
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:05.000Z",
    eventCount: 0,
    nodeCount: 1,
    hooks: [],
    execution: { state: "active", lastStatus: "running" },
    dynamic: {
      version: 1,
      progressVersion: 0,
      frames: [],
      nodeInstances: [{
        nodeKey,
        nodeId,
        instancePath: [{ kind: "node", nodeId }],
        status: "running",
        createdAt: "2026-07-29T00:00:01.000Z",
        updatedAt: "2026-07-29T00:00:05.000Z",
      }],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    },
  };
}

function resolvedState(ir: AdmittedWorkflowIR, run: RunDetails, target: string) {
  const details = resolveTargetState({ ir, run, target, artifacts: [] });
  if (!details) throw new Error(`Expected target '${target}' to resolve.`);
  return details;
}
