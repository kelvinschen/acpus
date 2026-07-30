import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExprIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import {
  projectRunSnapshot,
  resolveTargetState,
  semanticChanges,
} from "../src/inspection/projection.js";
import { projectInspectionRunView } from "../src/inspection/coherent-projection.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import type { ResolvedTargetState } from "../src/inspection/resolved-target.js";
import type { InspectionTreeEntry, RunInspectionControl } from "../src/inspection/types.js";
import type { ArtifactRecord, RunDetails, RunDynamicNodeInstance } from "../src/store/store.js";

function snapshot(
  ir: WorkflowIR,
  run: RunDetails,
  options: { all?: boolean; controls?: readonly RunInspectionControl[] } = {},
) {
  return projectRunSnapshot({
    ir,
    run,
    ...(options.all ? { includeAllTopology: true } : {}),
    ...(options.controls === undefined ? {} : { availableControls: options.controls }),
  });
}

function targetState(
  ir: WorkflowIR,
  run: RunDetails,
  target: string,
  artifacts: ArtifactRecord[] = [],
  controls: readonly RunInspectionControl[] = [],
): ResolvedTargetState {
  const state = resolveTargetState({ ir, run, target, artifacts, availableControls: controls });
  if (!state) throw new Error(`Expected target '${target}' to resolve.`);
  return state;
}

describe("run inspection projection", () => {
  it("shows one complete authored Task input without duplicating it in static topology", () => {
    const ir = taskWorkflow({
      kind: "array",
      items: [{ kind: "literal", value: "raw" }, { kind: "literal", value: 2 }],
    });
    const run = repeatedAgentRun(0);
    run.name = ir.name;

    const details = targetState(ir, run, "work");

    expect(details).toMatchObject({
      summary: {
        input: { kind: "authored", value: "[\"raw\", 2]" },
      },
    });
    expect(details.staticNode).not.toHaveProperty("input");
  });

  it("prefers the exact runtime Task input shape over the authored expression", () => {
    const ir = taskWorkflow({ kind: "literal", value: "authored" });
    const run = repeatedAgentRun(1);
    run.name = ir.name;
    run.dynamic!.nodeInstances[0] = {
      ...run.dynamic!.nodeInstances[0]!,
      nodeKey: "work~0",
      nodeId: "work",
      instancePath: [{ kind: "node", nodeId: "work" }],
    };
    run.dynamic!.attempts[0] = {
      ...run.dynamic!.attempts[0]!,
      nodeKey: "work~0",
      nodeId: "work",
    };
    run.dynamic!.executionMetadata = [{
      id: 1,
      attemptId: "attempt-0",
      kind: "task_attempt",
      metadata: { input: ["runtime", 2] },
      createdAt: "2026-07-01T00:00:02.000Z",
    }];

    const details = targetState(ir, run, "work~0");

    expect(details).toMatchObject({
      summary: {
        input: { kind: "runtime", value: ["runtime", 2] },
      },
    });
  });

  it("selects the latest dynamic-node attempt by attempt number before timestamps", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.attempts.push({
      attemptId: "attempt-retry",
      nodeKey: "review~0",
      nodeId: "review",
      attemptNo: 2,
      status: "started",
      startedAt: "2026-06-30T23:59:59.000Z",
    });

    const details = targetState(compositeWorkflow(), run, "review~0");

    expect(details).toMatchObject({
      summary: {
        latestAttempt: {
          attemptId: "attempt-retry",
          attemptNo: 2,
        },
      },
    });
  });

  it("keeps every repeated composite context in the default tree", () => {
    const run = repeatedAgentRun(25);
    const overview = snapshot(compositeWorkflow(), run);
    const all = snapshot(compositeWorkflow(), run, { all: true });

    if (overview?.kind !== "snapshot" || all?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(overview.counts).toEqual({ total: 25, ready: 25 });
    expect(all.counts).toEqual({ total: 25, ready: 25 });
    expect(overview.run).not.toHaveProperty("agentUsage");
    expect(overview).not.toHaveProperty("omitted");
    expect(overview.items.filter(item => item.role === "instance")).toHaveLength(25);
    expect(all.items.filter(item => item.role === "instance")).toHaveLength(25);
    expect(overview.items.filter(item => item.role === "fold")).toEqual([]);
    expect(all.items.filter(item => item.role === "fold")).toEqual([]);
    for (const document of [overview, all]) {
      const keys = new Set(document.items.map(item => item.key));
      expect(document.items.filter(item => item.parentKey && !keys.has(item.parentKey))).toEqual([]);
    }
    expect(overview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "static", nodeId: "batch", kind: "fanout" }),
      expect.objectContaining({ role: "context", label: "item[0]", kind: "fanout_item", scope: { kind: "fanout_item", itemIndex: 0, empty: false } }),
      expect.objectContaining({
        role: "instance",
        nodeKey: "review~0",
        agent: {
          key: "reviewer",
          turn: 4,
          activeTool: { command: "Bash", status: "running" },
        },
      }),
    ]));
    const compact = JSON.stringify(overview);
    expect(compact).not.toContain("inputPreview");
    expect(compact).not.toContain("private/repository");
    expect(compact).not.toContain("TODO packages");
    for (const agent of overview.items.flatMap(item => item.agent ? [item.agent] : [])) {
      expect(agent).not.toHaveProperty("tokenUsage");
      expect(agent).not.toHaveProperty("context");
      expect(agent).not.toHaveProperty("turnCount");
    }
  });

  it("folds homogeneous fanout contexts without exposing an invalid candidate selector", () => {
    const run = repeatedAgentRun(4);
    run.dynamic!.progress = [];
    run.dynamic!.executionMetadata = [];

    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });
    const folds = inspectionFolds(view.tree);

    expect(folds).toEqual([
      expect.objectContaining({ scope: "fanout-items", count: 4 }),
    ]);
    for (const fold of folds) expect(fold).not.toHaveProperty("candidateTarget");
  });

  it("folds terminal fanout contexts with different elapsed durations", () => {
    const run = repeatedAgentRun(4);
    run.dynamic!.progress = [];
    run.dynamic!.executionMetadata = [];
    for (const instance of run.dynamic!.nodeInstances) instance.status = "completed";
    for (const [index, attempt] of run.dynamic!.attempts.entries()) {
      attempt.status = "completed";
      attempt.finishedAt = `2026-07-01T00:00:0${index + 2}.000Z`;
    }

    expect(inspectionFolds(projectInspectionRunView({ ir: compositeWorkflow(), run }).tree)).toEqual([
      expect.objectContaining({ scope: "fanout-items", count: 4 }),
    ]);
  });

  it("omits a targeted fork's raw target from the generic run view", () => {
    const run = repeatedAgentRun(0);
    run.fork = { sourceRunId: "source-run", target: "review~private-key", unsafeReuse: true };

    expect(projectInspectionRunView({ ir: compositeWorkflow(), run }).run.fork).toEqual({
      sourceRunId: "source-run",
      unsafeReuse: true,
    });
  });

  it("keeps opaque failure payloads out of the generic run view", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.nodeInstances[0]!.status = "failed";
    run.dynamic!.nodeInstances[0]!.error = {
      upstream: { source: "acpx", data: { secret: "never-expose" } },
    };

    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });

    const rendered = JSON.stringify(view);
    expect(rendered).toContain("Target failed.");
    expect(rendered).not.toContain("never-expose");
  });

  it("keeps every active leaf in the default tree", () => {
    const run = repeatedAgentRun(26);
    for (const [index, instance] of run.dynamic!.nodeInstances.entries()) {
      if (index >= 20) instance.status = index % 2 === 0 ? "running" : "starting";
    }
    const overview = snapshot(compositeWorkflow(), run);
    const all = snapshot(compositeWorkflow(), run, { all: true });

    if (overview?.kind !== "snapshot" || all?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(overview.items.filter(item => item.role === "instance" && item.status === "ready")).toHaveLength(20);
    expect(overview.items
      .filter(item => item.role === "instance" && (item.status === "starting" || item.status === "running"))
      .map(item => item.nodeKey)).toEqual([
        "review~20",
        "review~21",
        "review~22",
        "review~23",
        "review~24",
        "review~25",
      ]);
    expect(overview.counts).toEqual({ total: 26, ready: 20, starting: 3, running: 3 });
    expect(overview).not.toHaveProperty("omitted");
    const keys = new Set(overview.items.map(item => item.key));
    expect(overview.items.filter(item => item.parentKey && !keys.has(item.parentKey))).toEqual([]);
    expect(all.items
      .filter(item => item.role === "instance" && (item.status === "starting" || item.status === "running"))
      .map(item => item.nodeKey)).toEqual([
        "review~20",
        "review~21",
        "review~22",
        "review~23",
        "review~24",
        "review~25",
      ]);
    expect(all).not.toHaveProperty("omitted");
  });

  it("counts complete repeated leaf contexts without folding", () => {
    const unmaterialized = repeatedAgentRun(0);
    const repeated = repeatedAgentRun(25);
    for (const instance of repeated.dynamic!.nodeInstances) instance.status = "completed";
    const initial = snapshot(compositeWorkflow(), unmaterialized);
    const complete = snapshot(compositeWorkflow(), repeated);

    if (initial?.kind !== "snapshot" || complete?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(initial.counts).toEqual({ total: 1, notStarted: 1 });
    expect(initial.run).not.toHaveProperty("agentUsage");
    expect(complete.counts).toEqual({ total: 25, completed: 25 });
    expect(complete.items.filter(item => item.role === "instance")).toHaveLength(25);
    expect(complete.items.filter(item => item.role === "fold")).toEqual([]);
    expect(complete).not.toHaveProperty("omitted");
  });

  it("filters one composite occurrence tree without retaining sibling actions", () => {
    const base = compositeWorkflow();
    const ir: WorkflowIR = {
      ...base,
      root: {
        ...base.root,
        nodes: [{
          id: "outside",
          kind: "agent",
          run: { agent: "reviewer", prompt: { kind: "literal", value: "Outside" } },
        }, ...base.root.nodes],
      },
    };
    const outsidePath = appendNode([], "outside");
    const batchPath = appendNode([], "batch");
    const firstItemPath = appendFanoutItem([], "batch", 0);
    const secondItemPath = appendFanoutItem([], "batch", 1);
    const firstReviewPath = appendNode(firstItemPath, "review");
    const secondReviewPath = appendNode(secondItemPath, "review");
    const outsideKey = deriveInstanceKey(outsidePath);
    const batchKey = deriveInstanceKey(batchPath);
    const firstReviewKey = deriveInstanceKey(firstReviewPath);
    const secondReviewKey = deriveInstanceKey(secondReviewPath);
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [{
        frameKey: batchKey,
        nodeKey: batchKey,
        nodeId: "batch",
        frameKind: "node",
        status: "running",
        instancePath: batchPath,
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      nodeInstances: [{
        nodeKey: outsideKey,
        nodeId: "outside",
        instancePath: outsidePath,
        status: "failed",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }, {
        nodeKey: firstReviewKey,
        nodeId: "review",
        instancePath: firstReviewPath,
        status: "running",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }, {
        nodeKey: secondReviewKey,
        nodeId: "review",
        instancePath: secondReviewPath,
        status: "running",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      attempts: [{
        attemptId: "outside-attempt",
        nodeKey: outsideKey,
        nodeId: "outside",
        attemptNo: 1,
        status: "failed",
        startedAt: "2026-07-01T00:00:01.000Z",
        finishedAt: "2026-07-01T00:00:02.000Z",
      }, {
        attemptId: "first-review-attempt",
        nodeKey: firstReviewKey,
        nodeId: "review",
        attemptNo: 1,
        status: "started",
        startedAt: "2026-07-01T00:00:01.000Z",
      }, {
        attemptId: "second-review-attempt",
        nodeKey: secondReviewKey,
        nodeId: "review",
        attemptNo: 1,
        status: "started",
        startedAt: "2026-07-01T00:00:01.000Z",
      }],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };

    const whole = snapshot(ir, run, { all: true });
    const scoped = targetState(ir, run, batchKey);
    if (whole?.kind !== "snapshot") throw new Error("expected full snapshot");

    expect(whole.items).toContainEqual(expect.objectContaining({ nodeKey: outsideKey }));
    expect(whole.availableActions).toEqual([]);
    expect(scoped.target).toMatchObject({ id: batchKey });
    expect(scoped.items).not.toContainEqual(expect.objectContaining({ nodeKey: outsideKey }));
  });

  it("keeps every nested Fanout occurrence in the default tree", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "nested-context-budget",
      agents: { reviewer: { kind: "agent_definition", use: "claude" } },
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "outer",
          kind: "fanout",
          strategy: "all",
          over: { kind: "array", items: [] },
          do: {
            output: { kind: "object", fields: {} },
            nodes: [{
              id: "inner",
              kind: "fanout",
              strategy: "all",
              over: { kind: "array", items: [] },
              do: {
                output: { kind: "object", fields: {} },
                nodes: [{ id: "review", kind: "agent", run: { agent: "reviewer", prompt: { kind: "literal", value: "Review" } } }],
              },
            }],
          },
        }],
      },
      diagnostics: [],
    };
    const run = repeatedAgentRun(25);
    run.name = ir.name;
    const outerItemPath = appendFanoutItem([], "outer", 0);
    for (const [itemIndex, instance] of run.dynamic!.nodeInstances.entries()) {
      const innerItemPath = appendFanoutItem(outerItemPath, "inner", itemIndex);
      instance.instancePath = appendNode(innerItemPath, "review");
      instance.nodeKey = deriveInstanceKey(instance.instancePath);
      instance.parentFrameKey = deriveInstanceKey(innerItemPath);
    }
    run.dynamic!.attempts = [];
    run.dynamic!.executionMetadata = [];
    run.dynamic!.progress = [];
    const overview = snapshot(ir, run);
    if (overview?.kind !== "snapshot") throw new Error("expected snapshot");

    const outerKey = `scope:${deriveInstanceKey(outerItemPath)}`;
    expect(overview.items.filter(item => item.nodeId === "outer" && item.scope?.kind === "fanout_item")).toEqual([
      expect.objectContaining({ key: outerKey, scope: { kind: "fanout_item", itemIndex: 0, empty: false } }),
    ]);
    expect(overview.items.filter(item => item.nodeId === "inner" && item.scope?.kind === "fanout_item")).toHaveLength(25);
    expect(overview.items.filter(item => item.role === "instance")).toHaveLength(25);
    expect(overview.items.filter(item => item.role === "fold")).toEqual([]);
    expect(overview).not.toHaveProperty("omitted");
  });

  it("projects only the current Agent turn identity into overview", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.attempts.push({
      attemptId: "attempt-retry",
      nodeKey: "review~0",
      nodeId: "review",
      attemptNo: 2,
      status: "started",
      startedAt: "2026-07-01T00:00:03.000Z",
    });
    run.dynamic!.executionMetadata.push({
      id: 2,
      attemptId: "attempt-retry",
      kind: "agent_attempt",
      metadata: { turnCount: 2 },
      createdAt: "2026-07-01T00:00:04.000Z",
    });
    run.dynamic!.progress[0] = {
      ...run.dynamic!.progress[0]!,
      attemptId: "attempt-retry",
      attemptNo: 2,
      tools: { ...run.dynamic!.progress[0]!.tools as Record<string, unknown>, turn: 3 },
    };

    const document = snapshot(compositeWorkflow(), run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.find(item => item.nodeKey === "review~0")?.agent).toEqual({
      key: "reviewer",
      turn: 3,
      activeTool: { command: "Bash", status: "running" },
    });
    expect(document.run).not.toHaveProperty("agentUsage");
  });

  it("does not project unavailable telemetry into overview", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.progress = [];
    const document = snapshot(compositeWorkflow(), run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.find(item => item.nodeKey === "review~0")?.agent).toEqual({ key: "reviewer" });
  });

  it("projects only direct fork lineage into inspection summaries", () => {
    const run = repeatedAgentRun(0);
    run.fork = { sourceRunId: "run_source", target: "review~failed", unsafeReuse: true };
    const document = snapshot(compositeWorkflow(), run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.run.fork).toEqual({ sourceRunId: "run_source", target: "review~failed", unsafeReuse: true });
  });

  it("counts every repeated Assert frame as a distinct execution context", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "repeated-assert",
      agents: {},
      root: {
        output: { kind: "object", fields: {} }, nodes: [{
        id: "batch",
        kind: "fanout",
        strategy: "all",
        over: { kind: "array", items: [] },
        do: { output: { kind: "object", fields: {} }, nodes: [{ id: "check", kind: "assert", condition: { kind: "literal", value: true } }] },
      }] },

      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "completed";
    run.dynamic = {
      version: 20,
      progressVersion: 0,
      frames: Array.from({ length: 20 }, (_, itemIndex) => ({
        frameKey: `check~${itemIndex}`,
        nodeKey: `check~${itemIndex}`,
        nodeId: "check",
        frameKind: "node",
        status: "completed",
        terminalReason: "assert_passed",
        instancePath: [{ kind: "fanout" as const, nodeId: "batch", itemIndex }, { kind: "node" as const, nodeId: "check" }],
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      })),
      nodeInstances: [],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };
    const document = snapshot(ir, run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.counts).toEqual({ total: 20, completed: 20 });
  });

  it("keeps failed and timed-out repeated executions as distinct rows", () => {
    for (const status of ["failed", "timed_out"] as const) {
      const run = repeatedAgentRun(25);
      for (const instance of run.dynamic!.nodeInstances) instance.status = status;
      const document = snapshot(compositeWorkflow(), run);
      if (document?.kind !== "snapshot") throw new Error("expected snapshot");
      expect(document.items.filter(item => item.role === "instance" && item.status === status)).toHaveLength(25);
      expect(document.items.filter(item => item.role === "fold")).toEqual([]);
      expect(document).not.toHaveProperty("omitted");
    }
  });

  it("keeps default JSON compact and exposes complete target projection", () => {
    const run = repeatedAgentRun(25);
    const artifact: ArtifactRecord = {
      id: "turn-1",
      runId: run.id,
      nodeKey: "review~0",
      attempt: 1,
      mediaType: "application/json",
      digest: "sha256:abc",
      size: 42,
      path: `/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/review~0/attempt-1/${run.dynamic!.attempts[0]!.attemptId}/agent/turn-001.json`,
    };
    const overview = snapshot(compositeWorkflow(), run);
    const target = targetState(compositeWorkflow(), run, "review", [artifact]);

    expect(target).toMatchObject({ target: { kind: "static-node", id: "review" } });
    expect(target.instances).toHaveLength(25);
    expect(target.attempts).toHaveLength(25);
    expect(target.summary).toMatchObject({ nodeStatus: "ready", counts: { total: 25, ready: 25 } });
    for (const field of ["nodeKey", "frameKey", "input", "output", "failure", "prompt", "latestAttempt", "loopProgress", "agent", "signal"] as const) {
      expect(target.summary[field]).toBeUndefined();
    }
    expect(target.artifacts).toEqual([artifact]);
    expect(isAbsolute(target.artifacts[0]!.path)).toBe(true);
    expect(JSON.stringify(target.artifacts)).not.toContain("relativePath");
    expect(JSON.stringify(overview)).not.toContain('"dynamic"');
  });

  it("selects Agent prompt and metadata from the targeted attempt", () => {
    const run = repeatedAgentRun(1);
    const first = run.dynamic!.attempts[0]!;
    first.status = "superseded";
    first.cancelReason = "operator_steered";
    first.result = { original: true };
    first.finishedAt = "2026-07-01T00:00:02.000Z";
    run.dynamic!.nodeInstances[0]!.status = "started";
    run.dynamic!.nodeInstances[0]!.output = { replacement: true };
    run.dynamic!.attempts.push({
      attemptId: "attempt-steered",
      nodeKey: first.nodeKey,
      nodeId: first.nodeId,
      attemptNo: 2,
      status: "started",
      startedAt: "2026-07-01T00:00:03.000Z",
    });
    run.dynamic!.executionMetadata.push({
      id: 2,
      attemptId: "attempt-steered",
      kind: "agent_attempt",
      metadata: { turnCount: 1 },
      createdAt: "2026-07-01T00:00:04.000Z",
    });
    const artifacts: ArtifactRecord[] = [{
      id: "turn-original",
      runId: run.id,
      nodeKey: first.nodeKey,
      attempt: 1,
      mediaType: "application/json",
      digest: "sha256:original",
      size: 42,
      path: `/runtime/runs/${run.id}/artifacts/${first.nodeKey}/attempt-1/${first.attemptId}/agent/turn-001.json`,
    }, {
      id: "turn-steered",
      runId: run.id,
      nodeKey: first.nodeKey,
      attempt: 2,
      mediaType: "application/json",
      digest: "sha256:steered",
      size: 42,
      path: `/runtime/runs/${run.id}/artifacts/${first.nodeKey}/attempt-2/attempt-steered/agent/turn-001.json`,
    }];

    const current = targetState(compositeWorkflow(), run, first.nodeKey, artifacts);
    const original = targetState(compositeWorkflow(), run, first.attemptId, artifacts);

    expect(current.summary).toMatchObject({
      latestAttempt: { attemptId: "attempt-steered", attemptNo: 2 },
      prompt: { kind: "artifact", artifactId: "turn-steered" },
      agent: { turnCount: 1 },
    });
    expect(original.summary).toMatchObject({
      nodeStatus: "superseded",
      output: { original: true },
      latestAttempt: { attemptId: first.attemptId, attemptNo: 1 },
      prompt: { kind: "artifact", artifactId: "turn-original" },
      agent: { turnCount: 4 },
    });
  });

  it("keeps repeated static targets aggregate and preserves single-instance detail", () => {
    const repeated = repeatedAgentRun(2);
    repeated.dynamic!.nodeInstances[0]!.status = "completed";
    repeated.dynamic!.nodeInstances[0]!.output = { old: true };
    repeated.dynamic!.nodeInstances[0]!.updatedAt = "2026-07-01T00:00:01.000Z";
    repeated.dynamic!.nodeInstances[1]!.status = "running";
    delete repeated.dynamic!.nodeInstances[1]!.output;
    repeated.dynamic!.nodeInstances[1]!.updatedAt = "2026-07-01T00:00:03.000Z";
    const aggregate = targetState(compositeWorkflow(), repeated, "review");

    expect(aggregate.summary).toMatchObject({ nodeStatus: "running", counts: { total: 2, running: 1, completed: 1 } });
    expect(aggregate.summary.nodeKey).toBeUndefined();
    expect(aggregate.summary.output).toBeUndefined();
    expect(aggregate.summary.agent).toBeUndefined();

    const single = repeatedAgentRun(1);
    const detailed = targetState(compositeWorkflow(), single, "review");
    expect(detailed.summary).toMatchObject({ nodeStatus: "ready", nodeKey: "review~0", latestAttempt: { attemptId: "attempt-0" }, agent: { key: "reviewer" } });
    expect(detailed.summary.counts).toBeUndefined();
  });

  it("preserves every durable transition between polls in event order", () => {
    const run = repeatedAgentRun(1);
    const document = snapshot(compositeWorkflow(), run);
    if (!document) throw new Error("expected document");
    const changes = semanticChanges([
      event(3, "instance.ready"),
      event(4, "instance.started"),
      event(5, "instance.completed"),
    ], document);
    const reviewItemKey = `node:${deriveInstanceKey(appendNode(appendFanoutItem([], "batch", 0), "review"))}`;
    expect(changes.map(change => [change.sequence, change.action, change.status, change.subject, change.itemKey])).toEqual([
      [3, "ready", "ready", "review", reviewItemKey],
      [4, "started", "running", "review", reviewItemKey],
      [5, "completed", "completed", "review", reviewItemKey],
    ]);
    expect(changes).not.toEqual(expect.arrayContaining([expect.objectContaining({ item: expect.anything() })]));
  });

  it("uses a repeated occurrence breadcrumb instead of its internal node key as an event subject", () => {
    const internalNodeKey = "private-node-key-that-must-not-reach-follow-output";
    const run = repeatedAgentRun(2);
    run.dynamic!.nodeInstances[0] = { ...run.dynamic!.nodeInstances[0]!, nodeKey: internalNodeKey };
    run.dynamic!.attempts[0] = { ...run.dynamic!.attempts[0]!, nodeKey: internalNodeKey };
    run.dynamic!.progress[0] = { ...run.dynamic!.progress[0]!, nodeKey: internalNodeKey };
    const document = snapshot(compositeWorkflow(), run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    const changes = semanticChanges([{
      ...event(3, "instance.started"),
      nodeKey: internalNodeKey,
      payload: { nodeKey: internalNodeKey, nodeId: "review" },
    }], document, run);

    expect(changes).toEqual([expect.objectContaining({
      subject: "batch[0] › review",
      entity: { kind: "node", id: internalNodeKey, nodeId: "review" },
    })]);
    expect(changes[0]!.subject).not.toContain(internalNodeKey);
  });

  it("emits failed scope-frame changes with exact occurrence identity while suppressing terminal bookkeeping", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "scope-frame-changes",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "outer",
          kind: "fanout",
          strategy: "all",
          over: { kind: "array", items: [] },
          do: {
            output: { kind: "object", fields: {} },
            nodes: [{
              id: "work",
              kind: "parallel",
              strategy: "all",
              branches: {
                left: {
                  output: { kind: "object", fields: {} },
                  nodes: [{
                    id: "items",
                    kind: "fanout",
                    strategy: "all",
                    over: { kind: "array", items: [] },
                    do: {
                      output: { kind: "object", fields: {} },
                      nodes: [{
                        id: "repeat",
                        kind: "loop",
                        state: { kind: "object", fields: {} },
                        do: { output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } }, nodes: [] },
                      }],
                    },
                  }],
                },
              },
            }],
          },
        }],
      },
      diagnostics: [],
    };
    const chains = [0, 1].map(itemIndex => {
      const outer = appendFanoutItem([], "outer", itemIndex);
      const work = appendNode(outer, "work");
      const branch = appendBranch(outer, "work", "left");
      const items = appendNode(branch, "items");
      const fanoutItem = appendFanoutItem(branch, "items", 0);
      const repeat = appendNode(fanoutItem, "repeat");
      const iteration = appendLoopIteration(fanoutItem, "repeat", 0);
      return { outer, work, branch, items, fanoutItem, repeat, iteration };
    });
    const frame = (path: Parameters<typeof deriveInstanceKey>[0], frameKind: string, nodeId: string, status: string, parentFrameKey?: string) => ({
      frameKey: deriveInstanceKey(path),
      ...(frameKind === "node" || frameKind === "loop" ? { nodeKey: deriveInstanceKey(path) } : {}),
      nodeId,
      frameKind,
      status,
      instancePath: path,
      ...(parentFrameKey ? { parentFrameKey } : {}),
      createdAt: "2026-07-01T00:00:01.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    });
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "failed";
    run.dynamic!.frames = chains.flatMap((chain, index) => {
      const status = index === 0 ? "failed" : "completed";
      return [
        frame(chain.outer, "fanout_item", "outer", status),
        frame(chain.work, "node", "work", status, deriveInstanceKey(chain.outer)),
        frame(chain.branch, "branch", "work", status, deriveInstanceKey(chain.work)),
        frame(chain.items, "node", "items", status, deriveInstanceKey(chain.branch)),
        frame(chain.fanoutItem, "fanout_item", "items", status, deriveInstanceKey(chain.items)),
        frame(chain.repeat, "loop", "repeat", status, deriveInstanceKey(chain.fanoutItem)),
        frame(chain.iteration, "loop_iteration", "repeat", status, deriveInstanceKey(chain.repeat)),
      ];
    });
    const document = snapshot(ir, run, { all: true });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    const failed = [chains[0]!.branch, chains[0]!.fanoutItem, chains[0]!.iteration].map((path, index) => ({
      runId: run.id,
      sequence: index + 1,
      type: "frame.failed",
      payload: { frameKey: deriveInstanceKey(path), error: { message: "Scope failed." }, terminalReason: "expression_failed" },
      createdAt: `2026-07-01T00:00:0${index + 1}.000Z`,
      idempotencyKey: `scope-failed-${index}`,
    }));
    const bookkeeping = [
      { type: "frame.completed", path: chains[0]!.branch },
      { type: "frame.completed", path: chains[0]!.fanoutItem },
      { type: "frame.cancelled", path: chains[0]!.iteration },
    ].map((value, index) => ({
      runId: run.id,
      sequence: index + 4,
      type: value.type,
      payload: { frameKey: deriveInstanceKey(value.path) },
      createdAt: `2026-07-01T00:00:0${index + 4}.000Z`,
      idempotencyKey: `scope-bookkeeping-${index}`,
    }));

    expect(semanticChanges([...failed, ...bookkeeping], document, run).map(change => ({ action: change.action, subject: change.subject, itemKey: change.itemKey }))).toEqual([
      { action: "failed", subject: "outer[0] › work.left", itemKey: `scope:${deriveInstanceKey(chains[0]!.branch)}` },
      { action: "failed", subject: "outer[0] › work.left › items[0]", itemKey: `scope:${deriveInstanceKey(chains[0]!.fanoutItem)}` },
      { action: "failed", subject: "outer[0] › work.left › items[0] › repeat round 1", itemKey: `scope:${deriveInstanceKey(chains[0]!.iteration)}` },
    ]);
  });

  it("distinguishes a loop round start from its completed transition", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.frames.push({
      frameKey: "batch~loop",
      nodeKey: "batch~loop",
      nodeId: "batch",
      frameKind: "loop",
      status: "running",
      instancePath: [{ kind: "node", nodeId: "batch" }],
      createdAt: "2026-07-01T00:00:01.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    });
    const document = snapshot(compositeWorkflow(), run);
    if (!document) throw new Error("expected document");
    const changes = semanticChanges([
      { ...event(6, "frame.loop_advanced"), nodeKey: "batch~loop", payload: { frameKey: "batch~loop", iter: 0, state: {} } },
      { ...event(7, "frame.loop_advanced"), nodeKey: "batch~loop", payload: { frameKey: "batch~loop", iter: 0, state: {}, transition: { state: {}, stop: false } } },
    ], document, run);

    expect(changes.map(change => change.message)).toEqual(["round=1 started", "round=1 completed"]);
  });

  it("absorbs duplicate signal and scheduler bookkeeping while retaining the operator transition", () => {
    const run = repeatedAgentRun(1);
    const document = snapshot(compositeWorkflow(), run);
    if (!document) throw new Error("expected document");
    const { nodeKey: _nodeKey, ...rootFrameCompleted } = event(9, "frame.completed");
    const changes = semanticChanges([
      event(6, "group.member_completed"),
      event(7, "signal.consumed"),
      event(8, "instance.completed"),
      { ...rootFrameCompleted, payload: { frameKey: "root", terminalReason: "root_completed" } },
    ], document);

    expect(changes.map(change => [change.sequence, change.action, change.status])).toEqual([
      [7, "consumed", "completed"],
    ]);
  });

  it("projects one redacted steer transition and suppresses its scheduler bookkeeping", () => {
    const run = repeatedAgentRun(1);
    const document = snapshot(compositeWorkflow(), run);
    if (!document) throw new Error("expected document");
    const changes = semanticChanges([
      {
        ...event(6, "control.agent_steer_requested"),
        payload: {
          steerId: "cli:steer-1",
          requestedTarget: "review",
          nodeKey: "review~0",
          fencedAttemptId: "attempt-0",
          instruction: "SECRET correction",
        },
      },
      {
        ...event(7, "attempt.superseded"),
        payload: { nodeKey: "review~0", nodeId: "review", attemptId: "attempt-0", cancelReason: "operator_steered" },
      },
      {
        ...event(8, "instance.requeued"),
        payload: { nodeKey: "review~0", nodeId: "review", reason: "steered", steerId: "cli:steer-1" },
      },
    ], document, run);

    expect(changes).toEqual([
      expect.objectContaining({
        sequence: 6,
        action: "steered",
        status: "ready",
        entity: { kind: "control", id: "review~0", nodeId: "review" },
      }),
    ]);
    expect(JSON.stringify(changes)).not.toContain("SECRET correction");
    expect(JSON.stringify(changes)).not.toContain("cli:steer-1");
  });

  it("keeps materialized Assert nodes in the authored compact tree", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "assert-inspection",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "require_ready", kind: "assert", condition: { kind: "literal", value: true } }] },

      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "completed";
    run.nodeCount = 1;
    run.progressVersion = 0;
    run.dynamic = {
      version: 2,
      progressVersion: 0,
      frames: [{
        frameKey: "require_ready~abc",
        nodeKey: "require_ready~abc",
        nodeId: "require_ready",
        frameKind: "node",
        status: "completed",
        terminalReason: "assert_passed",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      nodeInstances: [],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };
    const document = snapshot(ir, run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items).toContainEqual(expect.objectContaining({
      role: "frame",
      nodeId: "require_ready",
      frameKey: "require_ready~abc",
      status: "completed",
      statusReason: "assert_passed",
    }));
    expect(document.counts).toEqual({ total: 1, completed: 1 });
  });

  it("keeps the authored agent key compact while exposing effective command definitions to target detail", () => {
    const ir = compositeWorkflow({ kind: "agent_command", command: "some-provider --unsafe-secret", model: "custom" });
    const run = repeatedAgentRun(1);
    const overview = snapshot(ir, run);
    const target = targetState(ir, run, "review");

    if (overview.kind !== "snapshot") throw new Error("expected inspection document");
    expect(overview.items.find(item => item.nodeKey === "review~0")?.agent).toEqual({
      key: "reviewer",
      turn: 4,
      activeTool: { command: "Bash", status: "running" },
    });
    expect(JSON.stringify(overview)).not.toContain("some-provider");
    expect(target.summary.agent).toMatchObject({
      key: "reviewer",
      backend: { kind: "command" },
      model: "custom",
    });
    expect(target.summary.agentDefinition).toEqual({ kind: "agent_command", command: "some-provider --unsafe-secret", model: "custom" });
  });

  it("keeps the authored Agent key when the effective backend is overridden", () => {
    const effectiveIr = compositeWorkflow({ kind: "agent_definition", use: "codex", model: "gpt-5" });
    const run = repeatedAgentRun(1);
    run.agentOverrides = { reviewer: { use: "codex", model: "gpt-5" } };
    const document = targetState(effectiveIr, run, "review");

    expect(document.summary.agent).toMatchObject({
      key: "reviewer",
      backend: { kind: "use", name: "codex" },
      model: "gpt-5",
    });
  });

  it("projects config.model as the effective Agent model", () => {
    const ir = compositeWorkflow({
      kind: "agent_definition",
      use: "claude",
      model: "sonnet",
      config: { model: "opus", mode: "plan" },
    });
    const run = repeatedAgentRun(1);
    const document = targetState(ir, run, "review");

    expect(document.summary.agent).toMatchObject({
      backend: { kind: "use", name: "claude" },
      model: "opus",
    });
  });

  it("uses terminal turn summary metadata as the Agent inspection fallback", () => {
    const run = repeatedAgentRun(1);
    delete run.dynamic!.progress[0]!.context;
    delete run.dynamic!.progress[0]!.tokenUsage;
    run.dynamic!.executionMetadata[0]!.metadata = {
      turnCount: 2,
      turns: [{
        turn: 2,
        summary: {
          stopReason: "end_turn",
          context: { used: 4_000, size: 20_000, updatedAt: "2026-07-01T00:00:03.000Z" },
          tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
          tools: { totalToolCallCount: 7 },
        },
      }],
    };
    delete run.dynamic!.progress[0]!.tools;
    const document = targetState(compositeWorkflow(), run, "review");

    expect(document.summary.agent).toMatchObject({
      key: "reviewer",
      turnCount: 2,
      lastObservedAt: "2026-07-01T00:00:03.000Z",
      context: { used: 4_000, size: 20_000 },
      tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      stopReason: "end_turn",
    });
  });

  it("bounds Signal prompt/schema summaries while target retains frozen detail", () => {
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field_${index}`, { kind: "string" as const }]));
    const outputSchema: SchemaIR = { kind: "object", fields, required: Object.keys(fields), additionalProperties: false };
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "signal-inspection",
      agents: {},
      root: {
        output: { kind: "object", fields: {} }, nodes: [{
        id: "approve",
        kind: "signal",
        run: { prompt: { kind: "literal", value: "authored prompt" } },
        outputSchema,
      }] },

      diagnostics: [],
    };
    const prompt = `${"Approve the detailed release checklist. ".repeat(12)}PROMPT_TAIL`;
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "awaiting";
    run.execution = { state: "inactive", lastStatus: "awaiting", reason: "daemon_alive" };
    run.dynamic = {
      version: 2,
      progressVersion: 0,
      frames: [],
      nodeInstances: [{
        nodeKey: "approve~1",
        nodeId: "approve",
        instancePath: [{ kind: "node", nodeId: "approve" }],
        status: "awaiting",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [{
        nodeKey: "approve~1",
        nodeId: "approve",
        status: "awaiting",
        renderedPrompt: prompt,
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      executionMetadata: [],
      progress: [],
    };

    const overview = snapshot(ir, run);
    const target = targetState(ir, run, "approve");
    if (overview.kind !== "snapshot") throw new Error("expected inspection document");

    const compactSignal = overview.items.find(item => item.nodeKey === "approve~1")?.signal;
    expect(overview.items.find(item => item.nodeKey === "approve~1")?.parentKey).toBeUndefined();
    expect(compactSignal?.promptPreview?.length).toBeLessThanOrEqual(160);
    expect(compactSignal?.schemaSummary?.length).toBeLessThanOrEqual(160);
    expect(compactSignal?.outputSchema).toBeUndefined();
    expect(JSON.stringify(overview)).not.toContain("PROMPT_TAIL");
    expect(JSON.stringify(overview)).not.toContain("field_79");
    expect(target.summary.signal?.promptPreview).toBe(prompt);
    expect(target.summary.signal?.schemaSummary?.length).toBeLessThanOrEqual(160);
    expect(target.summary.signal?.outputSchema).toEqual(outputSchema);
  });

  it("keeps repeated Signal aggregate and scoped details occurrence-exact", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "repeated-signal-inspection",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{ id: "approve", kind: "signal", run: { prompt: { kind: "literal", value: "Approve?" } } }],
      },
      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [],
      nodeInstances: ["a", "b"].map((suffix, itemIndex) => ({
        nodeKey: `approve~${suffix}`,
        nodeId: "approve",
        instancePath: [{ kind: "fanout" as const, nodeId: "batch", itemIndex }, { kind: "node" as const, nodeId: "approve" }],
        status: "running",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      })),
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: ["a", "b"].map(suffix => ({
        nodeKey: `approve~${suffix}`,
        nodeId: "approve",
        status: "awaiting",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      })),
      executionMetadata: [],
      progress: [],
    };

    const awaiting = targetState(ir, run, "approve");
    expect(awaiting.summary).toMatchObject({ nodeStatus: "awaiting", counts: { total: 2, awaiting: 2 } });
    expect(awaiting.items.filter(item => item.role === "instance").map(item => item.status)).toEqual(["awaiting", "awaiting"]);

    const scoped = targetState(ir, run, "approve~b");
    expect(scoped.summary).toMatchObject({
      nodeKey: "approve~b",
      nodeStatus: "awaiting",
      signal: { target: "approve~b" },
    });
    expect(scoped.signalWaits.map(wait => wait.nodeKey)).toEqual(["approve~b"]);

    for (const instance of run.dynamic.nodeInstances) instance.status = "failed";
    for (const wait of run.dynamic.signalWaits) wait.status = "timed_out";
    const timedOut = targetState(ir, run, "approve");
    expect(timedOut.summary).toMatchObject({ nodeStatus: "timed_out", counts: { total: 2, timedOut: 2 } });
    expect(timedOut.items.filter(item => item.role === "instance").map(item => item.status)).toEqual(["timed_out", "timed_out"]);
  });

  it("keeps terminal Signal timeout evidence and exposes retry only with explicit controls", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "signal-timeout",
      agents: {},
      root: {
        output: { kind: "object", fields: {} }, nodes: [{
        id: "approve",
        kind: "signal",
        run: { prompt: { kind: "literal", value: "Approve release?" } },
        outputSchema: { kind: "object", fields: { approved: { kind: "boolean" } }, required: ["approved"], additionalProperties: false },
      }] },

      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "failed";
    run.execution = { state: "terminal", lastStatus: "failed", reason: "terminal" };
    run.dynamic = {
      version: 3,
      progressVersion: 0,
      frames: [],
      nodeInstances: [{
        nodeKey: "approve~abc",
        nodeId: "approve",
        instancePath: [{ kind: "node", nodeId: "approve" }],
        status: "failed",
        statusReason: "signal_timeout",
        error: { reason: "signal_timeout", message: "Approval timed out." },
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:01:01.000Z",
      }],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [{
        nodeKey: "approve~abc",
        nodeId: "approve",
        status: "timed_out",
        deadlineAt: "2026-07-01T00:01:00.000Z",
        timeoutMessage: "Approval timed out.",
        renderedPrompt: "Approve release?",
        terminalReason: "signal_timeout",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:01:01.000Z",
      }],
      executionMetadata: [],
      progress: [],
    };

    const controls = [{ type: "retry" as const, target: "approve~abc" }];
    const document = snapshot(ir, run);
    const controlsDocument = snapshot(ir, run, { controls });
    const target = targetState(ir, run, "approve~abc");
    if (document.kind !== "snapshot" || controlsDocument.kind !== "snapshot") {
      throw new Error("expected inspection documents");
    }

    expect(document.items.find(item => item.nodeKey === "approve~abc")).toMatchObject({
      status: "timed_out",
      failure: { origin: "scheduler", code: "signal_timeout", message: "Approval timed out." },
      signal: { target: "approve~abc", deadlineAt: "2026-07-01T00:01:00.000Z" },
    });
    const approvalItemKey = `node:${deriveInstanceKey(appendNode([], "approve"))}`;
    const approvalRef = deriveOccurrenceRef(appendNode([], "approve"));
    expect(document.availableActions).toEqual([]);
    expect(controlsDocument.availableActions).toEqual([
      { kind: "retry", target: approvalRef, itemKey: approvalItemKey },
    ]);
    expect(target.summary).toMatchObject({
      nodeStatus: "timed_out",
      failure: { code: "signal_timeout" },
      signal: { target: "approve~abc", deadlineAt: "2026-07-01T00:01:00.000Z" },
    });

    run.dynamic.signalWaits[0] = { ...run.dynamic.signalWaits[0]!, status: "cancelled", terminalReason: "manual_cancel" };
    run.dynamic.nodeInstances[0] = { ...run.dynamic.nodeInstances[0]!, statusReason: "manual_cancel", error: { reason: "manual_cancel", message: "Cancelled." } };
    const ordinaryFailure = snapshot(ir, run);
    if (ordinaryFailure?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(ordinaryFailure.availableActions).toEqual([]);
  });

  it("distinguishes scheduler, provider, and task failure origins with stable codes", () => {
    const schedulerRun = repeatedAgentRun(1);
    schedulerRun.dynamic!.nodeInstances[0]!.status = "failed";
    schedulerRun.dynamic!.nodeInstances[0]!.statusReason = "expression_resolution_failed";
    schedulerRun.dynamic!.nodeInstances[0]!.error = { reason: "expression_resolution_failed", message: "Prompt resolution failed." };
    const scheduler = snapshot(compositeWorkflow(), schedulerRun);
    if (scheduler?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(scheduler.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "scheduler",
      code: "expression_resolution_failed",
      message: "Prompt resolution failed.",
    });

    const providerRun = repeatedAgentRun(1);
    providerRun.dynamic!.nodeInstances[0]!.status = "failed";
    providerRun.dynamic!.nodeInstances[0]!.error = { code: "invalid_api_key", message: "Provider rejected the API key." };
    const provider = snapshot(compositeWorkflow(), providerRun);
    if (provider?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(provider.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "provider",
      code: "invalid_api_key",
      message: "Provider rejected the API key.",
    });

    const runtimeRun = repeatedAgentRun(1);
    runtimeRun.dynamic!.nodeInstances[0]!.status = "failed";
    runtimeRun.dynamic!.nodeInstances[0]!.error = { origin: "runtime", code: "invalid_agent_response_repair_max", message: "Invalid runtime configuration." };
    const runtime = snapshot(compositeWorkflow(), runtimeRun);
    if (runtime?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(runtime.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "runtime",
      code: "invalid_agent_response_repair_max",
      message: "Invalid runtime configuration.",
    });

    const taskIr: WorkflowIR = {
      irVersion: 7,
      name: "task-failure",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "work", kind: "task", run: { input: { kind: "literal", value: null }, target: { kind: "inline", source: "async function task() {}" } } }] },

      diagnostics: [],
    };
    const taskRun = repeatedAgentRun(1);
    taskRun.dynamic!.nodeInstances[0] = { ...taskRun.dynamic!.nodeInstances[0]!, nodeKey: "work~0", nodeId: "work", instancePath: [{ kind: "node", nodeId: "work" }], status: "failed", error: { code: "invalid_output", message: "Task returned invalid output." } };
    taskRun.dynamic!.attempts[0] = { ...taskRun.dynamic!.attempts[0]!, nodeKey: "work~0", nodeId: "work", status: "failed" };
    const task = snapshot(taskIr, taskRun);
    if (task?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(task.items.find(item => item.nodeKey === "work~0")?.failure).toEqual({ origin: "task", code: "invalid_output", message: "Task returned invalid output." });
  });

  it("keeps compact upstream failure fields bounded while target inspection preserves complete acpx data", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.nodeInstances[0]!.status = "failed";
    run.dynamic!.nodeInstances[0]!.statusReason = "provider_exit";
    run.dynamic!.nodeInstances[0]!.error = {
      origin: "provider",
      code: "provider_exit",
      message: "failed to reload config",
      upstream: {
        source: "acpx",
        operation: "sessions.ensure",
        exitCode: 1,
        code: "RUNTIME",
        origin: "cli",
        protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
        data: { acpxCode: "RUNTIME", origin: "cli", details: "failed to reload config", arbitrary: { preserved: true } },
      },
    };
    const overview = snapshot(compositeWorkflow(), run);
    const target = targetState(compositeWorkflow(), run, "review");
    if (overview.kind !== "snapshot") throw new Error("expected inspection documents");

    expect(overview.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "provider",
      code: "provider_exit",
      message: "failed to reload config",
      upstream: {
        source: "acpx",
        operation: "sessions.ensure",
        exitCode: 1,
        code: "RUNTIME",
        origin: "cli",
        protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
      },
    });
    expect(target.summary.failure?.upstream?.data).toEqual({
      acpxCode: "RUNTIME",
      origin: "cli",
      details: "failed to reload config",
      arbitrary: { preserved: true },
    });
  });

  it("keeps conditional selection and empty branches local to each repeated occurrence", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "repeated-routes",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "batch",
          kind: "fanout",
          strategy: "all",
          over: { kind: "array", items: [] },
          do: {
            output: { kind: "object", fields: {} },
            nodes: [{
              id: "route",
              kind: "if",
              condition: { kind: "literal", value: true },
              then: { output: { kind: "object", fields: {} }, nodes: [] },
              else: {
                output: { kind: "object", fields: {} },
                nodes: [{ id: "fallback", kind: "task", run: { input: { kind: "literal", value: null }, target: { kind: "inline", source: "async function task() {}" } } }],
              },
            }],
          },
        }],
      },
      diagnostics: [],
    };
    const item0 = appendFanoutItem([], "batch", 0);
    const item1 = appendFanoutItem([], "batch", 1);
    const route0 = appendNode(item0, "route");
    const route1 = appendNode(item1, "route");
    const then0 = appendBranch(item0, "route", "then");
    const else1 = appendBranch(item1, "route", "else");
    const fallback1 = appendNode(else1, "fallback");
    const frame = (path: ReturnType<typeof appendNode> | ReturnType<typeof appendBranch> | ReturnType<typeof appendFanoutItem>, frameKind: string, nodeId: string, parentFrameKey?: string) => ({
      frameKey: deriveInstanceKey(path),
      ...(frameKind === "node" ? { nodeKey: deriveInstanceKey(path) } : {}),
      nodeId,
      frameKind,
      status: "completed",
      instancePath: path,
      ...(parentFrameKey ? { parentFrameKey } : {}),
      createdAt: "2026-07-01T00:00:01.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    });
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "completed";
    run.dynamic = {
      version: 7,
      progressVersion: 0,
      frames: [
        frame(item1, "fanout_item", "batch"),
        frame(route1, "node", "route", deriveInstanceKey(item1)),
        frame(else1, "branch", "route", deriveInstanceKey(route1)),
        frame(item0, "fanout_item", "batch"),
        frame(route0, "node", "route", deriveInstanceKey(item0)),
        frame(then0, "branch", "route", deriveInstanceKey(route0)),
      ],
      nodeInstances: [{
        nodeKey: deriveInstanceKey(fallback1),
        nodeId: "fallback",
        parentFrameKey: deriveInstanceKey(else1),
        instancePath: fallback1,
        status: "completed",
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };

    const document = snapshot(ir, run, { all: true });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document).not.toHaveProperty("omitted");
    expect(document.items.some(item => item.role === "fold")).toBe(false);
    const key = (path: Parameters<typeof deriveInstanceKey>[0], role: "node" | "scope") => `${role}:${deriveInstanceKey(path)}`;
    expect(document.items.map(item => item.key)).toEqual([
      key(appendNode([], "batch"), "node"),
      key(item0, "scope"),
      key(route0, "node"),
      key(then0, "scope"),
      key(appendBranch(item0, "route", "else"), "scope"),
      key(item1, "scope"),
      key(route1, "node"),
      key(appendBranch(item1, "route", "then"), "scope"),
      key(else1, "scope"),
      key(fallback1, "node"),
    ]);
    expect(document.items.find(item => item.key === key(then0, "scope"))?.scope).toEqual({
      kind: "branch", ownerKind: "if", branchId: "then", selection: "selected", empty: true,
    });
    expect(document.items.find(item => item.key === key(appendBranch(item0, "route", "else"), "scope"))?.scope).toEqual({
      kind: "branch", ownerKind: "if", branchId: "else", selection: "not_selected", empty: false,
    });
    expect(document.items.find(item => item.key === key(appendBranch(item1, "route", "then"), "scope"))?.scope).toEqual({
      kind: "branch", ownerKind: "if", branchId: "then", selection: "not_selected", empty: true,
    });
    expect(document.items.find(item => item.key === key(else1, "scope"))?.scope).toEqual({
      kind: "branch", ownerKind: "if", branchId: "else", selection: "selected", empty: false,
    });
    expect(document.items.filter(item => item.nodeId === "fallback")).toHaveLength(1);
  });

  it("projects a failed root frame as run-level failure without inventing an overview item", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "root-output-failure",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [] },
      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "failed";
    run.execution = { state: "terminal", lastStatus: "failed", reason: "terminal" };
    run.dynamic!.frames = [{
      frameKey: "root",
      frameKind: "root",
      status: "failed",
      terminalReason: "expression_failed",
      error: {
        reason: "expression_failed",
        message: "Root output callback failed.",
        upstream: {
          source: "acpx",
          operation: "expression.evaluate",
          data: { detail: "exact root failure" },
        },
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    }];

    const overview = snapshot(ir, run);
    const target = targetState(ir, run, "root");

    if (overview.kind !== "snapshot") throw new Error("expected inspection documents");
    expect(overview.run.failure).toEqual({
      origin: "scheduler",
      code: "expression_failed",
      message: "Root output callback failed.",
      upstream: { source: "acpx", operation: "expression.evaluate" },
    });
    expect(overview.items).toEqual([]);
    expect(target.summary.failure).toEqual({
      origin: "scheduler",
      code: "expression_failed",
      message: "Root output callback failed.",
      upstream: {
        source: "acpx",
        operation: "expression.evaluate",
        data: { detail: "exact root failure" },
      },
    });
  });

  it("targets the deepest failed or timed-out scope without repeating its failed ancestor", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "scope-root-cause",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "work",
          kind: "parallel",
          strategy: "all",
          branches: { left: { output: { kind: "object", fields: {} }, nodes: [] } },
        }],
      },
      diagnostics: [],
    };
    const nodePath = appendNode([], "work");
    const branchPath = appendBranch([], "work", "left");
    const nodeKey = deriveInstanceKey(nodePath);
    const branchKey = deriveInstanceKey(branchPath);
    for (const status of ["failed", "timed_out"] as const) {
      const run = repeatedAgentRun(0);
      run.name = ir.name;
      run.status = "failed";
      run.dynamic!.frames = [
        {
          frameKey: nodeKey,
          nodeKey,
          nodeId: "work",
          frameKind: "node",
          status,
          terminalReason: status === "failed" ? "branch_failed" : "attempt_timeout",
          error: { reason: status === "failed" ? "branch_failed" : "attempt_timeout", message: "Propagated scope failure." },
          instancePath: nodePath,
          createdAt: "2026-07-01T00:00:01.000Z",
          updatedAt: "2026-07-01T00:00:03.000Z",
        },
        {
          frameKey: branchKey,
          nodeId: "work",
          parentFrameKey: nodeKey,
          frameKind: "branch",
          status,
          terminalReason: status === "failed" ? "expression_failed" : "attempt_timeout",
          error: { reason: status === "failed" ? "expression_failed" : "attempt_timeout", message: "Root scope failure." },
          instancePath: branchPath,
          createdAt: "2026-07-01T00:00:01.000Z",
          updatedAt: "2026-07-01T00:00:02.000Z",
        },
      ];

      const document = snapshot(ir, run, { all: true });
      if (document?.kind !== "snapshot") throw new Error("expected snapshot");
      expect(document.items.find(item => item.key === `scope:${branchKey}`)).toMatchObject({ status, frameKey: branchKey });
      expect(document.availableActions).toEqual([]);
    }
  });

  it("keeps switch route order undecided and collapsed when condition evaluation fails", () => {
    const task = (id: string) => ({ id, kind: "task" as const, run: { input: { kind: "literal" as const, value: null }, target: { kind: "inline" as const, source: "async function task() {}" } } });
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "failed-switch",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "route",
          kind: "switch",
          cases: [
            { when: { kind: "literal", value: "first" }, then: { output: { kind: "object", fields: {} }, nodes: [task("first_case")] } },
            { when: { kind: "literal", value: "second" }, then: { output: { kind: "object", fields: {} }, nodes: [task("second_case")] } },
          ],
          default: { output: { kind: "object", fields: {} }, nodes: [task("default_case")] },
        }],
      },
      diagnostics: [],
    };
    const routePath = appendNode([], "route");
    const routeKey = deriveInstanceKey(routePath);
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "failed";
    run.dynamic!.frames = [{
      frameKey: routeKey,
      nodeKey: routeKey,
      nodeId: "route",
      frameKind: "node",
      status: "failed",
      terminalReason: "expression_failed",
      error: { reason: "expression_failed", message: "Switch expression failed." },
      instancePath: routePath,
      createdAt: "2026-07-01T00:00:01.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    }];

    const document = snapshot(ir, run, { all: true });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.slice(1).map(item => ({ label: item.label, scope: item.scope, status: item.status }))).toEqual([
      { label: "case 1", scope: { kind: "branch", ownerKind: "switch", branchId: "case:0", selection: "undecided", empty: false }, status: "not_started" },
      { label: "case 2", scope: { kind: "branch", ownerKind: "switch", branchId: "case:1", selection: "undecided", empty: false }, status: "not_started" },
      { label: "default", scope: { kind: "branch", ownerKind: "switch", branchId: "default", selection: "undecided", empty: false }, status: "not_started" },
    ]);
    expect(document.items.some(item => ["first_case", "second_case", "default_case"].includes(item.nodeId ?? ""))).toBe(false);
  });

  it("keeps the derived node item key stable when a placeholder materializes and retries", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "stable-node-key",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "work", kind: "task", run: { input: { kind: "literal", value: null }, target: { kind: "inline", source: "async function task() {}" } } }] },
      diagnostics: [],
    };
    const path = appendNode([], "work");
    const nodeKey = deriveInstanceKey(path);
    const beforeRun = repeatedAgentRun(0);
    beforeRun.name = ir.name;
    const afterRun = repeatedAgentRun(0);
    afterRun.name = ir.name;
    afterRun.dynamic!.nodeInstances = [{ nodeKey, nodeId: "work", instancePath: path, status: "running", createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:03.000Z" }];
    afterRun.dynamic!.attempts = [{ attemptId: "attempt-2", nodeKey, nodeId: "work", attemptNo: 2, status: "started", startedAt: "2026-07-01T00:00:03.000Z" }];
    const before = snapshot(ir, beforeRun);
    const after = snapshot(ir, afterRun);
    if (before?.kind !== "snapshot" || after?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(before.items[0]).toMatchObject({ key: `node:${nodeKey}`, role: "static", status: "not_started" });
    expect(after.items[0]).toMatchObject({ key: `node:${nodeKey}`, role: "instance", status: "running", attemptNo: 2 });
  });

  it("orders only persisted loop rounds and preserves empty rounds", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "persisted-loop-rounds",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "repeat", kind: "loop", state: { kind: "object", fields: {} }, do: { output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } }, nodes: [] } }] },
      diagnostics: [],
    };
    const loopPath = appendNode([], "repeat");
    const round0 = [{ kind: "loop" as const, nodeId: "repeat", iter: 0 }];
    const round2 = [{ kind: "loop" as const, nodeId: "repeat", iter: 2 }];
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic!.frames = [
      { frameKey: deriveInstanceKey(round2), nodeId: "repeat", frameKind: "loop_iteration", status: "completed", instancePath: round2, createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      { frameKey: deriveInstanceKey(loopPath), nodeKey: deriveInstanceKey(loopPath), nodeId: "repeat", frameKind: "loop", status: "completed", instancePath: loopPath, createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      { frameKey: deriveInstanceKey(round0), nodeId: "repeat", frameKind: "loop_iteration", status: "completed", instancePath: round0, createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
    ];
    const document = snapshot(ir, run, { all: true });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.filter(item => item.scope?.kind === "loop_iteration").map(item => ({ label: item.label, scope: item.scope }))).toEqual([
      { label: "round 1", scope: { kind: "loop_iteration", iteration: 0, round: 1, empty: true } },
      { label: "round 3", scope: { kind: "loop_iteration", iteration: 2, round: 3, empty: true } },
    ]);
  });

  it("selects composite member counts from the matching repeated group instance", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "repeated-composite",
      agents: {},
      root: {
        output: { kind: "object", fields: {} }, nodes: [{
        id: "batch",
        kind: "fanout",
        strategy: "all",
        over: { kind: "array", items: [] },
        do: { output: { kind: "object", fields: {} }, nodes: [{
          id: "work",
          kind: "parallel",
          strategy: "all",
          branches: { left: { output: { kind: "object", fields: {} }, nodes: [] }, right: { output: { kind: "object", fields: {} }, nodes: [] } },
        }] },
      }] },

      diagnostics: [],
    };
    const firstItemPath = appendFanoutItem([], "batch", 0);
    const secondItemPath = appendFanoutItem([], "batch", 1);
    const firstWorkPath = appendNode(firstItemPath, "work");
    const secondWorkPath = appendNode(secondItemPath, "work");
    const firstItemKey = deriveInstanceKey(firstItemPath);
    const secondItemKey = deriveInstanceKey(secondItemPath);
    const firstWorkKey = deriveInstanceKey(firstWorkPath);
    const secondWorkKey = deriveInstanceKey(secondWorkPath);
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [
        { frameKey: firstItemKey, nodeId: "batch", frameKind: "fanout_item", status: "completed", instancePath: firstItemPath, createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { frameKey: secondItemKey, nodeId: "batch", frameKind: "fanout_item", status: "running", instancePath: secondItemPath, createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
        { frameKey: firstWorkKey, nodeKey: firstWorkKey, nodeId: "work", parentFrameKey: firstItemKey, frameKind: "node", status: "completed", instancePath: firstWorkPath, createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { frameKey: secondWorkKey, nodeKey: secondWorkKey, nodeId: "work", parentFrameKey: secondItemKey, frameKind: "node", status: "running", instancePath: secondWorkPath, createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      ],
      nodeInstances: [],
      attempts: [],
      groups: [
        { groupKey: firstWorkKey, nodeKey: firstWorkKey, nodeId: "work", kind: "parallel", strategy: "all", status: "completed", maxConcurrency: 1 },
        { groupKey: secondWorkKey, nodeKey: secondWorkKey, nodeId: "work", kind: "parallel", strategy: "all", status: "running", maxConcurrency: 2 },
      ],
      groupMembers: [
        { groupKey: firstWorkKey, memberKey: `${firstWorkKey}:left`, memberKind: "branch", branchId: "left", status: "completed", createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { groupKey: firstWorkKey, memberKey: `${firstWorkKey}:right`, memberKind: "branch", branchId: "right", status: "completed", createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { groupKey: secondWorkKey, memberKey: `${secondWorkKey}:left`, memberKind: "branch", branchId: "left", status: "ready", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
        { groupKey: secondWorkKey, memberKey: `${secondWorkKey}:right`, memberKind: "branch", branchId: "right", status: "running", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      ],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };
    const document = snapshot(ir, run);
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items.find(item => item.nodeKey === firstWorkKey)?.composite).toMatchObject({
      strategy: "all",
      maxConcurrency: 1,
      counts: { total: 2, completed: 2 },
    });
    expect(document.items.find(item => item.nodeKey === secondWorkKey)?.composite).toMatchObject({
      strategy: "all",
      maxConcurrency: 2,
      counts: { total: 2, ready: 1, running: 1 },
    });
  });
});

function compositeWorkflow(agent: WorkflowIR["agents"][string] = { kind: "agent_definition", use: "claude", model: "sonnet" }): WorkflowIR {
  return {
    irVersion: 7,
    name: "inspection-composite",
    agents: { reviewer: agent },
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "batch",
        kind: "fanout",
        strategy: "all",
        over: { kind: "array", items: [] },
        do: {
          output: { kind: "object", fields: {} },
          nodes: [{
            id: "review",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "Review this item" } },
          }],
        },
      }],
    },

    diagnostics: [],
  };
}

function taskWorkflow(input: ExprIR): WorkflowIR {
  return {
    irVersion: 7,
    name: "inspection-task",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "work",
        kind: "task",
        run: {
          input,
          target: { kind: "inline", source: "async function task() {}" },
        },
      }],
    },
    diagnostics: [],
  };
}

function repeatedAgentRun(count: number): RunDetails {
  const instances: RunDynamicNodeInstance[] = Array.from({ length: count }, (_, itemIndex) => ({
    nodeKey: `review~${itemIndex}`,
    nodeId: "review",
    parentFrameKey: `batch.item~${itemIndex}`,
    instancePath: [{ kind: "fanout", nodeId: "batch", itemIndex }, { kind: "node", nodeId: "review" }],
    status: "ready",
    output: { detail: "x".repeat(2_000) },
    createdAt: "2026-07-01T00:00:01.000Z",
    updatedAt: "2026-07-01T00:00:02.000Z",
  }));
  return {
    id: "run-inspection",
    name: "inspection-composite",
    status: "running",
    workflowEntry: "inspection.workflow.ts",
    sourceGraphDigest: "sha256:test",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:02.000Z",
    progressVersion: 1,
    input: {},
    hooks: [],
    eventCount: 80,
    nodeCount: count,
    execution: { state: "active", lastStatus: "running", reason: "run_lease_active" },
    dynamic: {
      version: 80,
      progressVersion: 1,
      frames: [],
      nodeInstances: instances,
      attempts: instances.map((instance, index) => ({
        attemptId: `attempt-${index}`,
        nodeKey: instance.nodeKey,
        nodeId: instance.nodeId,
        attemptNo: 1,
        status: "started",
        startedAt: "2026-07-01T00:00:01.000Z",
      })),
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [{
        id: 1,
        attemptId: "attempt-0",
        kind: "agent_attempt",
        metadata: { turnCount: 2 },
        createdAt: "2026-07-01T00:00:02.000Z",
      }],
      progress: [{
        nodeKey: "review~0",
        nodeId: "review",
        attemptId: "attempt-0",
        attemptNo: 1,
        kind: "agent",
        status: "running",
        context: { used: 2_000, size: 20_000 },
        tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        tools: {
          turn: 4,
          totalToolCallCount: 5,
          lastCalls: [
            { toolName: "OldTool", status: "completed", inputPreview: "hidden" },
            { toolName: "Read", status: "completed", inputPreview: "{\"path\":\"/private/repository\"}" },
            { toolName: "Bash", status: "running", inputPreview: "{\"cmd\":\"FOO=1 env -i sudo -n /usr/bin/rg -n TODO packages\"}" },
            { title: "Analyze repository dependency graph with details", status: "failed", inputPreview: "hidden" },
          ],
        },
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
    },
  };
}

function event(sequence: number, type: string) {
  return {
    runId: "run-inspection",
    sequence,
    type,
    nodeKey: "review~0",
    payload: { nodeKey: "review~0", nodeId: "review" },
    createdAt: `2026-07-01T00:00:0${sequence}.000Z`,
    idempotencyKey: `event-${sequence}`,
  };
}

function inspectionFolds(entries: readonly InspectionTreeEntry[]): Array<Extract<InspectionTreeEntry, { type: "fold" }>> {
  return entries.flatMap(entry => entry.type === "fold"
    ? [entry, ...inspectionFolds(entry.children)]
    : inspectionFolds(entry.children));
}
