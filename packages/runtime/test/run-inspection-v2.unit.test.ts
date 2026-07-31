import { describe, expect, it } from "vitest";
import { projectAgentExecution } from "../src/inspection/agent-execution-projection.js";
import { projectInspectionTargetTimelineView } from "../src/inspection/coherent-projection.js";
import {
  inspectionExcerpt,
  projectTargetSummary,
} from "../src/inspection/decision-projection.js";
import type { ResolvedTargetState } from "../src/inspection/resolved-target.js";
import type {
  AgentObservationInspectionProjection,
  AgentObservationTurn,
} from "../src/observations/log.js";
import type { RunDetails } from "../src/store/store.js";

describe("inspection job projections", () => {
  it("keeps ordinary target summaries free of private journal details", () => {
    const document = projectTargetSummary({
      run: agentRun(),
      details: agentDetails(),
      observations: observations([turn(1, { state: "settled", providerStatus: "completed" })]),
    });

    expect(document).toMatchObject({
      schemaVersion: 2,
      kind: "target",
      subject: { ref: "@1a2b3c4d5e6f#1" },
      availableActions: [{ kind: "inspect-timeline", target: "@1a2b3c4d5e6f#1" }],
    });
    expect(document).not.toHaveProperty("journal");
  });

  it("prioritizes and labels settled intent with matching activity identity", () => {
    const document = settledSummary(
      [
        activity(1, "\n\n**Planning JSON structure with diverse angles**", "reported-thought"),
        activity(2, '{"query":"agent harness"}', "response"),
      ],
      [turn(1), turn(2, { state: "settled", providerStatus: "completed" })],
    );

    expect(document.pulse).toEqual({
      phase: "settled",
      headline: "Reported thought: **Planning JSON structure with diverse angles**",
      turn: 1,
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
  });

  it("labels a settled response tail and marks its missing prefix", () => {
    const response = `${"x".repeat(600)}镜头）","query":"agent harness"}`;
    const document = settledSummary([activity(1, response, "response")]);

    expect(document.pulse).toMatchObject({
      phase: "settled",
      turn: 1,
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
    expect(document.pulse?.headline).toMatch(/^Response tail: …/);
    expect(Array.from(document.pulse?.headline ?? "")).toHaveLength(240);
  });

  it("falls back from empty settled intent to an untruncated response", () => {
    const document = settledSummary([
      activity(1, "complete response", "response", "2026-07-25T00:00:01.000Z"),
      activity(1, " \n\t", "plan", "2026-07-25T00:00:02.000Z"),
    ]);

    expect(document.pulse).toEqual({
      phase: "settled",
      headline: "Response tail: complete response",
      turn: 1,
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
  });

  it("labels a settled plan and omits a headline for empty activity", () => {
    const planned = settledSummary([activity(1, "Check exact output", "plan")]);
    const empty = settledSummary([activity(1, " \n\t", "reported-thought")]);

    expect(planned.pulse?.headline).toBe("Plan: Check exact output");
    expect(empty.pulse).not.toHaveProperty("headline");
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

    const summary = projectTargetSummary({ run: agentRun(), details, observations: projection });
    expect(summary.visibility).toEqual({ state: "degraded", reason: "observation-gap" });
  });

  it("projects one bounded timeline view without private journal metadata", () => {
    const details = agentDetails();
    const projection = observations([], [
      activity(1, "first"),
      activity(2, "second"),
      activity(3, "third"),
    ]);

    const timeline = projectInspectionTargetTimelineView({
      run: agentRun(),
      details,
      events: [],
      observations: projection,
    });

    expect(timeline).toMatchObject({
      kind: "target",
      detail: "timeline",
      recent: [
        expect.objectContaining({ kind: "activity", summary: "first" }),
        expect.objectContaining({ kind: "activity", summary: "second" }),
        expect.objectContaining({ kind: "activity", summary: "third" }),
      ],
    });
    expect(timeline).not.toHaveProperty("evidence");
    expect(timeline).not.toHaveProperty("page");
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

function settledSummary(
  entries: AgentObservationInspectionProjection["entries"],
  turns = [turn(1, { state: "settled", providerStatus: "completed" })],
) {
  const details = agentDetails();
  details.summary.nodeStatus = "completed";
  return projectTargetSummary({
    run: agentRun(),
    details,
    observations: observations(turns, entries),
  });
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
