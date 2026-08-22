import { describe, expect, it } from "vitest";
import { projectAgentExecution } from "../src/inspection/agent-execution-projection.js";
import {
  inspectionExcerpt,
  projectInspectionTargetSummaryView,
  projectInspectionTargetTimelineView,
} from "../src/inspection/decision-projection.js";
import type { ResolvedTargetState } from "../src/inspection/resolved-target.js";
import type {
  AgentObservationInspectionProjection,
  AgentObservationTurn,
} from "../src/observations/log.js";
import type { RunDetails } from "../src/store/store.js";
import type { CommittedRuntimeEventRow } from "../src/store/committed-event.js";

describe("inspection target projections", () => {
  it("keeps ordinary target summaries free of private journal details", () => {
    const document = projectInspectionTargetSummaryView({
      run: agentRun(),
      details: agentDetails(),
      observations: observations([turn(1, { state: "settled", providerStatus: "completed" })]),
    });

    expect(document).toMatchObject({
      kind: "target",
      detail: "summary",
      subject: { selector: "@1a2b3c4d5e6f#1" },
    });
    expect(document).not.toHaveProperty("journal");
    expect(document).not.toHaveProperty("availableActions");
  });

  it("omits current activity between a completed tool and the next semantic segment", () => {
    const projection = observations(
      [turn(1)],
      [{
        id: "tool-activity",
        observationVersion: 1,
        attemptId: "attempt-1",
        turn: 1,
        sourceSequence: 2,
        at: "2026-07-25T00:00:02.000Z",
        kind: "activity",
        channel: "tool",
        summary: inspectionExcerpt("Bash completed", 512, "tail"),
        tool: {
          toolCallId: "tool-1",
          name: "Bash",
          status: "completed",
          updatedAt: "2026-07-25T00:00:02.000Z",
          finishedAt: "2026-07-25T00:00:02.000Z",
        },
      }],
      [{
        attemptId: "attempt-1",
        turn: 1,
        promptKind: "task",
        phase: "between",
        updatedAt: "2026-07-25T00:00:02.000Z",
        tools: {
          active: [],
          recent: {
            toolCallId: "tool-1",
            name: "Bash",
            status: "completed",
            updatedAt: "2026-07-25T00:00:02.000Z",
            finishedAt: "2026-07-25T00:00:02.000Z",
          },
          omittedActive: 0,
        },
        state: "recording",
        completeness: "complete",
      }],
    );
    const details = agentDetails();
    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details, observations: projection });
    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events: [],
      observations: projection,
    });

    expect(summary).not.toHaveProperty("pulse");
    expect(timeline).not.toHaveProperty("current");
    expect(timeline.recent).toEqual([
      expect.objectContaining({ kind: "activity", channel: "tool", summary: "Bash" }),
    ]);
  });

  it("keeps true initial activity as starting without a redundant headline", () => {
    const document = projectInspectionTargetSummaryView({
      run: agentRun(),
      details: agentDetails(),
      observations: observations([turn(1)], [], [{
        attemptId: "attempt-1",
        turn: 1,
        promptKind: "task",
        phase: "starting",
        updatedAt: "2026-07-25T00:00:01.000Z",
        state: "recording",
        completeness: "complete",
      }]),
    });

    expect(document.pulse).toEqual({
      phase: "starting",
      turn: 1,
    });
  });

  it("keeps terminal Agent history in Timeline and reports no Summary pulse", () => {
    const details = agentDetails();
    details.summary.nodeStatus = "cancelled";
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      finishedAt: "2026-07-25T00:00:02.000Z",
    };
    const projection = observations([turn(1)], [], [{
      attemptId: "attempt-1",
      turn: 1,
      promptKind: "task",
      phase: "tool",
      updatedAt: "2026-07-25T00:00:03.000Z",
      tools: {
        active: [{ name: "Bash", status: "running", updatedAt: "2026-07-25T00:00:03.000Z" }],
        omittedActive: 0,
      },
      state: "recording",
      completeness: "complete",
    }]);

    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details, observations: projection });
    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events: [],
      observations: projection,
    });

    expect(summary).not.toHaveProperty("pulse");
    expect(summary.result).toEqual({ status: "not_accepted" });
    expect(timeline.current).toEqual({ kind: "agent", phase: "settled", turn: 1 });
  });

  it.each(["agent", "task", "signal"] as const)("reports accepted %s output without a terminal pulse", kind => {
    const details = completedLeafDetails(kind, { complete: true });
    const summary = projectInspectionTargetSummaryView({
      run: agentRun(),
      details,
      ...(kind === "agent" ? { observations: observations([turn(1, { state: "settled" })]) } : {}),
    });

    expect(summary.result).toEqual({ status: "accepted", value: { complete: true } });
    expect(summary).not.toHaveProperty("pulse");
  });

  it("distinguishes outputless completion from accepted JSON null", () => {
    expect(projectInspectionTargetSummaryView({
      run: agentRun(),
      details: completedLeafDetails("task", undefined),
    }).result).toEqual({ status: "completed_without_output" });
    expect(projectInspectionTargetSummaryView({
      run: agentRun(),
      details: completedLeafDetails("task", null),
    }).result).toEqual({ status: "accepted", value: null });
  });

  it("uses the completed run output for the root target", () => {
    const run = { ...agentRun(), status: "completed" as const, output: { root: true } };
    const details = completedFrameDetails("parallel", { frame: "must not win" });
    details.target = { kind: "frame", id: "root" };
    delete details.staticNode;
    details.summary.targetId = "root";
    details.frames[0] = { ...details.frames[0]!, frameKey: "root", frameKind: "root" };

    expect(projectInspectionTargetSummaryView({ run, details }).result)
      .toEqual({ status: "accepted", value: { root: true } });
  });

  it.each(["if", "switch", "parallel", "fanout", "loop", "assert"] as const)("reports accepted %s frame output", kind => {
    const details = completedFrameDetails(kind, { branch: kind });
    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details });

    expect(summary.result).toEqual({ status: "accepted", value: { branch: kind } });
    expect(summary).not.toHaveProperty("pulse");
  });

  it.each(["failed", "timed_out", "cancelled"] as const)("does not invent a result or pulse for %s targets", status => {
    const details = agentDetails();
    details.summary.nodeStatus = status;
    details.attempts[0] = { ...details.attempts[0]!, status, result: { candidate: true } };
    const summary = projectInspectionTargetSummaryView({
      run: agentRun(),
      details,
      observations: observations([turn(1, { state: "settled" })]),
    });

    expect(summary).not.toHaveProperty("result");
    expect(summary).not.toHaveProperty("pulse");
  });

  it("marks a completed historical attempt not accepted without leaking its candidate result", () => {
    const details = completedLeafDetails("agent", { accepted: true });
    details.target = { kind: "attempt", id: "attempt-1", ref: "@1a2b3c4d5e6f" };
    details.summary.targetKind = "attempt";
    details.summary.targetId = "attempt-1";
    details.instances[0]!.acceptedAttemptId = "attempt-2";
    details.attempts[0]!.result = { candidate: "must not leak" };
    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details });

    expect(summary.result).toEqual({ status: "not_accepted" });
    expect(JSON.stringify(summary)).not.toContain("must not leak");
  });

  it("labels a missing steered-attempt observation boundary without hiding it", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      cancelReason: "operator_steered",
      finishedAt: "2026-07-25T00:00:03.000Z",
    };
    details.summary.nodeStatus = "cancelled";
    const projection = observations([]);

    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details, observations: projection });
    expect(summary.visibility).toEqual({ state: "degraded", reason: "observation-gap" });
  });

  it("projects one bounded timeline view without private journal metadata", () => {
    const details = agentDetails();
    const projection = observations([], Array.from({ length: 13 }, (_, index) => {
      const turn = index + 1;
      return activity(
        turn,
        `entry-${turn}`,
        "response",
        `2026-07-25T00:00:${String(turn).padStart(2, "0")}.000Z`,
      );
    }));

    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events: [],
      observations: projection,
    });

    expect(timeline.kind).toBe("target");
    expect(timeline.detail).toBe("timeline");
    expect(timeline.recent.map(entry => entry.kind === "activity" ? entry.summary : undefined))
      .toEqual(Array.from({ length: 12 }, (_, index) => `entry-${index + 2}`));
    expect(timeline).not.toHaveProperty("evidence");
    expect(timeline).not.toHaveProperty("page");
  });

  it("marks an omitted activity prefix while preserving the retained tail", () => {
    const retainedTail = `${"z".repeat(235)}-END`;
    const source = `${"discarded-prefix-".repeat(40)}${retainedTail}`;
    const expected = `…${retainedTail}`;
    const excerpt = inspectionExcerpt(source, 512, "tail");
    const projection = observations(
      [turn(1)],
      [
        activity(1, source, "reported-thought"),
        activity(1, "report.ger", "response", "2026-07-25T00:00:02.000Z"),
      ],
      [{
        attemptId: "attempt-1",
        turn: 1,
        promptKind: "task",
        phase: "thinking",
        updatedAt: "2026-07-25T00:00:01.000Z",
        intent: { kind: "reported-thought", excerpt },
        state: "recording",
        completeness: "complete",
      }],
    );
    const details = agentDetails();

    const summary = projectInspectionTargetSummaryView({ run: agentRun(), details, observations: projection });
    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events: [],
      observations: projection,
    });

    expect(summary.pulse?.headline).toBe(expected);
    expect(timeline.current).toMatchObject({ kind: "agent", headline: expected });
    expect(timeline.recent).toEqual([
      expect.objectContaining({ kind: "activity", summary: expected }),
      expect.objectContaining({ kind: "activity", summary: "report.ger" }),
    ]);
    expect(Array.from(expected)).toHaveLength(240);
  });

  it("orders visible scheduler transitions and redacts steer bookkeeping in the final Timeline", () => {
    const details = agentDetails();
    details.target = { kind: "dynamic-node", id: "agent~1", ref: "@1a2b3c4d5e6f" };
    details.summary.targetKind = "dynamic-node";
    details.summary.targetId = "agent~1";
    const events: CommittedRuntimeEventRow[] = [{
      runId: "run-1",
      sequence: 1,
      type: "instance.started",
      nodeKey: "agent~1",
      payload: { nodeKey: "agent~1", nodeId: "agent" },
      createdAt: "2026-07-25T00:00:01.000Z",
      idempotencyKey: "instance-started",
    }, {
      runId: "run-1",
      sequence: 2,
      type: "control.agent_steer_requested",
      nodeKey: "agent~1",
      payload: {
        steerId: "cli:secret-steer-id",
        requestedTarget: "agent",
        nodeKey: "agent~1",
        nodeId: "agent",
        fencedAttemptId: "attempt-1",
        instruction: "SECRET correction",
      },
      createdAt: "2026-07-25T00:00:02.000Z",
      idempotencyKey: "steer-requested",
    }, {
      runId: "run-1",
      sequence: 3,
      type: "attempt.superseded",
      nodeKey: "agent~1",
      payload: {
        nodeKey: "agent~1",
        nodeId: "agent",
        attemptId: "attempt-1",
        cancelReason: "operator_steered",
      },
      createdAt: "2026-07-25T00:00:03.000Z",
      idempotencyKey: "attempt-superseded",
    }, {
      runId: "run-1",
      sequence: 4,
      type: "instance.requeued",
      nodeKey: "agent~1",
      payload: {
        nodeKey: "agent~1",
        nodeId: "agent",
        reason: "steered",
        steerId: "cli:secret-steer-id",
      },
      createdAt: "2026-07-25T00:00:04.000Z",
      idempotencyKey: "instance-requeued",
    }, {
      runId: "run-1",
      sequence: 5,
      type: "instance.completed",
      nodeKey: "agent~1",
      payload: { nodeKey: "agent~1", nodeId: "agent" },
      createdAt: "2026-07-25T00:00:05.000Z",
      idempotencyKey: "instance-completed",
    }];

    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events,
      observations: observations([]),
    });

    expect(timeline.recent).toEqual([
      expect.objectContaining({ kind: "transition", action: "started", status: "running" }),
      expect.objectContaining({ kind: "control", action: "steered", attempt: 1 }),
      expect.objectContaining({ kind: "transition", action: "completed", status: "completed" }),
    ]);
    expect(JSON.stringify(timeline)).not.toContain("SECRET correction");
    expect(JSON.stringify(timeline)).not.toContain("secret-steer-id");
  });

  it("projects Agent execution from retained Observations, not progress or execution metadata", () => {
    const details = agentDetails();
    details.progress = [{
      ...agentRun().dynamic!.progress[0]!,
      output: { tail: "invented progress output", totalBytes: 24, truncated: false },
      context: { used: 999, size: 1_000 },
      tools: { totalToolCallCount: 99, lastCalls: [{ toolName: "Shell parser bait", updatedAt: "2026-07-25T00:00:09.000Z" }] },
    }];
    details.executionMetadata = [{
      id: 1,
      attemptId: "attempt-1",
      kind: "agent_attempt",
      metadata: { output: "invented metadata output", tokenUsage: 1_000_000 },
      createdAt: "2026-07-25T00:00:09.000Z",
    }];
    const document = projectAgentExecution({
      details,
      observations: observations(
        [turn(1, { state: "recording" })],
        [],
        [{
          attemptId: "attempt-1",
          turn: 1,
          promptKind: "task",
          phase: "tool",
          updatedAt: "2026-07-25T00:00:02.000Z",
          response: inspectionExcerpt("observed response", 1_536, "tail"),
          tools: {
            active: [{
              toolCallId: "tool-1",
              name: "Bash",
              status: "running",
              input: inspectionExcerpt('{"cmd":"sudo env A=1 rg needle"}', 2_048, "head"),
              updatedAt: "2026-07-25T00:00:02.000Z",
            }],
            omittedActive: 0,
          },
          state: "recording",
          completeness: "complete",
        }],
      ),
    });

    expect(document).toMatchObject({
      available: true,
      output: { tail: "observed response", totalBytes: 17, truncated: false },
      recentTools: [{
        turn: 1,
        toolCallId: "tool-1",
        toolName: "Bash",
        status: "running",
        inputPreview: '{"cmd":"sudo env A=1 rg needle"}',
      }],
    });
    expect(JSON.stringify(document)).not.toContain("invented progress output");
    expect(JSON.stringify(document)).not.toContain("invented metadata output");
    expect(document).not.toHaveProperty("toolCallCount");
    expect(document).not.toHaveProperty("lastToolCalls");
    expect(document).not.toHaveProperty("recentToolsIncomplete");
    expect(document).not.toHaveProperty("summary.tokenUsage");
  });

  it("keeps bounded Observation context, token usage, and terminal output in Agent execution", () => {
    const document = projectAgentExecution({
      details: agentDetails(),
      observations: observations(
        [turn(1, { state: "settled", finishedAt: "2026-07-25T00:00:03.000Z" })],
        [],
        [{
          attemptId: "attempt-1",
          turn: 1,
          promptKind: "task",
          phase: "settled",
          updatedAt: "2026-07-25T00:00:03.000Z",
          response: inspectionExcerpt("terminal observed response", 1_536, "tail"),
          context: { used: 80, size: 100, updatedAt: "2026-07-25T00:00:03.000Z" },
          tokenUsage: { source: "usage_update", inputTokens: 70, outputTokens: 10, totalTokens: 80 },
          state: "settled",
          completeness: "complete",
        }],
      ),
    });

    expect(document).toMatchObject({
      available: true,
      contextWindow: { used: 80, size: 100, percent: 80, updatedAt: "2026-07-25T00:00:03.000Z" },
      tokenUsage: { source: "usage_update", inputTokens: 70, outputTokens: 10, totalTokens: 80 },
      output: { tail: "terminal observed response", totalBytes: 26, truncated: false },
    });
  });

  it("keeps post-fence tool observations out of Agent execution", () => {
    const document = projectAgentExecution({
      details: agentDetails(),
      observations: observations(
        [turn(1, { state: "settled", fencedAt: "2026-07-25T00:00:03.000Z", finishedAt: "2026-07-25T00:00:09.000Z" })],
        [],
        [{
          attemptId: "attempt-1",
          turn: 2,
          promptKind: "task",
          phase: "tool",
          updatedAt: "2026-07-25T00:00:09.000Z",
          postFence: true,
          tools: {
            active: [{ name: "Bash", updatedAt: "2026-07-25T00:00:09.000Z" }],
            omittedActive: 0,
          },
          state: "settled",
          completeness: "complete",
        }],
      ),
    });

    expect(document.recentTools).toEqual([]);
    expect(document.lastObservedAt).toBe("2026-07-25T00:00:03.000Z");
  });
});

function agentRun(): RunDetails {
  return {
    id: "run-1",
    name: "inspection",
    status: "running",
    workflowEntry: "inspection.workflow.ts",
    sourceGraphDigest: "source-digest",
    progressVersion: 2,
    input: {},
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:01.000Z",
    eventCount: 4,
    nodeCount: 1,
    hooks: [],
    execution: { state: "active", lastStatus: "running" },
    dynamic: {
      version: 4,
      progressVersion: 2,
      frames: [],
      nodeInstances: [{
        nodeKey: "agent~1",
        nodeId: "agent",
        status: "started",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
      attempts: [{
        attemptId: "attempt-1",
        nodeKey: "agent~1",
        nodeId: "agent",
        attemptNo: 1,
        status: "started",
        startedAt: "2026-07-25T00:00:00.000Z",
      }],
      groups: [],
      groupMembers: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [{
        nodeKey: "agent~1",
        nodeId: "agent",
        attemptId: "attempt-1",
        attemptNo: 1,
        kind: "agent",
        status: "running",
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
    },
  };
}

function agentDetails(): ResolvedTargetState {
  const run = agentRun();
  return {
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      workflowEntry: run.workflowEntry,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      execution: run.execution,
    },
    target: { kind: "attempt", id: "attempt-1", ref: "@1a2b3c4d5e6f" },
    staticNode: {
      nodeId: "agent",
      kind: "agent",
      order: 0,
      path: ["agent"],
      prompt: { kind: "literal", value: "secret prompt" },
      agent: "reviewer",
    },
    summary: {
      targetKind: "attempt",
      targetId: "attempt-1",
      runStatus: "running",
      runStartedAt: run.createdAt,
      nodeId: "agent",
      nodeKey: "agent~1",
      nodeStatus: "started",
      staticKind: "agent",
      staticOrder: 0,
      latestAttempt: {
        attemptId: "attempt-1",
        attemptNo: 1,
        status: "started",
        startedAt: run.createdAt,
      },
      artifacts: [],
    },
    items: [{
      key: "instance:agent~1",
      role: "instance",
      path: ["agent"],
      label: "agent",
      kind: "agent",
      status: "running",
      nodeId: "agent",
      nodeKey: "agent~1",
      attemptId: "attempt-1",
      attemptNo: 1,
    }],
    instances: [...run.dynamic!.nodeInstances],
    frames: [],
    attempts: [...run.dynamic!.attempts],
    signalWaits: [],
    executionMetadata: [],
    progress: [...run.dynamic!.progress],
    artifacts: [],
    availableControls: [],
  };
}

function observations(
  turns: AgentObservationTurn[],
  entries: AgentObservationInspectionProjection["entries"] = [],
  currents: AgentObservationInspectionProjection["currents"] = [],
): AgentObservationInspectionProjection {
  return {
    version: 1,
    turns,
    entries,
    currents,
    retentionOmittedBefore: 0,
    olderEntryCount: 0,
    hasOlderEntries: false,
  };
}

function completedLeafDetails(kind: "agent" | "task" | "signal", output: unknown): ResolvedTargetState {
  const details = agentDetails();
  details.target = { kind: "dynamic-node", id: "agent~1", ref: "@1a2b3c4d5e6f" };
  details.staticNode = { ...details.staticNode!, kind };
  details.summary.targetKind = "dynamic-node";
  details.summary.targetId = "agent~1";
  details.summary.staticKind = kind;
  details.summary.nodeStatus = "completed";
  details.instances[0] = { ...details.instances[0]!, status: "completed", output, acceptedAttemptId: "attempt-1" };
  details.attempts[0] = {
    ...details.attempts[0]!,
    status: "completed",
    finishedAt: "2026-07-25T00:00:02.000Z",
  };
  return details;
}

function completedFrameDetails(
  kind: "if" | "switch" | "parallel" | "fanout" | "loop" | "assert",
  result: unknown,
): ResolvedTargetState {
  const details = agentDetails();
  details.target = { kind: "frame", id: "frame-1", ref: "@1a2b3c4d5e6f" };
  details.staticNode = { nodeId: kind, kind, order: 0, path: [kind] };
  details.summary = {
    ...details.summary,
    targetKind: "frame",
    targetId: "frame-1",
    nodeId: kind,
    frameKey: "frame-1",
    nodeStatus: "completed",
    staticKind: kind,
  };
  details.instances = [];
  details.attempts = [];
  details.frames = [{
    frameKey: "frame-1",
    nodeId: kind,
    frameKind: "node",
    status: "completed",
    result,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:02.000Z",
  }];
  return details;
}

function turn(
  number: number,
  overrides: Partial<AgentObservationTurn> = {},
): AgentObservationTurn {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    nodeKey: "agent~1",
    nodeId: "agent",
    attemptNo: 1,
    turn: number,
    promptKind: "task",
    state: "recording",
    completeness: "complete",
    gapCount: 0,
    eventCount: 1,
    unknownEventCount: 0,
    startedAt: `2026-07-25T00:00:${String(number).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function activity(
  turn: number,
  text: string,
  channel: "response" | "reported-thought" | "plan" = "response",
  at = `2026-07-25T00:00:0${turn}.000Z`,
): Extract<AgentObservationInspectionProjection["entries"][number], { kind: "activity" }> {
  return {
    id: `activity-${turn}-${channel}`,
    observationVersion: turn,
    attemptId: "attempt-1",
    turn,
    sourceSequence: turn,
    at,
    kind: "activity",
    channel,
    summary: inspectionExcerpt(text, 512, "tail"),
  };
}
