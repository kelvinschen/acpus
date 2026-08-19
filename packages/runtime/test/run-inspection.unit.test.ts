import { describe, expect, it } from "vitest";
import type { SchemaIR, WorkflowIR } from "@acpus/core/ir";
import {
  projectInspectionRunDecisionView,
  projectInspectionRunView,
  resolveTargetState,
} from "../src/inspection/projection.js";
import { projectInspectionTargetSummaryView } from "../src/inspection/decision-projection.js";
import { inspectionChanges } from "../src/inspection/use-cases.js";
import type { AgentObservationInspectionProjection } from "../src/observations/log.js";
import type { InspectionTreeEntry } from "../src/inspection/types.js";
import {
  appendBranch,
  appendFanoutItem,
  appendLoopIteration,
  appendNode,
  deriveInstanceKey,
} from "../src/scheduler/identity.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import type { RunDynamicNodeInstance } from "../src/store/inspection-read-model.js";
import type { RunDetails } from "../src/store/store.js";

describe("run inspection projection", () => {
  it("projects the public run contract directly without a legacy snapshot envelope", () => {
    const view = projectInspectionRunView({
      ir: compositeWorkflow(),
      run: repeatedAgentRun(3),
    });

    expect(view).toMatchObject({
      kind: "run",
      run: {
        id: "run-inspection",
        name: "inspection-composite",
        status: "running",
        liveness: "active",
      },
      counts: { total: 3, ready: 3 },
    });
    expect(inspectionFolds(view.tree)).toEqual([
      expect.objectContaining({
        scope: "fanout-items",
        range: { start: 0, end: 2 },
        count: 3,
        state: { status: "ready" },
      }),
    ]);
    expect(view).not.toHaveProperty("schemaVersion");
    expect(view).not.toHaveProperty("items");
    expect(view).not.toHaveProperty("availableActions");
    expect(view).not.toHaveProperty("hooks");
    expect(view).not.toHaveProperty("all");
    expect(view).not.toHaveProperty("scope");
    expect(JSON.stringify(view)).not.toContain("private/repository");
    expect(JSON.stringify(view)).not.toContain("tokenUsage");
  });

  it("folds terminal Fanout items with different durations without retaining occurrence identity", () => {
    const run = repeatedAgentRun(3);
    run.status = "completed";
    run.execution = { state: "terminal", lastStatus: "completed" };
    run.dynamic!.progress = [];
    run.dynamic!.executionMetadata = [];
    for (const instance of run.dynamic!.nodeInstances) instance.status = "completed";
    for (const [index, attempt] of run.dynamic!.attempts.entries()) {
      attempt.status = "completed";
      attempt.finishedAt = `2026-07-01T00:00:0${index + 2}.000Z`;
    }

    const [fold] = inspectionFolds(projectInspectionRunView({ ir: compositeWorkflow(), run }).tree);

    expect(fold).toMatchObject({
      scope: "fanout-items",
      count: 3,
      state: { status: "completed" },
    });
    expect(JSON.stringify(fold)).not.toContain("durationMs");
    expect(JSON.stringify(fold)).not.toContain("selector");
  });

  it("keeps every materialized Fanout occurrence instead of repeat-folding", () => {
    const view = projectInspectionRunView({
      ir: compositeWorkflow(),
      run: repeatedAgentRun(3),
      structure: "materialized",
    });

    expect(inspectionFolds(view.tree)).toEqual([]);
    expect(inspectionItems(view.tree).filter(entry => entry.subject.kind === "fanout_item"))
      .toHaveLength(3);
  });

  it("projects an Agent tree pulse only from the matching retained Observation", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.nodeInstances[0]!.status = "running";
    const thinking = projectInspectionRunView({
      ir: compositeWorkflow(),
      run,
      observations: runAgentObservations({
        phase: "thinking",
        intent: {
          kind: "reported-thought",
          excerpt: { text: "private reasoning", originalBytes: 17, truncated: false },
        },
      }),
    });

    expect(agentEntries(thinking.tree)[0]?.pulse).toEqual({ phase: "reported-thought", turn: 1 });
    expect(JSON.stringify(thinking)).not.toContain("private reasoning");

    const tooling = projectInspectionRunView({
      ir: compositeWorkflow(),
      run,
      observations: runAgentObservations({
        phase: "tool",
        tools: {
          active: [{ name: "Bash", status: "running", updatedAt: run.updatedAt }],
          omittedActive: 0,
        },
      }),
    });
    expect(agentEntries(tooling.tree)[0]?.pulse).toEqual({
      phase: "tool",
      turn: 1,
      tool: { name: "Bash", state: "running" },
    });
  });

  it("projects only the safe authored Agent name into the run tree", () => {
    const named = projectInspectionRunView({ ir: compositeWorkflow(), run: repeatedAgentRun(1) });
    const commandIr = compositeWorkflow();
    commandIr.agents.reviewer = {
      kind: "agent_command",
      command: "private-acp-server --token secret",
      model: "private-model",
    };
    const custom = projectInspectionRunView({ ir: commandIr, run: repeatedAgentRun(1) });

    expect(agentEntries(named.tree)[0]?.agent).toEqual({
      name: "claude",
      telemetry: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        contextWindow: { used: 2_000, size: 20_000 },
      },
    });
    expect(agentEntries(custom.tree)[0]?.agent).toMatchObject({ name: "custom" });
    expect(JSON.stringify(custom.tree)).not.toMatch(/private-acp-server|private-model|secret/);
  });

  it("identifies an unstarted Agent from the frozen workflow", () => {
    const ir = singleAgentWorkflow();
    const run = repeatedAgentRun(0);
    run.name = ir.name;

    const [agent] = agentEntries(projectInspectionRunView({ ir, run }).tree);

    expect(agent).toMatchObject({
      subject: { label: "review", kind: "agent" },
      state: { status: "not_started" },
      agent: { name: "claude" },
    });
    expect(agent?.agent).not.toHaveProperty("telemetry");
  });

  it("does not synthesize an Agent pulse from progress or execution metadata without Observations", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.nodeInstances[0]!.status = "running";
    run.dynamic!.progress[0] = {
      ...run.dynamic!.progress[0]!,
      output: { tail: "progress-only response", totalBytes: 22, truncated: false },
      tools: {
        turn: 9,
        totalToolCallCount: 1,
        lastCalls: [{ toolName: "Bash", status: "running", updatedAt: run.updatedAt }],
      },
    };
    run.dynamic!.executionMetadata[0] = {
      ...run.dynamic!.executionMetadata[0]!,
      metadata: { turnCount: 9, output: "metadata-only response" },
    };

    const agent = agentEntries(projectInspectionRunView({ ir: compositeWorkflow(), run }).tree)[0];

    expect(agent).not.toHaveProperty("pulse");
    expect(JSON.stringify(agent)).not.toMatch(/progress-only|metadata-only|Bash/);
  });

  it("keeps terminal state-derived pulse out of the decision projection", () => {
    const run = repeatedAgentRun(1);
    run.dynamic!.nodeInstances[0]!.status = "completed";
    run.dynamic!.attempts[0]!.status = "completed";
    run.dynamic!.attempts[0]!.finishedAt = run.updatedAt;

    const visible = projectInspectionRunView({ ir: compositeWorkflow(), run });
    const view = projectInspectionRunDecisionView({ ir: compositeWorkflow(), run });

    expect(agentEntries(visible.tree)[0]?.pulse).toEqual({ phase: "settled" });
    expect(view.kind).toBe("run");
    expect(view.counts).toEqual({ total: 1, completed: 1 });
    expect(agentEntries(view.tree)[0]).not.toHaveProperty("pulse");
  });

  it.each([
    ["failed", "failure"],
    ["timed_out", "timed-out"],
  ] as const)("does not fold repeated %s attention", (status, attention) => {
    const run = repeatedAgentRun(2);
    run.dynamic!.progress = [];
    run.dynamic!.executionMetadata = [];
    for (const instance of run.dynamic!.nodeInstances) {
      instance.status = status;
      instance.error = { message: `Review ${status}.` };
    }

    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });
    const failures = agentEntries(view.tree).filter(entry => entry.attention?.kind === attention);

    expect(inspectionFolds(view.tree)).toEqual([]);
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map(entry => entry.subject.selector)).size).toBe(2);
    for (const failure of failures) expect(failure.subject.selector).toMatch(/^@[0-9a-f]{12}#1$/);
  });

  it("exposes only direct fork lineage and compact failure evidence", () => {
    const run = repeatedAgentRun(1);
    run.fork = { sourceRunId: "source-run", target: "review~private-key" };
    run.dynamic!.nodeInstances[0]!.status = "failed";
    run.dynamic!.nodeInstances[0]!.error = {
      upstream: { source: "acp", data: { secret: "never-expose" } },
    };

    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });
    const rendered = JSON.stringify(view);

    expect(view.run.fork).toEqual({ sourceRunId: "source-run" });
    expect(rendered).toContain("Target failed.");
    expect(rendered).not.toContain("review~private-key");
    expect(rendered).not.toContain("never-expose");
  });

  it("turns a blocking Signal into bounded, actionable attention", () => {
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
      `field_${index}`,
      { kind: "string" as const },
    ]));
    const outputSchema: SchemaIR = {
      kind: "object",
      fields,
      required: Object.keys(fields),
      additionalProperties: false,
    };
    const ir = signalWorkflow(outputSchema);
    const prompt = `${"Approve the detailed release checklist. ".repeat(12)}PROMPT_TAIL`;
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "awaiting";
    run.execution = { state: "inactive", lastStatus: "awaiting", reason: "runtime_authority_alive" };
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

    const view = projectInspectionRunView({ ir, run });
    const signal = inspectionItems(view.tree).find(entry => entry.subject.kind === "signal");

    expect(signal?.attention).toMatchObject({
      kind: "awaiting-input",
    });
    expect(signal?.attention?.kind === "awaiting-input" ? signal.attention.signal : undefined)
      .toMatch(/^@[0-9a-f]{12}$/);
    expect(signal?.attention?.summary.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(view)).not.toContain("PROMPT_TAIL");
    expect(JSON.stringify(view)).not.toContain("field_79");
  });

  it("projects repeated Signal aggregate counts and occurrence-exact Summary attention", () => {
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
    const paths = [0, 1].map(itemIndex => appendNode(appendFanoutItem([], "batch", itemIndex), "approve"));
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [],
      nodeInstances: ["a", "b"].map((suffix, itemIndex) => ({
        nodeKey: `approve~${suffix}`,
        nodeId: "approve",
        instancePath: paths[itemIndex]!,
        status: "running",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: ["a", "b"].map(suffix => ({
        nodeKey: `approve~${suffix}`,
        nodeId: "approve",
        status: "awaiting",
        renderedPrompt: `Approve ${suffix}?`,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
      executionMetadata: [],
      progress: [],
    };

    const aggregate = projectInspectionTargetSummaryView({
      run,
      details: targetDetails(ir, run, "approve"),
    });
    const secondSelector = deriveOccurrenceRef(paths[1]!);
    const exact = projectInspectionTargetSummaryView({
      run,
      details: targetDetails(ir, run, "approve~b"),
    });

    expect(aggregate).toMatchObject({
      subject: { label: "approve", kind: "signal", selector: "approve" },
      state: { status: "awaiting" },
      occurrences: { total: 2, awaiting: 2 },
      attention: { kind: "awaiting-input", signal: deriveOccurrenceRef(paths[0]!) },
    });
    expect(exact).toMatchObject({
      subject: { label: "approve", kind: "signal", selector: secondSelector },
      state: { status: "awaiting" },
      attention: { kind: "awaiting-input", signal: secondSelector, prompt: "Approve b?" },
    });
    expect(exact).not.toHaveProperty("occurrences");

    run.status = "failed";
    for (const instance of run.dynamic.nodeInstances) {
      instance.status = "failed";
      instance.statusReason = "signal_timeout";
      instance.error = { reason: "signal_timeout", message: "Approval timed out." };
    }
    for (const wait of run.dynamic.signalWaits) {
      wait.status = "timed_out";
      wait.terminalReason = "signal_timeout";
      wait.timeoutMessage = "Approval timed out.";
    }
    const timedOut = projectInspectionTargetSummaryView({
      run,
      details: targetDetails(ir, run, "approve"),
    });

    expect(timedOut).toMatchObject({
      state: { status: "timed_out" },
      occurrences: { total: 2, timedOut: 2 },
      attention: { kind: "timed-out" },
    });
  });

  it("reveals output only for a terminal run", () => {
    const run = repeatedAgentRun(0);
    run.output = { accepted: true };

    expect(projectInspectionRunView({ ir: compositeWorkflow(), run })).not.toHaveProperty("output");

    run.status = "completed";
    run.execution = { state: "terminal", lastStatus: "completed" };
    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });
    expect(view.output).toEqual({ accepted: true });
    expect(view.run.liveness).toBe("terminal");
  });

  it("projects a failed root frame as run-level failure without inventing a root tree item", () => {
    const run = repeatedAgentRun(0);
    run.status = "failed";
    run.execution = { state: "terminal", lastStatus: "failed" };
    run.dynamic!.frames = [{
      frameKey: "root",
      frameKind: "root",
      status: "failed",
      terminalReason: "scheduler_failed",
      error: { message: "Scheduler stopped." },
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }];

    const view = projectInspectionRunView({ ir: compositeWorkflow(), run });

    expect(view.run.failure).toEqual({
      origin: "scheduler",
      code: "scheduler_failed",
      message: "Scheduler stopped.",
    });
    expect(inspectionItems(view.tree).some(entry => entry.subject.label === "root")).toBe(false);
  });

  it.each([
    ["failed", "failure", "expression_failed"],
    ["timed_out", "timed-out", "attempt_timeout"],
  ] as const)("keeps deep %s scope attention visible beneath its failed ancestor", (status, attention, reason) => {
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
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.status = "failed";
    run.dynamic!.frames = [{
      frameKey: nodeKey,
      nodeKey,
      nodeId: "work",
      frameKind: "node",
      status,
      terminalReason: status === "failed" ? "branch_failed" : "attempt_timeout",
      error: { reason: status === "failed" ? "branch_failed" : "attempt_timeout", message: "Propagated scope failure." },
      instancePath: nodePath,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }, {
      frameKey: branchKey,
      nodeId: "work",
      parentFrameKey: nodeKey,
      frameKind: "branch",
      status,
      terminalReason: reason,
      error: { reason, message: "Root scope failure." },
      instancePath: branchPath,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }];

    const view = projectInspectionRunView({ ir, run });
    const owner = inspectionItems(view.tree).find(entry => entry.subject.kind === "parallel");
    const branch = owner?.children.find((entry): entry is Extract<InspectionTreeEntry, { type: "item" }> =>
      entry.type === "item" && entry.subject.kind === "branch");

    expect(owner?.attention?.kind).toBe(attention);
    expect(branch).toMatchObject({
      subject: { label: "left", kind: "branch", selector: deriveOccurrenceRef(branchPath) },
      attention: { kind: attention, summary: "Root scope failure." },
    });
  });

  it("keeps nested Fanout topology complete before folding its homogeneous repeated leaves", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "nested-fanout",
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
                nodes: [{
                  id: "review",
                  kind: "agent",
                  run: { agent: "reviewer", prompt: { kind: "literal", value: "Review" } },
                }],
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

    const view = projectInspectionRunView({ ir, run });

    expect(view.counts).toEqual({ total: 25, ready: 25 });
    expect(inspectionItems(view.tree).map(entry => entry.subject.kind)).toEqual(expect.arrayContaining([
      "fanout",
      "fanout_item",
    ]));
    expect(inspectionFolds(view.tree)).toContainEqual(expect.objectContaining({
      scope: "fanout-items",
      range: { start: 0, end: 24 },
      count: 25,
      state: { status: "ready" },
    }));
    expect(view).not.toHaveProperty("omitted");
  });

  it("retains every active leaf and counts every repeated Assert execution", () => {
    const activeRun = repeatedAgentRun(26);
    for (const [index, instance] of activeRun.dynamic!.nodeInstances.entries()) {
      if (index >= 20) instance.status = index % 2 === 0 ? "running" : "starting";
    }
    const active = projectInspectionRunView({ ir: compositeWorkflow(), run: activeRun });

    expect(active.counts).toEqual({ total: 26, ready: 20, starting: 3, running: 3 });
    expect(agentEntries(active.tree)
      .filter(entry => entry.state.status === "starting" || entry.state.status === "running"))
      .toHaveLength(6);

    const assertIr: WorkflowIR = {
      irVersion: 7,
      name: "repeated-assert",
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
            nodes: [{ id: "check", kind: "assert", condition: { kind: "literal", value: true } }],
          },
        }],
      },
      diagnostics: [],
    };
    const assertRun = repeatedAgentRun(0);
    assertRun.name = assertIr.name;
    assertRun.status = "completed";
    assertRun.execution = { state: "terminal", lastStatus: "completed" };
    assertRun.dynamic!.frames = Array.from({ length: 20 }, (_, itemIndex) => {
      const path = appendNode(appendFanoutItem([], "batch", itemIndex), "check");
      return {
        frameKey: deriveInstanceKey(path),
        nodeKey: deriveInstanceKey(path),
        nodeId: "check",
        frameKind: "node",
        status: "completed",
        terminalReason: "assert_passed",
        instancePath: path,
        createdAt: "2026-07-01T00:00:01.000Z",
        updatedAt: "2026-07-01T00:00:02.000Z",
      };
    });

    const assertions = projectInspectionRunView({ ir: assertIr, run: assertRun });
    expect(assertions.counts).toEqual({ total: 20, completed: 20 });
    expect(inspectionFolds(assertions.tree)).toContainEqual(expect.objectContaining({
      scope: "fanout-items",
      count: 20,
      state: { status: "completed" },
    }));
  });

  it("preserves scheduler, provider, runtime, and Task failure origins in visible state", () => {
    const cases: Array<{
      origin: "scheduler" | "provider" | "runtime";
      reason?: string;
      expectedCode: string;
      error: { origin?: "runtime"; code?: string; reason?: string; message: string };
    }> = [
      {
        origin: "scheduler",
        reason: "expression_resolution_failed",
        expectedCode: "expression_resolution_failed",
        error: { reason: "expression_resolution_failed", message: "Prompt resolution failed." },
      },
      {
        origin: "provider",
        expectedCode: "invalid_api_key",
        error: { code: "invalid_api_key", message: "Provider rejected the API key." },
      },
      {
        origin: "runtime",
        expectedCode: "invalid_agent_response_repair_max",
        error: { origin: "runtime", code: "invalid_agent_response_repair_max", message: "Invalid runtime configuration." },
      },
    ];
    for (const failure of cases) {
      const run = repeatedAgentRun(1);
      run.dynamic!.nodeInstances[0]!.status = "failed";
      if (failure.reason) run.dynamic!.nodeInstances[0]!.statusReason = failure.reason;
      run.dynamic!.nodeInstances[0]!.error = failure.error;
      const state = agentEntries(projectInspectionRunView({ ir: compositeWorkflow(), run }).tree)[0]?.state;
      expect(state?.failure?.origin).toBe(failure.origin);
      expect(state?.failure?.code).toBe(failure.expectedCode);
    }

    const taskIr = taskWorkflow();
    const taskRun = repeatedAgentRun(1);
    taskRun.name = taskIr.name;
    taskRun.dynamic!.nodeInstances[0] = {
      ...taskRun.dynamic!.nodeInstances[0]!,
      nodeKey: "work~0",
      nodeId: "work",
      instancePath: appendNode([], "work"),
      status: "failed",
      error: { code: "invalid_output", message: "Task returned invalid output." },
    };
    taskRun.dynamic!.attempts[0] = {
      ...taskRun.dynamic!.attempts[0]!,
      nodeKey: "work~0",
      nodeId: "work",
      status: "failed",
    };
    const task = inspectionItems(projectInspectionRunView({ ir: taskIr, run: taskRun }).tree)
      .find(entry => entry.subject.kind === "task");
    expect(task?.state.failure).toEqual({
      origin: "task",
      code: "invalid_output",
      message: "Task returned invalid output.",
    });
  });

  it("keeps opposite conditional selections and an empty branch local to each repeated occurrence", () => {
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
                nodes: [{ id: "fallback", ...taskNode() }],
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
    const frame = (
      path: ReturnType<typeof appendNode> | ReturnType<typeof appendBranch> | ReturnType<typeof appendFanoutItem>,
      frameKind: "node" | "branch" | "fanout_item",
      nodeId: string,
      parentFrameKey?: string,
    ) => ({
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
    run.execution = { state: "terminal", lastStatus: "completed" };
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
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      }],
      attempts: [],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };

    const view = projectInspectionRunView({ ir, run });
    const entries = inspectionItems(view.tree);

    expect(view.counts).toEqual({ total: 1, completed: 1 });
    expect(inspectionFolds(view.tree)).toEqual([]);
    expect(entries.map(entry => `${entry.subject.kind}:${entry.subject.label}`)).toEqual([
      "fanout:batch",
      "fanout_item:item[0]",
      "if:route",
      "fanout_item:item[1]",
      "task:fallback",
    ]);
    expect(entries.filter(entry => entry.subject.label === "fallback")).toHaveLength(1);
    expect(JSON.stringify(view.tree)).not.toContain("not_selected");
    expect(entries.some(entry => entry.subject.kind === "branch")).toBe(false);

    const expanded = inspectionItems(projectInspectionRunView({
      ir,
      run,
      structure: "materialized",
    }).tree);
    expect(expanded.map(entry => `${entry.subject.kind}:${entry.subject.label}`)).toEqual([
      "fanout:batch",
      "fanout_item:item[0]",
      "if:route",
      "fanout_item:item[1]",
      "if:route",
      "branch:else",
      "task:fallback",
    ]);
  });

  it("keeps failed Switch cases unmaterialized and orders only persisted Loop rounds", () => {
    const routeIr: WorkflowIR = {
      irVersion: 7,
      name: "failed-switch",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "route",
          kind: "switch",
          cases: [
            { when: { kind: "literal", value: "first" }, then: { output: { kind: "object", fields: {} }, nodes: [{ id: "first_case", ...taskNode() }] } },
            { when: { kind: "literal", value: "second" }, then: { output: { kind: "object", fields: {} }, nodes: [{ id: "second_case", ...taskNode() }] } },
          ],
          default: { output: { kind: "object", fields: {} }, nodes: [{ id: "default_case", ...taskNode() }] },
        }],
      },
      diagnostics: [],
    };
    const routePath = appendNode([], "route");
    const routeRun = repeatedAgentRun(0);
    routeRun.name = routeIr.name;
    routeRun.status = "failed";
    routeRun.dynamic!.frames = [{
      frameKey: deriveInstanceKey(routePath),
      nodeKey: deriveInstanceKey(routePath),
      nodeId: "route",
      frameKind: "node",
      status: "failed",
      terminalReason: "expression_failed",
      error: { reason: "expression_failed", message: "Switch expression failed." },
      instancePath: routePath,
      createdAt: routeRun.createdAt,
      updatedAt: routeRun.updatedAt,
    }];
    const route = projectInspectionRunView({ ir: routeIr, run: routeRun });
    expect(inspectionItems(route.tree).find(entry => entry.subject.kind === "switch")?.attention)
      .toEqual({ kind: "failure", summary: "Switch expression failed." });
    expect(JSON.stringify(route.tree)).not.toMatch(/first_case|second_case|default_case/);

    const loopIr: WorkflowIR = {
      irVersion: 7,
      name: "persisted-loop-rounds",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "repeat",
          kind: "loop",
          state: { kind: "object", fields: {} },
          do: {
            output: { kind: "object", fields: { state: { kind: "object", fields: {} }, stop: { kind: "literal", value: true } } },
            nodes: [],
          },
        }],
      },
      diagnostics: [],
    };
    const loopPath = appendNode([], "repeat");
    const round0 = appendLoopIteration([], "repeat", 0);
    const round2 = appendLoopIteration([], "repeat", 2);
    const loopRun = repeatedAgentRun(0);
    loopRun.name = loopIr.name;
    loopRun.dynamic!.frames = [
      { frameKey: deriveInstanceKey(round2), nodeId: "repeat", frameKind: "loop_iteration", status: "completed", instancePath: round2, createdAt: loopRun.createdAt, updatedAt: loopRun.updatedAt },
      { frameKey: deriveInstanceKey(loopPath), nodeKey: deriveInstanceKey(loopPath), nodeId: "repeat", frameKind: "loop", status: "completed", instancePath: loopPath, createdAt: loopRun.createdAt, updatedAt: loopRun.updatedAt },
      { frameKey: deriveInstanceKey(round0), nodeId: "repeat", frameKind: "loop_iteration", status: "completed", instancePath: round0, createdAt: loopRun.createdAt, updatedAt: loopRun.updatedAt },
    ];

    const loop = projectInspectionRunView({ ir: loopIr, run: loopRun });
    expect(inspectionItems(loop.tree)
      .filter(entry => entry.subject.kind === "loop_iteration")
      .map(entry => entry.subject.label))
      .toEqual(["round 1", "round 3"]);
  });

  it("selects progress from each repeated composite group instance", () => {
    const ir: WorkflowIR = {
      irVersion: 7,
      name: "repeated-composite",
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
              id: "work",
              kind: "parallel",
              strategy: "all",
              branches: {
                left: { output: { kind: "object", fields: {} }, nodes: [] },
                right: { output: { kind: "object", fields: {} }, nodes: [] },
              },
            }],
          },
        }],
      },
      diagnostics: [],
    };
    const itemPaths = [0, 1].map(index => appendFanoutItem([], "batch", index));
    const workPaths = itemPaths.map(path => appendNode(path, "work"));
    const [firstItemKey, secondItemKey] = itemPaths.map(deriveInstanceKey);
    const [firstWorkKey, secondWorkKey] = workPaths.map(deriveInstanceKey);
    const run = repeatedAgentRun(0);
    run.name = ir.name;
    run.dynamic = {
      version: 4,
      progressVersion: 0,
      frames: [
        { frameKey: firstItemKey!, nodeId: "batch", frameKind: "fanout_item", status: "completed", instancePath: itemPaths[0]!, createdAt: run.createdAt, updatedAt: run.updatedAt },
        { frameKey: secondItemKey!, nodeId: "batch", frameKind: "fanout_item", status: "running", instancePath: itemPaths[1]!, createdAt: run.createdAt, updatedAt: run.updatedAt },
        { frameKey: firstWorkKey!, nodeKey: firstWorkKey!, nodeId: "work", parentFrameKey: firstItemKey!, frameKind: "node", status: "completed", instancePath: workPaths[0]!, createdAt: run.createdAt, updatedAt: run.updatedAt },
        { frameKey: secondWorkKey!, nodeKey: secondWorkKey!, nodeId: "work", parentFrameKey: secondItemKey!, frameKind: "node", status: "running", instancePath: workPaths[1]!, createdAt: run.createdAt, updatedAt: run.updatedAt },
      ],
      nodeInstances: [],
      attempts: [],
      groups: [
        { groupKey: firstWorkKey!, nodeKey: firstWorkKey!, nodeId: "work", kind: "parallel", strategy: "all", status: "completed", maxConcurrency: 1 },
        { groupKey: secondWorkKey!, nodeKey: secondWorkKey!, nodeId: "work", kind: "parallel", strategy: "all", status: "running", maxConcurrency: 2 },
      ],
      groupMembers: [
        { groupKey: firstWorkKey!, memberKey: `${firstWorkKey}:left`, memberKind: "branch", branchId: "left", status: "completed", createdAt: run.createdAt, updatedAt: run.updatedAt },
        { groupKey: firstWorkKey!, memberKey: `${firstWorkKey}:right`, memberKind: "branch", branchId: "right", status: "completed", createdAt: run.createdAt, updatedAt: run.updatedAt },
        { groupKey: secondWorkKey!, memberKey: `${secondWorkKey}:left`, memberKind: "branch", branchId: "left", status: "ready", createdAt: run.createdAt, updatedAt: run.updatedAt },
        { groupKey: secondWorkKey!, memberKey: `${secondWorkKey}:right`, memberKind: "branch", branchId: "right", status: "running", createdAt: run.createdAt, updatedAt: run.updatedAt },
      ],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
    };

    const view = projectInspectionRunView({ ir, run });
    expect(inspectionItems(view.tree)
      .filter(entry => entry.subject.kind === "parallel")
      .map(entry => entry.progress))
      .toEqual([{ completed: 2, total: 2 }, { completed: 0, total: 2 }]);
  });

  it("emits one final observation change when a static placeholder materializes on retry", () => {
    const ir = taskWorkflow();
    const path = appendNode([], "work");
    const nodeKey = deriveInstanceKey(path);
    const beforeRun = repeatedAgentRun(0);
    beforeRun.name = ir.name;
    const afterRun = repeatedAgentRun(0);
    afterRun.name = ir.name;
    afterRun.dynamic!.nodeInstances = [{
      nodeKey,
      nodeId: "work",
      instancePath: path,
      status: "running",
      createdAt: "2026-07-01T00:00:01.000Z",
      updatedAt: "2026-07-01T00:00:03.000Z",
    }];
    afterRun.dynamic!.attempts = [{
      attemptId: "attempt-2",
      nodeKey,
      nodeId: "work",
      attemptNo: 2,
      status: "started",
      startedAt: "2026-07-01T00:00:03.000Z",
    }];
    const before = projectInspectionRunDecisionView({ ir, run: beforeRun });
    const after = projectInspectionRunDecisionView({ ir, run: afterRun });

    expect(inspectionChanges(before, after, [], afterRun)).toEqual([{
      subject: expect.objectContaining({ label: "work", kind: "task" }),
      state: { status: "running" },
    }]);
  });
});

function targetDetails(ir: WorkflowIR, run: RunDetails, target: string) {
  const details = resolveTargetState({ ir, run, artifacts: [], target });
  if (!details) throw new Error(`Expected target '${target}' to resolve.`);
  return details;
}

function taskNode() {
  return {
    kind: "task" as const,
    run: {
      input: { kind: "literal" as const, value: null },
      target: { kind: "inline" as const, source: "async function task() {}" },
    },
  };
}

function taskWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "inspection-task",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{ id: "work", ...taskNode() }],
    },
    diagnostics: [],
  };
}

function compositeWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "inspection-composite",
    agents: { reviewer: { kind: "agent_definition", use: "claude", model: "sonnet" } },
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

function singleAgentWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "inspection-agent",
    agents: { reviewer: { kind: "agent_definition", use: "claude", model: "sonnet" } },
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "review",
        kind: "agent",
        run: { agent: "reviewer", prompt: { kind: "literal", value: "Review this" } },
      }],
    },
    diagnostics: [],
  };
}

function signalWorkflow(outputSchema: SchemaIR): WorkflowIR {
  return {
    irVersion: 7,
    name: "signal-inspection",
    agents: {},
    root: {
      output: { kind: "object", fields: {} },
      nodes: [{
        id: "approve",
        kind: "signal",
        run: { prompt: { kind: "literal", value: "authored prompt" } },
        outputSchema,
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
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 30,
          thoughtTokens: 5,
          totalTokens: 120,
        },
        tools: {
          turn: 4,
          totalToolCallCount: 1,
          lastCalls: [{
            toolName: "Read",
            status: "completed",
            inputPreview: "{\"path\":\"/private/repository\"}",
          }],
        },
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
    },
  };
}

function runAgentObservations(
  current: Omit<AgentObservationInspectionProjection["currents"][number],
    "attemptId" | "turn" | "promptKind" | "updatedAt" | "state" | "completeness">,
): AgentObservationInspectionProjection {
  return {
    version: 1,
    turns: [{
      runId: "run-inspection",
      attemptId: "attempt-0",
      nodeKey: "review~0",
      nodeId: "review",
      attemptNo: 1,
      turn: 1,
      promptKind: "task",
      state: "recording",
      completeness: "complete",
      gapCount: 0,
      eventCount: 1,
      unknownEventCount: 0,
      startedAt: "2026-07-01T00:00:01.000Z",
    }],
    currents: [{
      attemptId: "attempt-0",
      turn: 1,
      promptKind: "task",
      updatedAt: "2026-07-01T00:00:02.000Z",
      state: "recording",
      completeness: "complete",
      ...current,
    }],
    entries: [],
    retentionOmittedBefore: 0,
    olderEntryCount: 0,
    hasOlderEntries: false,
  };
}

function inspectionFolds(entries: readonly InspectionTreeEntry[]): Array<Extract<InspectionTreeEntry, { type: "fold" }>> {
  return entries.flatMap(entry => entry.type === "fold"
    ? [entry, ...inspectionFolds(entry.children)]
    : inspectionFolds(entry.children));
}

function inspectionItems(entries: readonly InspectionTreeEntry[]): Array<Extract<InspectionTreeEntry, { type: "item" }>> {
  return entries.flatMap(entry => entry.type === "item"
    ? [entry, ...inspectionItems(entry.children)]
    : inspectionItems(entry.children));
}

function agentEntries(entries: readonly InspectionTreeEntry[]): Array<Extract<InspectionTreeEntry, { type: "item" }>> {
  return inspectionItems(entries).filter(entry => entry.subject.kind === "agent");
}
