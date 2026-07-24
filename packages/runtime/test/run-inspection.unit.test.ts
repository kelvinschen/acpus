import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import type { SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { progressChanges, projectRunInspection, semanticChanges } from "../src/inspection/projection.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import type { ArtifactRecord, RunDetails, RunDynamicNodeInstance } from "../src/store/store.js";

describe("run inspection projection", () => {
  it("bounds repeated composite contexts while preserving structure, counts, and agent status", () => {
    const run = repeatedAgentRun(25);
    const overview = projectRunInspection({
      ir: compositeWorkflow(),
      run,
      artifacts: [],
      cursor: { eventSequence: 80, progressVersion: 1 },
      query: { runId: run.id, mode: "overview" },
    });
    const all = projectRunInspection({
      ir: compositeWorkflow(),
      run,
      artifacts: [],
      cursor: { eventSequence: 80, progressVersion: 1 },
      query: { runId: run.id, mode: "all" },
    });

    expect(overview).toMatchObject({
      kind: "snapshot",
      omitted: { limit: 20, dynamicContexts: 5, counts: { ready: 5 } },
      actions: [{ kind: "inspect-all", omitted: 5 }],
    });
    if (overview?.kind !== "snapshot" || all?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(overview.counts).toEqual({ total: 25, ready: 25 });
    expect(all.counts).toEqual({ total: 25, ready: 25 });
    expect(overview.run.agentUsage).toEqual({ instances: 25, attempts: 25, turns: 4 });
    expect(overview.items.filter(item => item.role === "instance")).toHaveLength(20);
    expect(all.items.filter(item => item.role === "instance")).toHaveLength(25);
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
        agent: expect.objectContaining({
          key: "reviewer",
          availability: { context: "available", tokenUsage: "available" },
          backend: { kind: "use", name: "claude" },
          model: "sonnet",
          turnCount: 4,
          lastActivityAt: "2026-07-01T00:00:02.000Z",
          context: { used: 2_000, size: 20_000 },
          tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          tools: {
            totalCallCount: 5,
            recent: [
              { command: "Read", status: "completed" },
              { command: "Bash: rg", status: "running" },
              { command: "Analyze repository dependency…", status: "failed" },
            ],
          },
        }),
      }),
    ]));
    const compact = JSON.stringify(overview);
    expect(compact).not.toContain("inputPreview");
    expect(compact).not.toContain("private/repository");
    expect(compact).not.toContain("TODO packages");
  });

  it("counts leaf execution contexts independently from compact folding", () => {
    const unmaterialized = repeatedAgentRun(0);
    const repeated = repeatedAgentRun(25);
    for (const instance of repeated.dynamic!.nodeInstances) instance.status = "completed";
    const initial = projectRunInspection({ ir: compositeWorkflow(), run: unmaterialized, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: unmaterialized.id, mode: "overview" } });
    const folded = projectRunInspection({ ir: compositeWorkflow(), run: repeated, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: repeated.id, mode: "overview" } });

    if (initial?.kind !== "snapshot" || folded?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(initial.counts).toEqual({ total: 1, notStarted: 1 });
    expect(initial.run.agentUsage).toEqual({ instances: 0, attempts: 0, turns: 0 });
    expect(folded.counts).toEqual({ total: 25, completed: 25 });
    expect(folded.items.filter(item => item.role === "instance")).toHaveLength(0);
    expect(folded.items.find(item => item.role === "fold")?.fold).toEqual({ count: 25, counts: { total: 25, completed: 25 } });
  });

  it("keeps a partial outer occurrence while folding over-budget inner items", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const overview = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (overview?.kind !== "snapshot") throw new Error("expected snapshot");

    const outerKey = `scope:${deriveInstanceKey(outerItemPath)}`;
    const innerKey = `node:${deriveInstanceKey(appendNode(outerItemPath, "inner"))}`;
    expect(overview.items.filter(item => item.nodeId === "outer" && item.scope?.kind === "fanout_item")).toEqual([
      expect.objectContaining({ key: outerKey, scope: { kind: "fanout_item", itemIndex: 0, empty: false } }),
    ]);
    expect(overview.items.filter(item => item.nodeId === "inner" && item.scope?.kind === "fanout_item")).toHaveLength(20);
    expect(overview.items.filter(item => item.role === "instance")).toHaveLength(20);
    expect(overview.items.filter(item => item.role === "fold")).toEqual([
      expect.objectContaining({ parentKey: innerKey, fold: { count: 5, counts: { total: 5, ready: 5 } } }),
    ]);
    expect(overview.omitted).toMatchObject({ dynamicContexts: 5, counts: { total: 5, ready: 5 } });
  });

  it("counts retry attempts, response-repair turns, and newer active turn progress", () => {
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

    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 2 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.run.agentUsage).toEqual({ instances: 1, attempts: 2, turns: 5 });
  });

  it("marks unavailable Agent telemetry in inspection JSON", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.progress = [];
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.find(item => item.nodeKey === "review~0")?.agent?.availability).toEqual({
      context: "unavailable",
      tokenUsage: "unavailable",
    });
  });

  it("projects only direct fork lineage into inspection summaries", () => {
    const run = repeatedAgentRun(0);
    run.fork = { sourceRunId: "run_source", target: "review~failed", unsafeReuse: true };
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.run.fork).toEqual({ sourceRunId: "run_source", target: "review~failed", unsafeReuse: true });
  });

  it("counts every repeated Assert frame as a distinct execution context", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 20, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.counts).toEqual({ total: 20, completed: 20 });
  });

  it("never folds failed or timed-out repeated executions", () => {
    for (const status of ["failed", "timed_out"] as const) {
      const run = repeatedAgentRun(25);
      for (const instance of run.dynamic!.nodeInstances) instance.status = status;
      const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
      if (document?.kind !== "snapshot") throw new Error("expected snapshot");
      expect(document.items.filter(item => item.role === "fold" && item.status === status)).toHaveLength(0);
      expect(document.items.filter(item => item.role === "instance" && item.status === status)).toHaveLength(25);
      expect(document.omitted).toBeUndefined();
    }
  });

  it("reports how many budget-omitted Agents already carry progress", () => {
    const run = repeatedAgentRun(25);
    const baseline = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (baseline?.kind !== "snapshot") throw new Error("expected snapshot");
    const visible = new Set(baseline.items.flatMap(item => item.nodeKey ? [item.nodeKey] : []));
    const hidden = run.dynamic!.nodeInstances.find(instance => !visible.has(instance.nodeKey))!;
    const { attemptId: _attemptId, ...progress } = run.dynamic!.progress[0]!;
    run.dynamic!.progress.push({
      ...progress,
      nodeKey: hidden.nodeKey,
      updatedAt: "2026-07-01T00:00:03.000Z",
    });
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 80, progressVersion: 2 }, query: { runId: run.id, mode: "overview" } });

    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.omitted).toMatchObject({
      dynamicContexts: 5,
      agentProgress: { tracked: 1 },
    });
  });

  it("keeps default JSON compact and exposes complete target and raw projections", () => {
    const run = repeatedAgentRun(25);
    const artifact: ArtifactRecord = {
      id: "turn-1",
      runId: run.id,
      nodeKey: "review~0",
      attempt: 1,
      mediaType: "application/json",
      digest: "sha256:abc",
      size: 42,
      path: "/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/review~0/attempt-1/agent/turn-001.json",
    };
    const overview = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [artifact], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    const target = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [artifact], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "target", target: "review" } });
    const raw = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [artifact], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: run.id, mode: "raw" } });

    expect(target).toMatchObject({ kind: "target", target: { kind: "static-node", id: "review" } });
    if (target?.kind !== "target" || raw?.kind !== "raw") throw new Error("expected target and raw");
    expect(target.instances).toHaveLength(25);
    expect(target.attempts).toHaveLength(25);
    expect(target.summary).toMatchObject({ nodeStatus: "ready", counts: { total: 25, ready: 25 } });
    for (const field of ["nodeKey", "frameKey", "input", "output", "failure", "prompt", "latestAttempt", "loopProgress", "agent", "signal"] as const) {
      expect(target.summary[field]).toBeUndefined();
    }
    expect(target.artifacts).toEqual([artifact]);
    expect(isAbsolute(target.artifacts[0]!.path)).toBe(true);
    expect(JSON.stringify(target.artifacts)).not.toContain("relativePath");
    expect(raw.run.dynamic?.nodeInstances).toHaveLength(25);
    expect(JSON.stringify(overview)).not.toContain('"dynamic"');
    expect(JSON.stringify(overview).length).toBeLessThan(JSON.stringify(raw).length * 0.35);
  });

  it("keeps repeated static targets aggregate and preserves single-instance detail", () => {
    const repeated = repeatedAgentRun(2);
    repeated.dynamic!.nodeInstances[0]!.status = "completed";
    repeated.dynamic!.nodeInstances[0]!.output = { old: true };
    repeated.dynamic!.nodeInstances[0]!.updatedAt = "2026-07-01T00:00:01.000Z";
    repeated.dynamic!.nodeInstances[1]!.status = "running";
    delete repeated.dynamic!.nodeInstances[1]!.output;
    repeated.dynamic!.nodeInstances[1]!.updatedAt = "2026-07-01T00:00:03.000Z";
    const aggregate = projectRunInspection({ ir: compositeWorkflow(), run: repeated, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: repeated.id, mode: "target", target: "review" } });
    if (aggregate?.kind !== "target") throw new Error("expected aggregate target");

    expect(aggregate.summary).toMatchObject({ nodeStatus: "running", counts: { total: 2, running: 1, completed: 1 } });
    expect(aggregate.summary.nodeKey).toBeUndefined();
    expect(aggregate.summary.output).toBeUndefined();
    expect(aggregate.summary.agent).toBeUndefined();

    const single = repeatedAgentRun(1);
    const detailed = projectRunInspection({ ir: compositeWorkflow(), run: single, artifacts: [], cursor: { eventSequence: 80, progressVersion: 1 }, query: { runId: single.id, mode: "target", target: "review" } });
    if (detailed?.kind !== "target") throw new Error("expected detailed target");
    expect(detailed.summary).toMatchObject({ nodeStatus: "ready", nodeKey: "review~0", latestAttempt: { attemptId: "attempt-0" }, agent: { key: "reviewer" } });
    expect(detailed.summary.counts).toBeUndefined();
  });

  it("preserves every durable transition between polls in event order", () => {
    const run = repeatedAgentRun(1);
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 5, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
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

  it("emits failed scope-frame changes with exact occurrence identity while suppressing terminal bookkeeping", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 6, progressVersion: 0 }, query: { runId: run.id, mode: "all" } });
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
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 7, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (!document) throw new Error("expected document");
    const changes = semanticChanges([
      { ...event(6, "frame.loop_advanced"), nodeKey: "batch~loop", payload: { frameKey: "batch~loop", iter: 0, state: {} } },
      { ...event(7, "frame.loop_advanced"), nodeKey: "batch~loop", payload: { frameKey: "batch~loop", iter: 0, state: {}, transition: { state: {}, stop: false } } },
    ], document, run);

    expect(changes.map(change => change.message)).toEqual(["round=1 started", "round=1 completed"]);
  });

  it("absorbs duplicate signal and scheduler bookkeeping while retaining the operator transition", () => {
    const run = repeatedAgentRun(1);
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 9, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
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

  it("keeps materialized Assert nodes in the authored compact tree", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
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

  it("keeps the authored agent key compact while exposing effective command definitions only to target and raw", () => {
    const ir = compositeWorkflow({ kind: "agent_command", command: "some-provider --unsafe-secret", model: "custom" });
    const run = repeatedAgentRun(1);
    const overview = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    const target = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "target", target: "review" } });
    const raw = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "raw" } });

    if (overview?.kind !== "snapshot" || target?.kind !== "target" || raw?.kind !== "raw") throw new Error("expected inspection documents");
    expect(overview.items.find(item => item.nodeKey === "review~0")?.agent).toMatchObject({
      key: "reviewer",
      backend: { kind: "command" },
      model: "custom",
    });
    expect(JSON.stringify(overview)).not.toContain("some-provider");
    expect(target.summary.agentDefinition).toEqual({ kind: "agent_command", command: "some-provider --unsafe-secret", model: "custom" });
    expect(raw.workflow.agents.reviewer).toEqual(target.summary.agentDefinition);
  });

  it("keeps the authored Agent key when the effective backend is overridden", () => {
    const effectiveIr = compositeWorkflow({ kind: "agent_definition", use: "codex", model: "gpt-5" });
    const run = repeatedAgentRun(1);
    run.agentOverrides = { reviewer: { use: "codex", model: "gpt-5" } };
    const document = projectRunInspection({ ir: effectiveIr, run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items.find(item => item.nodeKey === "review~0")?.agent).toMatchObject({
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items.find(item => item.nodeKey === "review~0")?.agent).toMatchObject({
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
    const document = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items.find(item => item.nodeKey === "review~0")?.agent).toMatchObject({
      key: "reviewer",
      turnCount: 2,
      lastActivityAt: "2026-07-01T00:00:03.000Z",
      context: { used: 4_000, size: 20_000 },
      tokenUsage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      tools: { totalCallCount: 7, recent: [] },
      stopReason: "end_turn",
    });
  });

  it("emits progress only for agents whose normalized operational state changed", () => {
    const beforeRun = repeatedAgentRun(2);
    const activityOnlyRun = repeatedAgentRun(2);
    activityOnlyRun.dynamic!.progress[0]!.updatedAt = "2026-07-01T00:00:03.000Z";
    const changedRun = repeatedAgentRun(2);
    changedRun.dynamic!.progress[0]!.updatedAt = "2026-07-01T00:00:04.000Z";
    changedRun.dynamic!.progress[0]!.tokenUsage = { inputTokens: 150, outputTokens: 25, totalTokens: 175 };
    const before = projectRunInspection({ ir: compositeWorkflow(), run: beforeRun, artifacts: [], cursor: { eventSequence: 1, progressVersion: 1 }, query: { runId: beforeRun.id, mode: "overview" } });
    const activityOnly = projectRunInspection({ ir: compositeWorkflow(), run: activityOnlyRun, artifacts: [], cursor: { eventSequence: 1, progressVersion: 2 }, query: { runId: activityOnlyRun.id, mode: "overview" } });
    const changed = projectRunInspection({ ir: compositeWorkflow(), run: changedRun, artifacts: [], cursor: { eventSequence: 1, progressVersion: 3 }, query: { runId: changedRun.id, mode: "overview" } });
    if (!before || !activityOnly || !changed) throw new Error("expected inspection documents");

    expect(progressChanges(before, activityOnly)).toEqual([]);
    expect(progressChanges(before, changed)).toEqual([expect.objectContaining({
      action: "progress",
      subject: "batch[0] › review",
      progressVersion: 3,
      itemKey: `node:${deriveInstanceKey(appendNode(appendFanoutItem([], "batch", 0), "review"))}`,
      status: "ready",
    })]);
  });

  it("bounds Signal prompt/schema summaries while target and raw retain full frozen detail", () => {
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field_${index}`, { kind: "string" as const }]));
    const outputSchema: SchemaIR = { kind: "object", fields, required: Object.keys(fields), additionalProperties: false };
    const ir: WorkflowIR = {
      irVersion: 6,
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

    const overview = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    const target = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "target", target: "approve" } });
    const raw = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "raw" } });
    if (overview?.kind !== "snapshot" || target?.kind !== "target" || raw?.kind !== "raw") throw new Error("expected inspection documents");

    const compactSignal = overview.items.find(item => item.nodeKey === "approve~1")?.signal;
    expect(overview.items.find(item => item.nodeKey === "approve~1")?.parentKey).toBeUndefined();
    expect(compactSignal?.promptPreview?.length).toBeLessThanOrEqual(160);
    expect(compactSignal?.schemaSummary?.length).toBeLessThanOrEqual(160);
    expect(compactSignal?.outputSchema).toBeUndefined();
    expect(JSON.stringify(overview)).not.toContain("PROMPT_TAIL");
    expect(JSON.stringify(overview)).not.toContain("field_79");
    expect(target.summary.signal?.promptPreview).toBe(prompt);
    expect(target.summary.signal?.outputSchema).toEqual(outputSchema);
    expect(raw.workflow).toEqual(ir);
  });

  it("aggregates repeated Signal targets from normalized wait status", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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

    const awaiting = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 4, progressVersion: 0 }, query: { runId: run.id, mode: "target", target: "approve" } });
    if (awaiting?.kind !== "target") throw new Error("expected target");
    expect(awaiting.summary).toMatchObject({ nodeStatus: "awaiting", counts: { total: 2, awaiting: 2 } });
    expect(awaiting.items.filter(item => item.role === "instance").map(item => item.status)).toEqual(["awaiting", "awaiting"]);

    for (const instance of run.dynamic.nodeInstances) instance.status = "failed";
    for (const wait of run.dynamic.signalWaits) wait.status = "timed_out";
    const timedOut = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 6, progressVersion: 0 }, query: { runId: run.id, mode: "target", target: "approve" } });
    if (timedOut?.kind !== "target") throw new Error("expected target");
    expect(timedOut.summary).toMatchObject({ nodeStatus: "timed_out", counts: { total: 2, timedOut: 2 } });
    expect(timedOut.items.filter(item => item.role === "instance").map(item => item.status)).toEqual(["timed_out", "timed_out"]);
  });

  it("keeps terminal Signal timeout evidence and exposes only retry/fork recovery actions", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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

    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 3, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    const target = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 3, progressVersion: 0 }, query: { runId: run.id, mode: "target", target: "approve~abc" } });
    if (document?.kind !== "snapshot" || target?.kind !== "target") throw new Error("expected inspection documents");

    expect(document.items.find(item => item.nodeKey === "approve~abc")).toMatchObject({
      status: "timed_out",
      failure: { origin: "scheduler", code: "signal_timeout", message: "Approval timed out." },
      signal: { target: "approve~abc", deadlineAt: "2026-07-01T00:01:00.000Z" },
    });
    const approvalItemKey = `node:${deriveInstanceKey(appendNode([], "approve"))}`;
    expect(document.actions).toEqual([
      { kind: "inspect-target", target: "approve~abc", itemKey: approvalItemKey },
      { kind: "retry", target: "approve~abc", itemKey: approvalItemKey },
      { kind: "fork" },
    ]);
    expect(target.summary).toMatchObject({
      nodeStatus: "timed_out",
      failure: { code: "signal_timeout" },
      signal: { target: "approve~abc", deadlineAt: "2026-07-01T00:01:00.000Z" },
    });

    run.dynamic.signalWaits[0] = { ...run.dynamic.signalWaits[0]!, status: "cancelled", terminalReason: "manual_cancel" };
    run.dynamic.nodeInstances[0] = { ...run.dynamic.nodeInstances[0]!, statusReason: "manual_cancel", error: { reason: "manual_cancel", message: "Cancelled." } };
    const ordinaryFailure = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 4, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    if (ordinaryFailure?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(ordinaryFailure.actions).toEqual([{ kind: "inspect-target", target: "approve~abc", itemKey: approvalItemKey }]);
  });

  it("distinguishes scheduler, provider, and task failure origins with stable codes", () => {
    const schedulerRun = repeatedAgentRun(1);
    schedulerRun.dynamic!.nodeInstances[0]!.status = "failed";
    schedulerRun.dynamic!.nodeInstances[0]!.statusReason = "expression_resolution_failed";
    schedulerRun.dynamic!.nodeInstances[0]!.error = { reason: "expression_resolution_failed", message: "Prompt resolution failed." };
    const scheduler = projectRunInspection({ ir: compositeWorkflow(), run: schedulerRun, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: schedulerRun.id, mode: "overview" } });
    if (scheduler?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(scheduler.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "scheduler",
      code: "expression_resolution_failed",
      message: "Prompt resolution failed.",
    });

    const providerRun = repeatedAgentRun(1);
    providerRun.dynamic!.nodeInstances[0]!.status = "failed";
    providerRun.dynamic!.nodeInstances[0]!.error = { code: "invalid_api_key", message: "Provider rejected the API key." };
    const provider = projectRunInspection({ ir: compositeWorkflow(), run: providerRun, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: providerRun.id, mode: "overview" } });
    if (provider?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(provider.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "provider",
      code: "invalid_api_key",
      message: "Provider rejected the API key.",
    });

    const runtimeRun = repeatedAgentRun(1);
    runtimeRun.dynamic!.nodeInstances[0]!.status = "failed";
    runtimeRun.dynamic!.nodeInstances[0]!.error = { origin: "runtime", code: "invalid_agent_response_repair_max", message: "Invalid runtime configuration." };
    const runtime = projectRunInspection({ ir: compositeWorkflow(), run: runtimeRun, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: runtimeRun.id, mode: "overview" } });
    if (runtime?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(runtime.items.find(item => item.nodeKey === "review~0")?.failure).toEqual({
      origin: "runtime",
      code: "invalid_agent_response_repair_max",
      message: "Invalid runtime configuration.",
    });

    const taskIr: WorkflowIR = {
      irVersion: 6,
      name: "task-failure",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "work", kind: "task", run: { input: {}, target: { kind: "inline", source: "async function task() {}" } } }] },

      diagnostics: [],
    };
    const taskRun = repeatedAgentRun(1);
    taskRun.dynamic!.nodeInstances[0] = { ...taskRun.dynamic!.nodeInstances[0]!, nodeKey: "work~0", nodeId: "work", instancePath: [{ kind: "node", nodeId: "work" }], status: "failed", error: { code: "invalid_output", message: "Task returned invalid output." } };
    taskRun.dynamic!.attempts[0] = { ...taskRun.dynamic!.attempts[0]!, nodeKey: "work~0", nodeId: "work", status: "failed" };
    const task = projectRunInspection({ ir: taskIr, run: taskRun, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: taskRun.id, mode: "overview" } });
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
    const overview = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: run.id, mode: "overview" } });
    const target = projectRunInspection({ ir: compositeWorkflow(), run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 1 }, query: { runId: run.id, mode: "target", target: "review" } });
    if (overview?.kind !== "snapshot" || target?.kind !== "target") throw new Error("expected inspection documents");

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
      irVersion: 6,
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
                nodes: [{ id: "fallback", kind: "task", run: { input: {}, target: { kind: "inline", source: "async function task() {}" } } }],
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

    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 7, progressVersion: 0 }, query: { runId: run.id, mode: "all" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.omitted).toBeUndefined();
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
      irVersion: 6,
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

    const overview = projectRunInspection({
      ir,
      run,
      artifacts: [],
      cursor: { eventSequence: 2, progressVersion: 0 },
      query: { runId: run.id, mode: "overview" },
    });
    const target = projectRunInspection({
      ir,
      run,
      artifacts: [],
      cursor: { eventSequence: 2, progressVersion: 0 },
      query: { runId: run.id, mode: "target", target: "root" },
    });

    if (overview?.kind !== "snapshot" || target?.kind !== "target") throw new Error("expected inspection documents");
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
      irVersion: 6,
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

      const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "all" } });
      if (document?.kind !== "snapshot") throw new Error("expected snapshot");
      expect(document.items.find(item => item.key === `scope:${branchKey}`)).toMatchObject({ status, frameKey: branchKey });
      expect(document.actions).toEqual([{ kind: "inspect-target", target: branchKey, itemKey: `scope:${branchKey}` }]);
    }
  });

  it("keeps switch route order undecided and collapsed when condition evaluation fails", () => {
    const task = (id: string) => ({ id, kind: "task" as const, run: { input: {}, target: { kind: "inline" as const, source: "async function task() {}" } } });
    const ir: WorkflowIR = {
      irVersion: 6,
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

    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 2, progressVersion: 0 }, query: { runId: run.id, mode: "all" } });
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
      irVersion: 6,
      name: "stable-node-key",
      agents: {},
      root: { output: { kind: "object", fields: {} }, nodes: [{ id: "work", kind: "task", run: { input: {}, target: { kind: "inline", source: "async function task() {}" } } }] },
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
    const before = projectRunInspection({ ir, run: beforeRun, artifacts: [], cursor: { eventSequence: 1, progressVersion: 0 }, query: { runId: beforeRun.id, mode: "overview" } });
    const after = projectRunInspection({ ir, run: afterRun, artifacts: [], cursor: { eventSequence: 3, progressVersion: 0 }, query: { runId: afterRun.id, mode: "overview" } });
    if (before?.kind !== "snapshot" || after?.kind !== "snapshot") throw new Error("expected snapshots");
    expect(before.items[0]).toMatchObject({ key: `node:${nodeKey}`, role: "static", status: "not_started" });
    expect(after.items[0]).toMatchObject({ key: `node:${nodeKey}`, role: "instance", status: "running", attemptNo: 2 });
  });

  it("orders only persisted loop rounds and preserves empty rounds", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 3, progressVersion: 0 }, query: { runId: run.id, mode: "all" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(document.items.filter(item => item.scope?.kind === "loop_iteration").map(item => ({ label: item.label, scope: item.scope }))).toEqual([
      { label: "round 1", scope: { kind: "loop_iteration", iteration: 0, round: 1, empty: true } },
      { label: "round 3", scope: { kind: "loop_iteration", iteration: 2, round: 3, empty: true } },
    ]);
  });

  it("selects composite member counts from the matching repeated group instance", () => {
    const ir: WorkflowIR = {
      irVersion: 6,
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
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 4, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
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
    irVersion: 6,
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
