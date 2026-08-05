import { describe, expect, it } from "vitest";
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
  it("derives fixed twelve-hex refs from branch, Fanout, Loop, and mixed paths", () => {
    expect(deriveOccurrenceRef([{ kind: "node", nodeId: "verify" }])).toBe("@75de35d61d1d");
    expect(deriveOccurrenceRef([
      { kind: "node", nodeId: "batch" },
      { kind: "fanout", nodeId: "batch", itemIndex: 0 },
      { kind: "node", nodeId: "verify" },
    ])).toBe("@6119a20210df");
    expect(deriveOccurrenceRef([
      { kind: "node", nodeId: "batch" },
      { kind: "fanout", nodeId: "batch", itemIndex: 1 },
      { kind: "node", nodeId: "loop" },
      { kind: "loop", nodeId: "loop", iter: 2 },
      { kind: "node", nodeId: "verify" },
    ])).toBe("@9d4669a0288d");
    expect(deriveOccurrenceRef([{ kind: "branch", nodeId: "gate", branchId: "then" }])).toBe("@65606a87d385");
  });

  it("fails closed for a colliding pure lookup without a hash seam", () => {
    expect(resolveOccurrenceRefCandidate("@111111111111", [
      { ref: "@111111111111", value: "first~full-key" },
      { ref: "@111111111111", value: "second~full-key" },
    ])).toEqual({
      kind: "collision",
      target: "@111111111111",
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
          selector: "@6119a20210df",
          status: "completed",
          breadcrumb: "batch › batch[0] › verify",
        }, {
          selector: "@9d4669a0288d",
          status: "running",
          breadcrumb: "batch › batch[1] › loop › loop#2 › verify",
        }],
      },
    });

    expect(resolveInspectionTarget({ run, staticNodes, target: "@9d4669a0288d" }))
      .toEqual({ kind: "resolved", target: "verify~item-1-round-2" });
    expect(resolveInspectionTarget({ run, staticNodes, target: "@9d4669a0288d#2" }))
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
