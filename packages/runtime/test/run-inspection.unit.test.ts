import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import type { SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { progressChanges, projectRunInspection, semanticChanges } from "../src/inspection/projection.js";
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
      expect.objectContaining({ role: "context", label: "batch / item 0", kind: "fanout_item" }),
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
      irVersion: 5,
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
      expect(document.items.filter(item => item.role === "instance" && item.status === status)).toHaveLength(20);
      expect(document.omitted).toMatchObject({ dynamicContexts: 5 });
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
      path: "/workspace/.acpus/.local/runs/run_1/artifacts/review~0/attempt-1/agent/turn-001.json",
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
    expect(JSON.stringify(overview).length).toBeLessThan(JSON.stringify(raw).length * 0.25);
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
    expect(changes.map(change => [change.sequence, change.action, change.status, change.subject, change.itemKey])).toEqual([
      [3, "ready", "ready", "review", "instance:review~0"],
      [4, "started", "running", "review", "instance:review~0"],
      [5, "completed", "completed", "review", "instance:review~0"],
    ]);
    expect(changes).not.toEqual(expect.arrayContaining([expect.objectContaining({ item: expect.anything() })]));
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
      irVersion: 5,
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
      role: "static",
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
      itemKey: "instance:review~0",
      status: "ready",
    })]);
  });

  it("bounds Signal prompt/schema summaries while target and raw retain full frozen detail", () => {
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field_${index}`, { kind: "string" as const }]));
    const outputSchema: SchemaIR = { kind: "object", fields, required: Object.keys(fields), additionalProperties: false };
    const ir: WorkflowIR = {
      irVersion: 5,
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
      irVersion: 5,
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
      irVersion: 5,
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
    expect(document.actions).toEqual([
      { kind: "inspect-target", target: "approve~abc" },
      { kind: "retry", target: "approve~abc" },
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
    expect(ordinaryFailure.actions).toEqual([{ kind: "inspect-target", target: "approve~abc" }]);
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
      irVersion: 5,
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

  it("selects composite member counts from the matching repeated group instance", () => {
    const ir: WorkflowIR = {
      irVersion: 5,
      name: "repeated-composite",
      agents: {},
      root: {
        output: { kind: "object", fields: {} }, nodes: [{
        id: "work",
        kind: "parallel",
        strategy: "all",
        branches: { left: { output: { kind: "object", fields: {} }, nodes: [] }, right: { output: { kind: "object", fields: {} }, nodes: [] } },
      }] },

      diagnostics: [],
    };
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [
        { frameKey: "work~1", nodeKey: "work~1", nodeId: "work", frameKind: "node", status: "completed", createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { frameKey: "work~2", nodeKey: "work~2", nodeId: "work", frameKind: "node", status: "running", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      ],
      nodeInstances: [],
      attempts: [],
      groups: [
        { groupKey: "group~1", nodeKey: "work~1", nodeId: "work", kind: "parallel", strategy: "all", status: "completed", maxConcurrency: 1 },
        { groupKey: "group~2", nodeKey: "work~2", nodeId: "work", kind: "parallel", strategy: "all", status: "running", maxConcurrency: 2 },
      ],
      groupMembers: [
        { groupKey: "group~1", memberKey: "group~1:left", memberKind: "branch", branchId: "left", status: "completed", createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:02.000Z" },
        { groupKey: "group~2", memberKey: "group~2:left", memberKind: "branch", branchId: "left", status: "ready", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
        { groupKey: "group~2", memberKey: "group~2:right", memberKind: "branch", branchId: "right", status: "running", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
      ],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };
    const document = projectRunInspection({ ir, run, artifacts: [], cursor: { eventSequence: 4, progressVersion: 0 }, query: { runId: run.id, mode: "overview" } });
    if (document?.kind !== "snapshot") throw new Error("expected snapshot");

    expect(document.items.find(item => item.key === "static:work")?.composite).toMatchObject({
      strategy: "all",
      maxConcurrency: 2,
      counts: { total: 2, ready: 1, running: 1 },
    });
  });
});

function compositeWorkflow(agent: WorkflowIR["agents"][string] = { kind: "agent_definition", use: "claude", model: "sonnet" }): WorkflowIR {
  return {
    irVersion: 5,
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
