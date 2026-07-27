import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectAgentExecution } from "../src/inspection/agent-execution-projection.js";
import {
  ambiguousTimelineCandidates,
  inspectionExcerpt,
  projectTargetSummary,
  projectTimeline,
  resolvedTargetIdentity,
} from "../src/inspection/decision-projection.js";
import {
  decodeInspectionRevision,
  decodeTimelinePageCursor,
  inspectionFingerprint,
} from "../src/inspection/revision.js";
import type {
  RunInspectionRevision,
  RunInspectionTargetDetailsDocument,
} from "../src/inspection/types.js";
import type {
  AgentObservationInspectionProjection,
  AgentObservationTurnEvidence,
} from "../src/observations/log.js";
import type { RunDetails } from "../src/store/store.js";

describe("inspection v2 decision projections", () => {
  it("projects a bounded attempt summary with exact steer action and first/latest evidence", () => {
    const run = agentRun();
    const details = agentDetails();
    const observations = observationProjection([
      evidence(1, { state: "sealed", lastResponseBytes: 10 }),
      evidence(2, { promptKind: "repair", state: "sealed", lastResponseBytes: 20 }),
      evidence(3, {
        promptKind: "repair",
        state: "partial",
        completeness: "degraded",
        gapCount: 1,
        lastResponseBytes: 30,
        responseAtFenceBytes: 18,
        finalResponseBytes: 30,
        providerStatus: "completed",
        trace: {
          state: "partial",
          relativePath: "evidence/agents/attempt-1/turn-003.trace.jsonl.partial",
          bytes: 4_096,
          digest: "trace-3",
        },
      }),
    ]);

    const document = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
      observations,
      runDir: "/private/runtime/runs/run-1",
    });

    expect(document).toMatchObject({
      schemaVersion: 2,
      kind: "target",
      subject: {
        targetKind: "attempt",
        attemptId: "attempt-1",
        attemptNo: 1,
      },
      availableActions: [
        { kind: "inspect-timeline", target: "attempt-1" },
        { kind: "steer", target: "attempt-1" },
      ],
      evidence: {
        directory: "/private/runtime/runs/run-1/evidence/agents/attempt-1",
        state: "partial",
        completeness: "degraded",
        turnCount: 3,
        omittedTurns: 1,
        gapCount: 1,
        providerOutcome: "completed",
        schedulerDisposition: "pending",
        records: [
          { turn: 1, file: "turn-001.evidence.jsonl" },
          {
            turn: 3,
            file: "turn-003.evidence.jsonl",
            responseAtFenceBytes: 18,
            finalObservedResponseBytes: 30,
            trace: {
              state: "partial",
              file: "turn-003.trace.jsonl.partial",
              bytes: 4_096,
              digest: "trace-3",
            },
          },
        ],
      },
    });
    expect(document.availableActions).toHaveLength(2);
    expect(document.pulse?.headline).toBe("Bash running");
    expect(document).not.toHaveProperty("instances");
    expect(document).not.toHaveProperty("attempts");
    expect(document).not.toHaveProperty("progress");
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("steerId");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(6 * 1024);
  });

  it("enforces the serialized Summary budgets for long authored identities and private paths", () => {
    const run = agentRun();
    const details = agentDetails();
    const longNodeId = "节点".repeat(1_500);
    details.target = { kind: "static-node", id: longNodeId };
    details.staticNode = { ...details.staticNode!, nodeId: longNodeId };
    details.summary = {
      ...details.summary,
      targetKind: "static-node",
      targetId: longNodeId,
      nodeId: longNodeId,
    };
    details.items[0] = { ...details.items[0]!, nodeId: longNodeId, label: longNodeId };
    details.instances[0] = { ...details.instances[0]!, nodeId: longNodeId };
    details.attempts[0] = { ...details.attempts[0]!, nodeId: longNodeId };

    const summary = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 0 },
      query: { runId: run.id, mode: "target", target: longNodeId },
    });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4 * 1024);
    expect(summary.availableActions).toEqual([
      { kind: "inspect-timeline", target: "attempt-1" },
      { kind: "steer", target: "attempt-1" },
    ]);

    const evidenceSummary = projectTargetSummary({
      run,
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
      observations: observationProjection([
        evidence(1, { state: "sealed", providerStatus: "completed" }),
      ]),
      runDir: `/private/${"目录/".repeat(1_000)}run-1`,
    });
    expect(Buffer.byteLength(JSON.stringify(evidenceSummary))).toBeLessThanOrEqual(6 * 1024);
    expect(evidenceSummary.evidence?.records).toHaveLength(1);
  });

  it("reports a pre-dispatch steer fence as unavailable degraded evidence", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      cancelReason: "operator_steered",
      finishedAt: "2026-07-25T00:00:01.000Z",
    };
    details.summary.nodeStatus = "cancelled";
    const observations = observationProjection([]);
    const summary = projectTargetSummary({
      run: agentRun(),
      details,
      cursor: { eventSequence: 5, progressVersion: 0, observationVersion: 0 },
      query: { runId: "run-1", mode: "target", target: "attempt-1" },
      observations,
      runDir: "/private/runtime/runs/run-1",
    });
    expect(summary.attention).toBeUndefined();
    expect(summary.visibility).toEqual({
      state: "degraded",
      reason: "boundary-evidence-unavailable",
    });
    expect(summary.evidence).toEqual({
      directory: "/private/runtime/runs/run-1/evidence/agents/attempt-1",
      state: "partial",
      completeness: "degraded",
      turnCount: 0,
      omittedTurns: 0,
      gapCount: 1,
      schedulerDisposition: "discarded",
      dispositionReason: "operator_steered",
      records: [],
    });

    const timeline = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 5, progressVersion: 0, observationVersion: 0 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations,
    });
    expect(timeline.visibility).toEqual({
      state: "degraded",
      reason: "boundary-evidence-unavailable",
    });
  });

  it("uses scheduler-controllable node identities for failed attempt recovery actions", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "failed",
      finishedAt: "2026-07-25T00:00:01.000Z",
    };
    details.instances[0] = { ...details.instances[0]!, status: "failed" };
    details.summary.nodeStatus = "failed";
    details.availableControls = [{ type: "retry", target: "agent~1" }];

    const summary = projectTargetSummary({
      run: { ...agentRun(), status: "failed" },
      details,
      cursor: { eventSequence: 5, progressVersion: 2, observationVersion: 0 },
      query: { runId: "run-1", mode: "target", target: "attempt-1" },
    });

    expect(summary.availableActions).toEqual([
      { kind: "retry", target: "agent~1" },
      { kind: "fork", target: "agent~1" },
    ]);
  });

  it("keeps projected current activity separate from closed semantic history", () => {
    const run = agentRun();
    const details = agentDetails();
    const observations = observationProjection(
      [
        evidence(1, { state: "sealed", finalResponseBytes: 10, providerStatus: "completed" }),
        evidence(2, { promptKind: "repair", state: "recording" }),
      ],
      [
        semanticActivity(1, 2, "response", "first answer"),
        semanticActivity(1, 4, "tool", "Read completed", {
          tool: {
            toolCallId: "tool-1",
            name: "Read",
            status: "completed",
            input: inspectionExcerpt("{\"path\":\"README.md\"}", 512),
            output: inspectionExcerpt("done", 512),
            updatedAt: "2026-07-25T00:00:01.004Z",
            finishedAt: "2026-07-25T00:00:01.004Z",
          },
        }),
      ],
      [agentCurrent(2, {
        promptKind: "repair",
        phase: "responding",
        response: inspectionExcerpt("open response", 1_536),
      })],
    );

    const document = projectTimeline({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: run.id, mode: "timeline", target: "attempt-1" },
      events: [],
      observations,
    });

    expect(document.current).toMatchObject({
      kind: "agent",
      attemptId: "attempt-1",
      attemptNo: 1,
      turn: 2,
      turnKind: "repair",
      phase: "responding",
      response: { text: "open response", truncated: false },
    });
    const activity = document.recent.entries.filter(entry => entry.kind === "activity");
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "response",
        summary: expect.objectContaining({ text: "first answer" }),
      }),
      expect.objectContaining({
        channel: "tool",
        tool: expect.objectContaining({
          toolCallId: "tool-1",
          name: "Read",
          status: "completed",
          input: expect.objectContaining({ text: "{\"path\":\"README.md\"}" }),
          output: expect.objectContaining({ text: "done" }),
        }),
      }),
    ]));
    expect(activity.some(entry => entry.summary.text.includes("open response"))).toBe(false);
  });

  it("maps provider-reported thought and automatic repair to neutral public phases", () => {
    const project = (phase: "thinking" | "repairing") => projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 2 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection(
        [evidence(1, { promptKind: phase === "repairing" ? "repair" : "task" })],
        [],
        [agentCurrent(1, {
          promptKind: phase === "repairing" ? "repair" : "task",
          phase,
        })],
      ),
    }).current;

    expect(project("thinking")).toMatchObject({ kind: "agent", phase: "reported-thought" });
    expect(project("repairing")).toMatchObject({ kind: "agent", phase: "output-repair" });
  });

  it("uses reported intent ahead of response and ignores a completed tool for the pulse headline", () => {
    const run = agentRun();
    const progress = run.dynamic!.progress[0]!;
    progress.intent = {
      kind: "plan",
      value: "verify the durable result",
      updatedAt: "2026-07-25T00:00:02.000Z",
    };
    progress.tools = {
      turn: 1,
      totalToolCallCount: 1,
      lastCalls: [{ toolName: "Read", status: "completed", updatedAt: "2026-07-25T00:00:01.000Z" }],
    };
    const document = projectTargetSummary({
      run,
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 3, observationVersion: 0 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
    });
    expect(document.pulse).toMatchObject({
      phase: "planning",
      headline: "verify the durable result",
      updatedAt: "2026-07-25T00:00:02.000Z",
    });
  });

  it("falls back to bounded node progress before the first semantic checkpoint", () => {
    const run = agentRun();
    const progress = run.dynamic!.progress[0]!;
    progress.tools = {
      turn: 1,
      totalToolCallCount: 1,
      lastCalls: [{
        toolCallId: "tool-1",
        toolName: "Bash",
        status: "running",
        output: { passed: 4 },
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
    };
    const timeline = projectTimeline({
      run,
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 3, observationVersion: 1 },
      query: { runId: run.id, mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection([evidence(1)]),
    });

    expect(timeline.current).toMatchObject({
      kind: "agent",
      tools: {
        active: [{
          toolCallId: "tool-1",
          output: { text: "{\"passed\":4}", truncated: false },
        }],
      },
    });
  });

  it("surfaces degraded semantic checkpoints without exposing unknown provider payloads", () => {
    const observations = observationProjection(
      [evidence(2, { completeness: "degraded" })],
      [],
      [agentCurrent(2, {
        phase: "responding",
        response: inspectionExcerpt("late provider response", 1_536),
        postFence: true,
        completeness: "degraded",
      })],
    );
    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 2 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations,
    });
    expect(document.visibility).toEqual({
      state: "degraded",
      reason: "unrecognized-provider-activity",
    });
    expect(document.current).toMatchObject({
      kind: "agent",
      phase: "responding",
      postFence: true,
      response: { text: "late provider response" },
    });
    expect(document.current).not.toHaveProperty("tools");
    expect(document.current).not.toHaveProperty("observation");
    expect(document.recent.entries).toEqual([]);
    expect(JSON.stringify(document)).not.toContain("private-provider-event");

    const summary = projectTargetSummary({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 2 },
      query: { runId: "run-1", mode: "target", target: "attempt-1" },
      observations,
    });
    expect(summary.pulse).toMatchObject({
      phase: "responding",
      headline: "late provider response",
    });
  });

  it("keeps terminal failure as the only attention despite diagnostic metrics", () => {
    const run = agentRun();
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "failed",
      deadlineAt: "2026-07-25T00:00:30.000Z",
      terminalReason: "provider_failed",
      finishedAt: "2026-07-25T00:00:01.000Z",
    };
    details.summary.nodeStatus = "failed";
    details.summary.failure = { origin: "provider", code: "provider_exit", message: "Provider failed." };
    const progress = run.dynamic!.progress[0]!;
    progress.context = { used: 95, size: 100 };
    progress.tools = {
      turn: 1,
      totalToolCallCount: 1,
      lastCalls: [{
        toolName: "Bash",
        status: "failed",
        updatedAt: progress.updatedAt,
      }],
    };
    const document = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 5, progressVersion: 3, observationVersion: 4 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
      observations: observationProjection([
        evidence(1, { state: "partial", completeness: "degraded" }),
      ]),
      runDir: "/private/runtime/runs/run-1",
    });
    expect(document.attention).toEqual({
      code: "terminal_failure",
      summary: "Provider failed.",
    });
    expect(document.visibility).toEqual({
      state: "degraded",
      reason: "unrecognized-provider-activity",
    });
    expect(document.evidence?.schedulerDisposition).toBe("committed");
  });

  it("drops active-only attention and starting copy after a successful terminal attempt", () => {
    const run = agentRun();
    run.status = "completed";
    run.dynamic!.progress[0]!.context = { used: 101, size: 100 };
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "completed",
      finishedAt: "2026-07-25T00:00:02.000Z",
    };
    details.instances[0] = { ...details.instances[0]!, status: "completed" };
    details.summary.nodeStatus = "completed";

    const completed = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 5, progressVersion: 3, observationVersion: 0 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
    });
    expect(completed.attention).toBeUndefined();

    run.dynamic!.progress = [];
    const withoutProgress = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 5, progressVersion: 3, observationVersion: 0 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
    });
    expect(withoutProgress.pulse).toEqual({
      phase: "settled",
      updatedAt: "2026-07-25T00:00:02.000Z",
    });
  });

  it("does not promote deadline, context, failed tools, or visibility into attention", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      deadlineAt: "2026-07-25T00:00:50.000Z",
    };
    const run = agentRun();
    run.dynamic!.progress[0]!.context = { used: 100, size: 100 };
    run.dynamic!.progress[0]!.tools = {
      turn: 1,
      totalToolCallCount: 1,
      lastCalls: [{ toolName: "Bash", status: "failed", updatedAt: run.updatedAt }],
    };
    const document = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 1 },
      query: { runId: "run-1", mode: "target", target: "attempt-1" },
      observations: observationProjection([
        evidence(1, { completeness: "degraded", gapCount: 1 }),
      ]),
    });
    expect(document.attention).toBeUndefined();
    expect(document.visibility).toEqual({ state: "degraded", reason: "observation-gap" });
  });

  it("keeps an isolated failed tool out of attention", () => {
    const run = agentRun();
    run.dynamic!.progress[0]!.tools = {
      turn: 1,
      totalToolCallCount: 1,
      lastCalls: [{
        toolName: "Bash",
        status: "failed",
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
    };
    run.dynamic!.progress[0]!.intent = {
      kind: "plan",
      value: "Try a narrower query.",
      updatedAt: "2026-07-25T00:00:02.000Z",
    };
    run.dynamic!.progress[0]!.updatedAt = "2026-07-25T00:00:02.000Z";

    const document = projectTargetSummary({
      run,
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 3, observationVersion: 0 },
      query: { runId: run.id, mode: "target", target: "attempt-1" },
    });

    expect(document.attention).toBeUndefined();
  });

  it("orders a steer fence between the pre-fence response and late provider response", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      cancelReason: "operator_steered",
      finishedAt: "2026-07-25T00:00:02.000Z",
    };
    details.summary.nodeStatus = "cancelled";
    const observations = observationProjection(
      [evidence(1, {
        state: "sealed",
        responseAtFenceBytes: 6,
        fenceEventSequence: 5,
        finalResponseBytes: 19,
        providerStatus: "completed",
      })],
      [
        semanticActivity(1, 1, "response", "before"),
        semanticActivity(1, 2, "tool", "Read running", {
          tool: {
            toolCallId: "tool-before-fence",
            name: "Read",
            status: "running",
            updatedAt: "2026-07-25T00:00:01.002Z",
          },
        }),
        semanticActivity(1, 4, "response", " late response", {
          at: "2026-07-25T00:00:01.002Z",
          postFence: true,
        }),
      ],
    );
    const timeline = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 7, progressVersion: 2, observationVersion: 4 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [{
        runId: "run-1",
        sequence: 5,
        type: "control.agent_steer_requested",
        nodeKey: "agent~1",
        payload: {
          steerId: "private-steer-id",
          requestedTarget: "attempt-1",
          nodeKey: "agent~1",
          fencedAttemptId: "attempt-1",
          instruction: "private correction",
        },
        createdAt: "2026-07-25T00:00:01.002Z",
        idempotencyKey: "steer:1",
      }],
      observations,
    });
    expect(timeline.recent.entries.map(entry => {
      if (entry.kind === "activity") return `${entry.kind}:${entry.channel}:${entry.summary.text}`;
      if (entry.kind === "control") return `${entry.kind}:${entry.action}`;
      return entry.kind;
    }))
      .toEqual([
        "activity:response:before",
        "activity:tool:Read running",
        "control:steered",
        "activity:response: late response",
      ]);
    expect(timeline.recent.entries.filter(entry =>
      entry.kind === "control" && entry.action === "steered")).toHaveLength(1);
    expect(timeline.recent.entries.find(entry => entry.kind === "control")).toMatchObject({
      id: "event:5",
      attemptNo: 1,
      responseAtFenceBytes: 6,
    });
    expect(timeline.recent.entries.find(entry =>
      entry.kind === "activity" && entry.summary.text === " late response")).toMatchObject({
        attemptNo: 1,
        postFence: true,
      });
    const schedulerOnly = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 5, progressVersion: 2, observationVersion: 0 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [{
        runId: "run-1",
        sequence: 5,
        type: "control.agent_steer_requested",
        nodeKey: "agent~1",
        payload: {
          requestedTarget: "attempt-1",
          nodeKey: "agent~1",
          fencedAttemptId: "attempt-1",
        },
        createdAt: "2026-07-25T00:00:01.003Z",
        idempotencyKey: "steer:1",
      }],
      observations: observationProjection([]),
    });
    expect(schedulerOnly.recent.entries.find(entry => entry.kind === "control")).toMatchObject({
      id: "event:5",
      action: "steered",
    });
    expect(JSON.stringify(timeline)).not.toContain("private correction");
    expect(JSON.stringify(timeline)).not.toContain("private-steer-id");

    const summary = projectTargetSummary({
      run: agentRun(),
      details,
      cursor: { eventSequence: 7, progressVersion: 2, observationVersion: 4 },
      query: { runId: "run-1", mode: "target", target: "attempt-1" },
      observations,
      runDir: "/private/runtime/runs/run-1",
    });
    expect(summary.evidence).toMatchObject({
      providerOutcome: "completed",
      schedulerDisposition: "discarded",
      dispositionReason: "operator_steered",
    });
  });

  it("clears pre-fence tools while retaining a late response as current", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      cancelReason: "operator_steered",
      finishedAt: "2026-07-25T00:00:02.000Z",
    };
    details.summary.nodeStatus = "cancelled";
    const observations = observationProjection(
      [evidence(1, { state: "recording", responseAtFenceBytes: 0, fenceEventSequence: 5 })],
      [
        semanticActivity(1, 1, "tool", "Read running", {
          tool: {
            toolCallId: "tool-before-fence",
            name: "Read",
            status: "running",
            updatedAt: "2026-07-25T00:00:01.001Z",
          },
        }),
      ],
      [agentCurrent(1, {
        phase: "responding",
        response: inspectionExcerpt("late response", 1_536),
      })],
    );

    const timeline = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 7, progressVersion: 2, observationVersion: 3 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [{
        runId: "run-1",
        sequence: 5,
        type: "control.agent_steer_requested",
        nodeKey: "agent~1",
        payload: {
          requestedTarget: "attempt-1",
          nodeKey: "agent~1",
          fencedAttemptId: "attempt-1",
        },
        createdAt: "2026-07-25T00:00:01.002Z",
        idempotencyKey: "steer:1",
      }],
      observations,
    });

    expect(timeline.current).toMatchObject({
      kind: "agent",
      phase: "responding",
      response: { text: "late response" },
    });
    expect(timeline.current).not.toHaveProperty("tools");
    expect(timeline.recent.entries.map(entry =>
      entry.kind === "activity" ? `${entry.channel}:${entry.summary.text}` : entry.kind))
      .toEqual(["tool:Read running", "control"]);
  });

  it("keeps an exact attempt Timeline isolated from replacement attempts", () => {
    const details = agentDetails();
    details.attempts.push({
      ...details.attempts[0]!,
      attemptId: "attempt-2",
      attemptNo: 2,
      startedAt: "2026-07-25T00:00:02.000Z",
    });
    const first = evidence(1, { state: "sealed", providerStatus: "completed" });
    const replacement = {
      ...evidence(1, { state: "sealed", providerStatus: "completed" }),
      attemptId: "attempt-2",
      relativePath: "evidence/agents/attempt-2/turn-001.evidence.jsonl",
    };
    const firstRecords = [
      semanticActivity(1, 1, "response", "first attempt"),
    ];
    const replacementRecords = [
      semanticActivity(1, 3, "response", "replacement"),
    ].map(value => ({ ...value, attemptId: "attempt-2" }));
    const document = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 5, progressVersion: 2, observationVersion: 4 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [{
        runId: "run-1",
        sequence: 5,
        type: "instance.started",
        nodeKey: "agent~1",
        payload: { nodeKey: "agent~1", attemptId: "attempt-2" },
        createdAt: "2026-07-25T00:00:02.000Z",
        idempotencyKey: "replacement:start",
      }],
      observations: observationProjection([first, replacement], [...firstRecords, ...replacementRecords]),
    });
    expect(JSON.stringify(document)).toContain("first attempt");
    expect(JSON.stringify(document)).not.toContain("replacement");
  });

  it("shows late provider activity as current while a superseded attempt is still recording", () => {
    const details = agentDetails();
    details.attempts[0] = {
      ...details.attempts[0]!,
      status: "superseded",
      cancelReason: "operator_steered",
      finishedAt: "2026-07-25T00:00:02.000Z",
    };
    details.summary.nodeStatus = "cancelled";
    const document = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 7, progressVersion: 2, observationVersion: 3 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection(
        [evidence(1, { state: "recording", responseAtFenceBytes: 6 })],
        [],
        [agentCurrent(1, {
          phase: "responding",
          postFence: true,
          response: inspectionExcerpt("late output", 1_536),
        })],
      ),
    });
    expect(document.state.status).toBe("cancelled");
    expect(document.current).toMatchObject({
      kind: "agent",
      phase: "responding",
      postFence: true,
      response: { text: "late output" },
    });
  });

  it("does not misclassify fallback fences or paused requeues as steer or retry controls", () => {
    const details = agentDetails();
    details.target = { kind: "dynamic-node", id: "agent~1" };
    details.summary = {
      ...details.summary,
      targetKind: "dynamic-node",
      targetId: "agent~1",
    };
    const document = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 6, progressVersion: 2, observationVersion: 3 },
      query: { runId: "run-1", mode: "timeline", target: "agent~1" },
      events: [
        {
          runId: "run-1",
          sequence: 5,
          type: "control.paused",
          payload: {},
          createdAt: "2026-07-25T00:00:01.002Z",
          idempotencyKey: "pause:1",
        },
        {
          runId: "run-1",
          sequence: 6,
          type: "instance.requeued",
          nodeKey: "agent~1",
          payload: { nodeKey: "agent~1", reason: "paused" },
          createdAt: "2026-07-25T00:00:01.003Z",
          idempotencyKey: "pause:requeue",
        },
      ],
      observations: observationProjection(
        [evidence(1, { state: "sealed", providerStatus: "cancelled" })],
        [
          semanticActivity(1, 1, "response", "partial"),
        ],
      ),
    });
    expect(document.recent.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "control", action: "paused" }),
      expect.objectContaining({ kind: "transition", action: "requeued" }),
    ]));
    expect(document.recent.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "control", action: "steered" }),
      expect.objectContaining({ kind: "control", action: "retried" }),
    ]));
  });

  it("does not attach global controls to an unstarted static target", () => {
    const details = agentDetails();
    details.target = { kind: "static-node", id: "agent" };
    details.summary = {
      targetKind: "static-node",
      targetId: "agent",
      runStatus: "running",
      runStartedAt: "2026-07-25T00:00:00.000Z",
      nodeId: "agent",
      staticKind: "agent",
      staticOrder: 0,
      nodeStatus: "not_started",
      artifacts: [],
    };
    details.items = [];
    details.instances = [];
    details.attempts = [];
    details.frames = [];
    details.progress = [];
    const document = projectTimeline({
      run: agentRun(),
      details,
      cursor: { eventSequence: 5, progressVersion: 2, observationVersion: 0 },
      query: { runId: "run-1", mode: "timeline", target: "agent" },
      events: [{
        runId: "run-1",
        sequence: 5,
        type: "control.paused",
        payload: {},
        createdAt: "2026-07-25T00:00:01.000Z",
        idempotencyKey: "pause:unrelated",
      }],
      observations: observationProjection([]),
    });

    expect(document.state.status).toBe("not_started");
    expect(document.recent.entries).toEqual([]);
  });

  it("uses compact discriminated current activity for Task, Signal, and Composite targets", () => {
    const project = (
      kind: "task" | "signal" | "parallel",
      status: "running" | "awaiting",
    ) => {
      const details = agentDetails();
      details.target = { kind: "dynamic-node", id: "agent~1" };
      details.staticNode = {
        nodeId: "work",
        kind,
        order: 0,
        path: ["work"],
      };
      details.summary = {
        targetKind: "dynamic-node",
        targetId: "agent~1",
        runStatus: status === "awaiting" ? "awaiting" : "running",
        runStartedAt: "2026-07-25T00:00:00.000Z",
        nodeId: "work",
        nodeKey: "agent~1",
        nodeStatus: status,
        staticKind: kind,
        staticOrder: 0,
        ...(kind === "signal"
          ? {
              signal: {
                target: "agent~1",
                promptPreview: "Approve release?",
                schemaSummary: "{ approved: boolean }",
              },
            }
          : {}),
        artifacts: [],
      };
      details.items[0] = {
        ...details.items[0]!,
        label: "work",
        kind,
        nodeId: "work",
        status,
      };
      details.instances[0] = {
        ...details.instances[0]!,
        nodeId: "work",
        status,
      };
      details.attempts = [];
      details.progress = [];
      return projectTimeline({
        run: agentRun(),
        details,
        cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 0 },
        query: { runId: "run-1", mode: "timeline", target: "agent~1" },
        events: [],
        observations: observationProjection([]),
      });
    };

    expect(project("task", "running").current).toMatchObject({ kind: "task", phase: "running" });
    expect(project("parallel", "running").current).toMatchObject({ kind: "composite", phase: "running" });
    expect(project("signal", "awaiting").current).toMatchObject({
      kind: "signal",
      phase: "awaiting",
      prompt: { text: "Approve release?" },
      schemaSummary: "{ approved: boolean }",
    });
  });

  it("preserves the reducer's 768-byte current and 512-byte closed tool budgets", () => {
    const longInput = "i".repeat(1_000);
    const longOutput = "o".repeat(1_000);
    const records = [
      semanticActivity(1, 2, "tool", "Read completed", {
        tool: {
          toolCallId: "closed",
          name: "Read",
          status: "completed",
          input: inspectionExcerpt(longInput, 200),
          output: inspectionExcerpt(longOutput, 200, "tail"),
          updatedAt: "2026-07-25T00:00:01.002Z",
          finishedAt: "2026-07-25T00:00:01.002Z",
        },
      }),
    ];
    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 5 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection([
        evidence(1, { state: "sealed", providerStatus: "completed" }),
        evidence(2, { state: "recording" }),
      ], records, [agentCurrent(2, {
        phase: "tool",
        tools: {
          active: [{
            toolCallId: "active",
            name: "Write",
            status: "running",
            input: inspectionExcerpt(longInput, 384),
            output: inspectionExcerpt(longOutput, 384, "tail"),
            updatedAt: "2026-07-25T00:00:02.002Z",
          }],
          omittedActive: 0,
        },
      })]),
    });
    if (document.current?.kind !== "agent") throw new Error("expected Agent current activity");
    const active = document.current.tools?.active[0];
    expect(Buffer.byteLength(active?.input?.text ?? "") + Buffer.byteLength(active?.output?.text ?? ""))
      .toBeLessThanOrEqual(768);
    const recent = document.recent.entries.find(entry => entry.kind === "activity" && entry.channel === "tool");
    if (!recent || recent.kind !== "activity") throw new Error("expected recent tool entry");
    expect(
      Buffer.byteLength(recent.summary.text)
      + Buffer.byteLength(recent.tool?.input?.text ?? "")
      + Buffer.byteLength(recent.tool?.output?.text ?? ""),
    ).toBeLessThanOrEqual(512);
  });

  it("keeps prebounded semantic tool identity and display fields within the public entry budget", () => {
    const longId = "id".repeat(5_000);
    const longName = "tool".repeat(2_500);
    const records = [
      semanticActivity(1, 2, "tool", "tool completed", {
        tool: {
          toolCallId: `sha256:${createHash("sha256").update(longId).digest("base64url")}`,
          name: longName.slice(0, 160),
          status: "completed",
          input: inspectionExcerpt("i".repeat(1_000), 50),
          output: inspectionExcerpt("o".repeat(1_000), 50, "tail"),
          updatedAt: "2026-07-25T00:00:01.002Z",
          finishedAt: "2026-07-25T00:00:01.002Z",
        },
      }),
    ];
    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 3 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection([
        evidence(1, { state: "sealed", providerStatus: "completed" }),
      ], records),
    });
    const entry = document.recent.entries.find(candidate =>
      candidate.kind === "activity" && candidate.channel === "tool");
    if (!entry || entry.kind !== "activity" || !entry.tool) throw new Error("expected tool entry");
    expect(Buffer.byteLength(entry.tool.toolCallId ?? "")).toBeLessThanOrEqual(80);
    expect(Array.from(entry.tool.name)).toHaveLength(160);
    expect(
      Buffer.byteLength(entry.summary.text)
      + Buffer.byteLength(entry.tool.toolCallId ?? "")
      + Buffer.byteLength(entry.tool.name)
      + Buffer.byteLength(entry.tool.status ?? "")
      + Buffer.byteLength(entry.tool.input?.text ?? "")
      + Buffer.byteLength(entry.tool.output?.text ?? ""),
    ).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(10 * 1024);
  });

  it("keeps aggregate static-node summaries occurrence-safe", () => {
    const run = agentRun();
    const details = agentDetails();
    details.target = { kind: "static-node", id: "agent" };
    details.summary = {
      ...details.summary,
      targetKind: "static-node",
      targetId: "agent",
      nodeStatus: "mixed",
      counts: { total: 2, running: 2 },
    };
    details.instances.push({
      ...details.instances[0]!,
      nodeKey: "agent~2",
    });
    details.attempts.push({
      ...details.attempts[0]!,
      attemptId: "attempt-2",
      nodeKey: "agent~2",
    });
    const document = projectTargetSummary({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 0 },
      query: { runId: "run-1", mode: "target", target: "agent" },
    });
    expect(document).toMatchObject({
      subject: { targetKind: "static-node", id: "agent" },
      state: { status: "mixed" },
      occurrence: { total: 2 },
      availableActions: [],
    });
    expect(document.subject).not.toHaveProperty("nodeKey");
    expect(document.subject).not.toHaveProperty("attemptId");
    expect(document.pulse).toBeUndefined();
  });

  it("binds revisions to the normalized Timeline limit", () => {
    expect(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
    })).toBe(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
      page: { limit: 12 },
    }));
    expect(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
      page: { limit: 1 },
    })).not.toBe(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
      page: { limit: 50 },
    }));
    expect(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
      page: { before: "older-page-a" },
    })).not.toBe(inspectionFingerprint({
      runId: "run-1",
      mode: "timeline",
      target: "attempt-1",
      page: { before: "older-page-b" },
    }));
  });

  it("rejects prior revision and page cursor encodings", () => {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(decodeInspectionRevision(encoded({
      v: 3,
      kind: "inspection",
      runId: "run-1",
      fingerprint: "old",
      event: 1,
      progress: 1,
      observation: 1,
    }))).toBeUndefined();
    expect(decodeTimelinePageCursor(encoded({
      v: 3,
      kind: "timeline-page",
      runId: "run-1",
      target: "old",
      ordering: 4,
      boundary: "entry",
      at: "2026-07-25T00:00:00.000Z",
      id: "old",
      ordinal: 0,
    }))).toBeUndefined();
  });

  it("returns the latest twelve semantic entries with an opaque older cursor", () => {
    const run = agentRun();
    const details = agentDetails();
    const turns = Array.from({ length: 15 }, (_, index) =>
      evidence(index + 1, { state: "sealed", finalResponseBytes: index + 1, providerStatus: "completed" }));
    const records = turns.map(turn =>
      semanticActivity(turn.turn, turn.turn, "response", `response-${turn.turn}`));
    const document = projectTimeline({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 30 },
      query: { runId: run.id, mode: "timeline", target: "attempt-1" },
      events: [],
      observations: observationProjection(turns, records),
    });

    expect(document.recent.returned).toBe(12);
    expect(document.recent.omittedBefore).toBe(3);
    expect(document.recent.hasOlder).toBe(true);
    expect(document.recent.olderCursor).toEqual(expect.any(String));
    expect(document.recent.entries[0]).toMatchObject({ kind: "activity", turn: 4 });
    expect(decodeTimelinePageCursor(document.recent.olderCursor!)).toMatchObject({
      boundary: "entry",
      beforeEntry: {
        observationVersion: 4,
        sourceSequence: 4,
        id: "activity:attempt-1:4:4:response",
      },
    });

    const olderCursor = document.recent.olderCursor;
    const cursor = olderCursor ? decodeTimelinePageCursor(olderCursor) : undefined;
    if (!cursor || !olderCursor) throw new Error("expected page cursor");
    const older = projectTimeline({
      run,
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 30 },
      query: {
        runId: run.id,
        mode: "timeline",
        target: "attempt-1",
        page: { before: olderCursor },
      },
      events: [],
      observations: observationProjection(turns.slice(0, 3), records.slice(0, 3)),
      before: { at: cursor.at, id: cursor.id, ordinal: cursor.ordinal },
    });
    expect(older.recent.entries.map(entry =>
      entry.kind === "activity" ? entry.turn : undefined)).toEqual([1, 2, 3]);
    expect(older.recent.hasOlder).toBe(false);
    expect(older.recent).not.toHaveProperty("olderCursor");
  });

  it("counts retained entries outside the SQLite page in omittedBefore", () => {
    const entries = Array.from({ length: 50 }, (_, index) => {
      const version = index + 79;
      return semanticActivity(version, version, "response", `response-${version}`);
    });
    const observations = observationProjection([], entries);
    observations.olderEntryCount = 78;
    observations.hasOlderEntries = true;

    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 128 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations,
    });

    expect(document.recent).toMatchObject({
      returned: 12,
      omittedBefore: 116,
      hasOlder: true,
    });
    expect(decodeTimelinePageCursor(document.recent.olderCursor!)).toMatchObject({
      beforeEntry: {
        observationVersion: 117,
        sourceSequence: 117,
        id: "activity:attempt-1:117:117:response",
      },
    });
  });

  it("pages every semantic entry when a mutation assigns one observation version to several entries", () => {
    const entries = [1, 2, 3, 4].map(sourceSequence =>
      semanticActivity(1, 10, "response", `response-${sourceSequence}`, {
        id: `activity:shared-version:${sourceSequence}`,
        sourceSequence,
      }));
    const first = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 10 },
      query: {
        runId: "run-1",
        mode: "timeline",
        target: "attempt-1",
        page: { limit: 2 },
      },
      events: [],
      observations: observationProjection([], entries),
    });

    expect(first.recent.entries.map(entry => entry.id)).toEqual([
      "activity:shared-version:3",
      "activity:shared-version:4",
    ]);
    const olderCursor = first.recent.olderCursor;
    const cursor = olderCursor ? decodeTimelinePageCursor(olderCursor) : undefined;
    expect(cursor?.beforeEntry).toEqual({
      observationVersion: 10,
      sourceSequence: 3,
      id: "activity:shared-version:3",
    });
    const boundary = cursor?.beforeEntry;
    if (!boundary || !olderCursor || !cursor) throw new Error("expected semantic entry boundary");

    const olderEntries = entries.filter(entry =>
      entry.observationVersion < boundary.observationVersion
      || entry.observationVersion === boundary.observationVersion
        && (entry.sourceSequence < boundary.sourceSequence
          || entry.sourceSequence === boundary.sourceSequence
            && entry.id.localeCompare(boundary.id) < 0));
    const older = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 10 },
      query: {
        runId: "run-1",
        mode: "timeline",
        target: "attempt-1",
        page: { limit: 2, before: olderCursor },
      },
      events: [],
      observations: observationProjection([], olderEntries),
      before: { at: cursor.at, id: cursor.id, ordinal: cursor.ordinal },
    });

    expect(older.recent.entries.map(entry => entry.id)).toEqual([
      "activity:shared-version:1",
      "activity:shared-version:2",
    ]);
    expect(older.recent.hasOlder).toBe(false);
  });

  it("reports expired retained history without inventing a pageable cursor", () => {
    const observations = observationProjection([evidence(1, { state: "sealed" })]);
    observations.retentionOmittedBefore = 9;
    observations.retentionFloorVersion = 10;
    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 10 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1" },
      events: [],
      observations,
      before: { at: "2026-07-25T00:00:00.000Z", id: "missing-boundary", ordinal: 0 },
    });

    expect(document.recent).toMatchObject({
      entries: [],
      returned: 0,
      hasOlder: false,
      retentionOmittedBefore: 9,
    });
    expect(document.recent).not.toHaveProperty("olderCursor");
    expect(document.visibility).toBeUndefined();
  });

  it("honors the 8 KiB Timeline body budget before the limit of fifty entries", () => {
    const turns = Array.from({ length: 50 }, (_, index) =>
      evidence(index + 1, { state: "sealed", providerStatus: "completed" }));
    const records = turns.map(turn => semanticActivity(
      turn.turn,
      turn.turn,
      "response",
      `${String(turn.turn).padStart(2, "0")}:${"x".repeat(510)}`,
    ));
    const document = projectTimeline({
      run: agentRun(),
      details: agentDetails(),
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 100 },
      query: { runId: "run-1", mode: "timeline", target: "attempt-1", page: { limit: 50 } },
      events: [],
      observations: observationProjection(turns, records),
    });
    const bodyBytes = document.recent.entries.reduce((total, entry) =>
      total + (entry.kind === "activity" ? Buffer.byteLength(entry.summary.text) : 0), 0);
    expect(document.recent.returned).toBeLessThan(50);
    expect(bodyBytes).toBeLessThanOrEqual(8 * 1024);
    expect(document.recent.hasOlder).toBe(true);
  });

  it("truncates UTF-8 excerpts on code point boundaries", () => {
    expect(inspectionExcerpt("a😀b", 5)).toEqual({
      text: "a😀",
      originalBytes: 6,
      truncated: true,
    });
    expect(inspectionExcerpt("a😀b", 5, "tail")).toEqual({
      text: "😀b",
      originalBytes: 6,
      truncated: true,
    });
    expect(inspectionExcerpt("\ufffda😀b", 8)).toEqual({
      text: "\ufffda😀",
      originalBytes: 9,
      truncated: true,
    });
  });

  it("sorts ambiguous dynamic occurrence keys", () => {
    const details = agentDetails();
    details.target = { kind: "static-node", id: "agent" };
    details.summary.counts = { total: 2, running: 2 };
    details.instances.push({
      ...details.instances[0]!,
      nodeKey: "agent~a",
    });
    details.instances[0]!.nodeKey = "agent~z";
    expect(ambiguousTimelineCandidates(details)).toEqual(["agent~a", "agent~z"]);
  });

  it("binds a single static occurrence cursor to its resolved node key", () => {
    const details = agentDetails();
    details.target = { kind: "static-node", id: "agent" };
    details.summary = {
      ...details.summary,
      targetKind: "static-node",
      targetId: "agent",
    };
    expect(resolvedTargetIdentity(details)).toBe("dynamic-node:agent~1");
  });

  it("projects exact-attempt Agent execution while keeping scheduler status authoritative", () => {
    const details = agentDetails();
    details.executionMetadata = [{
      id: 1,
      attemptId: "attempt-1",
      kind: "agent_attempt",
      createdAt: "2026-07-25T00:00:03.000Z",
      metadata: {
        status: "completed",
        sessionName: "session-exact",
        turnCount: 2,
        message: "metadata message",
        turns: [{
          turn: 1,
          summary: {
            context: { used: 40, size: 100 },
            tokenUsage: {
              source: "prompt_response",
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
            tools: { totalToolCallCount: 1 },
          },
        }, {
          turn: 2,
          summary: {
            tokenUsage: {
              source: "usage_update",
              inputTokens: 20,
              outputTokens: 3,
              totalTokens: 23,
            },
            tools: { totalToolCallCount: 0 },
          },
        }],
      },
    }, {
      id: 2,
      attemptId: "attempt-other",
      kind: "agent_attempt",
      createdAt: "2026-07-25T00:00:10.000Z",
      metadata: { sessionName: "wrong-session", turnCount: 99 },
    }];
    details.progress[0] = {
      ...details.progress[0]!,
      status: "completed",
      message: "live message",
      context: { used: 90, size: 100, updatedAt: "2026-07-25T00:00:02.000Z" },
      tokenUsage: { inputTokens: 999, totalTokens: 999 },
    };
    details.progress.push({
      nodeKey: "agent~2",
      nodeId: "agent",
      attemptId: "attempt-other",
      attemptNo: 2,
      kind: "agent",
      status: "running",
      message: "wrong progress",
      updatedAt: "2026-07-25T00:00:20.000Z",
    });

    const document = projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations: observationProjection([
        evidence(1, { finishedAt: "2026-07-25T00:00:01.500Z" }),
        evidence(2, { finishedAt: "2026-07-25T00:00:02.500Z" }),
      ]),
    });

    expect(document).toMatchObject({
      kind: "execution",
      available: true,
      summary: {
        status: "running",
        sessionName: "session-exact",
        turnCount: 2,
        message: "live message",
      },
      contextWindow: {
        used: 90,
        size: 100,
        percent: 90,
        updatedAt: "2026-07-25T00:00:02.000Z",
      },
      tokenUsage: {
        source: "usage_update",
        inputTokens: 30,
        outputTokens: 5,
        totalTokens: 35,
      },
      output: { tail: "partial response", totalBytes: 16, truncated: false },
      toolCallCount: 1,
      lastToolCalls: [{
        turn: 1,
        toolCallId: "tool-1",
        toolName: "Bash",
        status: "running",
      }],
      recentToolsIncomplete: false,
    });
    expect(document.summary.sessionName).not.toBe("wrong-session");
  });

  it("does not infer Agent execution availability from authored compact state", () => {
    const details = agentDetails();
    details.summary.agent = {
      key: "reviewer",
      availability: { context: "available", tokenUsage: "available" },
      turnCount: 3,
    };
    delete details.summary.latestAttempt;
    details.attempts = [];
    details.progress = [];

    expect(projectAgentExecution({
      details,
      cursor: { eventSequence: 0, progressVersion: 0, observationVersion: 0 },
      query: { runId: details.run.id, mode: "execution", target: "agent" },
    })).toMatchObject({
      available: false,
      reason: "not-started",
      lastToolCalls: [],
      recentToolsIncomplete: false,
    });

    details.staticNode = { ...details.staticNode!, kind: "task" };
    expect(projectAgentExecution({
      details,
      cursor: { eventSequence: 0, progressVersion: 0, observationVersion: 0 },
      query: { runId: details.run.id, mode: "execution", target: "agent" },
    })).toMatchObject({
      available: false,
      reason: "not-agent",
    });
  });

  it("prefers progress tools, deduplicates durable closed entries, and excludes post-fence activity", () => {
    const details = agentDetails();
    const entries = [
      semanticActivity(1, 1, "tool", "Read completed", {
        id: "read-v1",
        sourceSequence: 1,
        tool: {
          toolCallId: "tool-1",
          name: "Read",
          status: "completed",
          updatedAt: "2026-07-25T00:00:01.000Z",
          finishedAt: "2026-07-25T00:00:01.000Z",
        },
      }),
      semanticActivity(1, 4, "tool", "Read completed latest", {
        id: "read-v2",
        sourceSequence: 4,
        tool: {
          toolCallId: "tool-1",
          name: "Read latest",
          status: "completed",
          updatedAt: "2026-07-25T00:00:02.000Z",
          finishedAt: "2026-07-25T00:00:02.000Z",
        },
      }),
      semanticActivity(1, 2, "tool", "Write completed", {
        id: "write",
        sourceSequence: 2,
        tool: {
          toolCallId: "tool-2",
          name: "Write",
          status: "running",
          updatedAt: "2026-07-25T00:00:03.000Z",
          finishedAt: "2026-07-25T00:00:03.000Z",
        },
      }),
      semanticActivity(1, 3, "tool", "Status unavailable when segment closed", {
        id: "statusless",
        sourceSequence: 3,
        tool: {
          toolCallId: "tool-4",
          name: "Unknown",
          updatedAt: "2026-07-25T00:00:04.000Z",
        },
      }),
      semanticActivity(1, 5, "tool", "Shell completed after fence", {
        id: "post-fence",
        sourceSequence: 5,
        postFence: true,
        tool: {
          toolCallId: "tool-3",
          name: "Shell",
          status: "completed",
          updatedAt: "2026-07-25T00:00:04.000Z",
          finishedAt: "2026-07-25T00:00:04.000Z",
        },
      }),
    ];
    const observations = observationProjection([], entries, [agentCurrent(1, {
      tools: {
        active: [{
          toolCallId: "active",
          name: "Ignored active",
          status: "running",
          updatedAt: "2026-07-25T00:00:05.000Z",
        }],
        recent: {
          toolCallId: "recent",
          name: "Ignored recent",
          status: "completed",
          updatedAt: "2026-07-25T00:00:04.000Z",
        },
        omittedActive: 0,
      },
    })]);

    const document = projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations,
    });

    expect(document.lastToolCalls).toEqual([
      expect.objectContaining({ turn: 1, toolCallId: "tool-2", toolName: "Write", status: "running" }),
      expect.objectContaining({ turn: 1, toolCallId: "tool-4", toolName: "Unknown" }),
      expect.objectContaining({ turn: 1, toolCallId: "tool-1", toolName: "Bash", status: "running" }),
    ]);
    expect(document.lastToolCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: "active" }),
      expect.objectContaining({ toolCallId: "recent" }),
      expect.objectContaining({ toolCallId: "tool-3" }),
    ]));
    expect(document.recentToolsIncomplete).toBe(false);
  });

  it("uses current active tools only when exact progress is absent and never consumes current recent", () => {
    const details = agentDetails();
    details.progress = [];
    const observations = observationProjection([], [], [agentCurrent(2, {
      tools: {
        active: [{
          toolCallId: "active",
          name: "Read",
          status: "running",
          updatedAt: "2026-07-25T00:00:05.000Z",
        }],
        recent: {
          toolCallId: "recent",
          name: "Stale",
          status: "completed",
          updatedAt: "2026-07-25T00:00:04.000Z",
        },
        omittedActive: 0,
      },
    })]);

    const document = projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations,
    });

    expect(document.lastToolCalls).toEqual([{
      turn: 2,
      toolCallId: "active",
      toolName: "Read",
      status: "running",
    }]);
    expect(document.recentToolsIncomplete).toBe(false);
  });

  it("reports tool recency as complete when the latest three are known despite older retained entries", () => {
    const details = agentDetails();
    details.progress[0]!.tools = {
      turn: 2,
      totalToolCallCount: 8,
      lastCalls: ["a", "b", "c"].map((toolCallId, index) => ({
        toolCallId,
        toolName: `Tool ${toolCallId}`,
        status: "completed",
        updatedAt: `2026-07-25T00:00:0${index + 1}.000Z`,
      })),
    };
    const observations: AgentObservationInspectionProjection = {
      ...observationProjection([]),
      olderEntryCount: 5,
      hasOlderEntries: true,
      retentionOmittedBefore: 2,
      omittedTurnEvidence: true,
    };

    const document = projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations,
    });

    expect(document.lastToolCalls).toHaveLength(3);
    expect(document.toolCallCount).toBe(8);
    expect(document.recentToolsIncomplete).toBe(false);
  });

  it("distinguishes authoritative zero tools from older history that obscures the latest three", () => {
    const noTools = agentDetails();
    noTools.progress = [];
    noTools.executionMetadata = [{
      id: 1,
      attemptId: "attempt-1",
      kind: "agent_attempt",
      createdAt: "2026-07-25T00:00:03.000Z",
      metadata: {
        turns: [{ turn: 1, summary: { tools: { totalToolCallCount: 0 } } }],
      },
    }];
    expect(projectAgentExecution({
      details: noTools,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: noTools.run.id, mode: "execution", target: "attempt-1" },
    })).toMatchObject({
      toolCallCount: 0,
      lastToolCalls: [],
      recentToolsIncomplete: false,
    });

    const obscured = agentDetails();
    obscured.progress = [];
    const entries = ["a", "b"].map((toolCallId, index) =>
      semanticActivity(1, index + 1, "tool", `${toolCallId} closed`, {
        tool: {
          toolCallId,
          name: `Tool ${toolCallId}`,
          updatedAt: `2026-07-25T00:00:0${index + 1}.000Z`,
        },
      }));
    const observations = {
      ...observationProjection([], entries),
      olderEntryCount: 4,
      hasOlderEntries: true,
    };
    expect(projectAgentExecution({
      details: obscured,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: obscured.run.id, mode: "execution", target: "attempt-1" },
      observations,
    })).toMatchObject({
      lastToolCalls: [expect.objectContaining({ toolCallId: "a" }), expect.objectContaining({ toolCallId: "b" })],
      recentToolsIncomplete: true,
    });
  });

  it("does not treat a later zero-tool progress turn as attempt-wide completeness", () => {
    const details = agentDetails();
    details.executionMetadata = [];
    details.progress[0]!.tools = {
      turn: 2,
      totalToolCallCount: 0,
      lastCalls: [],
    };
    const observations = {
      ...observationProjection([]),
      olderEntryCount: 1,
      hasOlderEntries: true,
    };

    expect(projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations,
    })).toMatchObject({
      toolCallCount: 0,
      lastToolCalls: [],
      recentToolsIncomplete: true,
    });
  });

  it("excludes post-fence current and entry turns from the execution turn count", () => {
    const details = agentDetails();
    details.progress = [];
    details.executionMetadata = [{
      id: 1,
      attemptId: "attempt-1",
      kind: "agent_attempt",
      metadata: {},
      createdAt: "2026-07-25T00:00:10.000Z",
    }];
    const postFenceEntry = semanticActivity(9, 1, "response", "late", { postFence: true });
    const observations = observationProjection(
      [evidence(2, {
        fencedAt: "2026-07-25T00:00:03.000Z",
        finishedAt: "2026-07-25T00:00:09.000Z",
      })],
      [postFenceEntry],
      [agentCurrent(8, { postFence: true })],
    );

    const document = projectAgentExecution({
      details,
      cursor: { eventSequence: 4, progressVersion: 2, observationVersion: 9 },
      query: { runId: details.run.id, mode: "execution", target: "attempt-1" },
      observations,
    });

    expect(document.summary.turnCount).toBe(2);
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
        output: { tail: "partial response", totalBytes: 16, truncated: false },
        context: { used: 90, size: 100 },
        tools: {
          turn: 1,
          totalToolCallCount: 1,
          lastCalls: [{
            toolCallId: "tool-1",
            toolName: "Bash",
            status: "running",
            updatedAt: "2026-07-25T00:00:01.000Z",
          }],
        },
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
    },
  };
}

function agentDetails(): RunInspectionTargetDetailsDocument {
  const run = agentRun();
  return {
    schemaVersion: 2,
    kind: "details",
    revision: "opaque" as RunInspectionRevision,
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      workflowEntry: run.workflowEntry,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      execution: run.execution,
    },
    target: { kind: "attempt", id: "attempt-1" },
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

function observationProjection(
  turns: AgentObservationTurnEvidence[],
  entries: AgentObservationInspectionProjection["entries"] = [],
  currents: AgentObservationInspectionProjection["currents"] = [],
): AgentObservationInspectionProjection {
  const versions = entries.map(entry => entry.observationVersion);
  return {
    version: 9,
    ...(versions.length > 0 ? { latestRelevantVersion: Math.max(...versions) } : {}),
    turns,
    currents,
    entries,
    retentionOmittedBefore: 0,
    olderEntryCount: 0,
    hasOlderEntries: false,
    ...(versions.length === 0
      ? {}
      : { oldestObservationVersion: Math.min(...versions) }),
  };
}

function evidence(
  turn: number,
  overrides: Partial<AgentObservationTurnEvidence> = {},
): AgentObservationTurnEvidence {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    nodeKey: "agent~1",
    nodeId: "agent",
    attemptNo: 1,
    turn,
    promptKind: "task",
    relativePath: `evidence/agents/attempt-1/turn-${String(turn).padStart(3, "0")}.evidence.jsonl`,
    state: "recording",
    completeness: "complete",
    gapCount: 0,
    eventCount: 1,
    unknownEventCount: 0,
    promptBytes: 12,
    promptDigest: `prompt-${turn}`,
    lastResponseBytes: 0,
    lastResponseDigest: `response-${turn}`,
    startedAt: `2026-07-25T00:00:${String(turn).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function semanticActivity(
  turn: number,
  observationVersion: number,
  channel: "response" | "reported-thought" | "plan" | "tool",
  text: string,
  overrides: Partial<Extract<AgentObservationInspectionProjection["entries"][number], { kind: "activity" }>> = {},
): Extract<AgentObservationInspectionProjection["entries"][number], { kind: "activity" }> {
  const sourceSequence = overrides.sourceSequence ?? observationVersion;
  const at = new Date(Date.parse("2026-07-25T00:00:00.000Z") + turn * 1_000 + sourceSequence).toISOString();
  return {
    observationVersion,
    id: overrides.id ?? `activity:attempt-1:${turn}:${sourceSequence}:${channel}`,
    attemptId: "attempt-1",
    turn,
    sourceSequence,
    at: overrides.at ?? at,
    kind: "activity",
    channel,
    summary: inspectionExcerpt(text, 512, channel === "response" ? "tail" : "head"),
    ...overrides,
  };
}

function agentCurrent(
  turn: number,
  overrides: Partial<AgentObservationInspectionProjection["currents"][number]> = {},
): AgentObservationInspectionProjection["currents"][number] {
  return {
    attemptId: "attempt-1",
    turn,
    promptKind: "task",
    phase: "starting",
    updatedAt: `2026-07-25T00:00:${String(turn).padStart(2, "0")}.000Z`,
    state: "recording",
    completeness: "complete",
    gaps: 0,
    ...overrides,
  };
}
