import { describe, expect, it } from "vitest";
import type {
  RunInspectionEmission,
  RunInspectionRevision,
  RunInspectionSnapshot,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
} from "@acpus/runtime";
import {
  applyRunInspectionUpdate,
  formatRunInspectionCheckpoint,
  formatRunInspectionDelta,
  formatRunInspectionDocument,
  formatRunInspectionHeader,
} from "../src/run-inspection-surface.js";

describe("Inspection v2 text surface", () => {
  it("renders a compact target decision summary with available operations", () => {
    const text = formatRunInspectionDocument(targetSummary());

    expect(text).toBe([
      "Run run_1  running",
      "Target review  review~abc  agent",
      "State running  2s",
      "Pulse tool  turn=1  Bash: rg src",
      "Attention awaiting_input  Operator input required",
      "Available operations:",
      "  Timeline: acpus runs inspect run_1 --target review~abc --timeline",
      "  Steer: acpus runs steer run_1 --target attempt_1 --instruction '<correction>'",
      "",
    ].join("\n"));
    expect(text).not.toContain("instances");
    expect(text).not.toContain("\nInput:");
    expect(text).not.toContain("\nOutput:");
  });

  it("keeps overview Agent activity free of resource and age telemetry", () => {
    const text = formatRunInspectionDocument(overview());
    const header = formatRunInspectionHeader({
      ...overview().run,
      agentUsage: { instances: 2, attempts: 3, turns: 7 },
    });

    expect(text).toContain("Active:\n  ⠋ review · agent(observer) · turn 3 · ⠋ Bash: rg src");
    expect(header).not.toContain("Agent usage");
    expect(text).not.toContain("Agent usage");
    expect(text).not.toContain("Context");
    expect(text).not.toContain("Tokens");
    expect(text).not.toContain("updated");
    expect(text).not.toContain("no update yet");
  });

  it("reports degraded visibility separately and makes restoration explicit", () => {
    const document = targetSummary({
      visibility: { state: "degraded", reason: "observation-gap" },
    });
    const delta: Extract<RunInspectionEmission, { kind: "delta" }> = {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [{ kind: "visibility", visibility: null }],
    };

    expect(formatRunInspectionDocument(document)).toContain(
      "Visibility degraded/observation-gap  Inspection may be incomplete; Agent execution health is unknown.",
    );
    expect(formatRunInspectionDelta(delta, document)).toBe("Visibility restored\n");
    expect(applyRunInspectionUpdate(document, delta)).not.toHaveProperty("visibility");
  });

  it("shows bounded evidence metadata without prompt or instruction bodies", () => {
    const document = targetSummary({
      evidence: {
        directory: "/private/runtime/runs/run_1/evidence/agents/attempt_1",
        state: "sealed",
        completeness: "complete",
        turnCount: 3,
        omittedTurns: 1,
        gapCount: 0,
        providerOutcome: "completed",
        schedulerDisposition: "discarded",
        dispositionReason: "operator_steered",
        records: [
          {
            turn: 1,
            file: "turn-001.jsonl",
            prompt: { kind: "task", bytes: 88, digest: "sha256:first" },
            lastDurableResponseBytes: 400,
            responseAtFenceBytes: 350,
            finalObservedResponseBytes: 510,
            trace: {
              state: "partial",
              file: "turn-001.trace.jsonl.partial",
              bytes: 12_345,
              digest: "sha256:trace",
            },
          },
          {
            turn: 3,
            file: "turn-003.jsonl",
            prompt: { kind: "repair", bytes: 90, digest: "sha256:last" },
            lastDurableResponseBytes: 120,
            finalObservedResponseBytes: 120,
          },
        ],
      },
    });

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("Evidence sealed/complete  turns=3  gaps=0  scheduler=discarded/operator_steered  provider=completed");
    expect(text).toContain("turn-001.jsonl  prompt=task/88B/sha256:first  durable=400B  fence=350B  final=510B");
    expect(text).toContain("trace=partial/turn-001.trace.jsonl.partial/12345B");
    expect(text).toContain("… 1 turns omitted");
    expect(text).not.toContain("<steering>");
    expect(text).not.toContain("steerId");
  });

  it("keeps exact Agent operations ahead of evidence when the text budget is exhausted", () => {
    const long = "e".repeat(480);
    const text = formatRunInspectionDocument(targetSummary({
      evidence: {
        directory: `/${long}`,
        state: "sealed",
        completeness: "complete",
        turnCount: 2,
        omittedTurns: 0,
        gapCount: 0,
        providerOutcome: "completed",
        schedulerDisposition: "pending",
        records: [1, 2].map(turn => ({
          turn,
          file: `${long}-${turn}.jsonl`,
          prompt: { kind: "task", bytes: 480, digest: long },
          lastDurableResponseBytes: 480,
        })),
      },
    }));

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_536);
    expect(text).toContain("Timeline: acpus runs inspect run_1 --target review~abc --timeline");
    expect(text).toContain("Steer: acpus runs steer run_1 --target attempt_1 --instruction '<correction>'");
  });

  it("renders one unified Timeline with current activity and closed semantic history", () => {
    const text = formatRunInspectionDocument(timeline());

    expect(text).toContain("Timeline review  review~abc  running");
    expect(text).toContain("Current:\n  tool  attempt=2  turn=2/steer");
    expect(text).toContain("Response: checking the requested sources");
    expect(text).toContain("Plan: verify citations then revise");
    expect(text).toContain("Tool: Read running in=report.md");
    expect(text).toContain("Recent:\n  2026-07-25T00:00:01.000Z  response  attempt=1  turn=1  draft response");
    expect(text).toContain("steered  attempt=1  response-at-fence=240B");
    expect(text).toContain("response  attempt=1  turn=1  post-fence/discarded  late discarded output");
    expect(text).toContain("… 8 older  before=page:older");
    expect(text).toContain("… 7 earlier entries expired from bounded history");
    expect(text.match(/checking the requested sources/g)).toHaveLength(1);
  });

  it("labels reported thought and automatic output repair without implying failure", () => {
    const document = timeline();
    if (document.current?.kind !== "agent") throw new Error("expected Agent current activity");
    document.current = {
      ...document.current,
      phase: "output-repair",
      intent: {
        kind: "reported-thought",
        excerpt: { text: "checking the required shape", originalBytes: 27, truncated: false },
      },
    };

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("Automatic output repair  attempt=2");
    expect(text).toContain("Reported thought: checking the required shape");
  });

  it("applies semantic deltas by upserting bounded Timeline entries", () => {
    const initial = timeline();
    const current = initial.current;
    if (current?.kind !== "agent") throw new Error("expected Agent current activity");
    const delta: Extract<RunInspectionEmission, { kind: "delta" }> = {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [
        {
          kind: "current",
          current: {
            ...current,
            phase: "settling",
            response: { text: "final response", originalBytes: 14, truncated: false },
          },
        },
        {
          kind: "recent",
          upsert: [{
            id: "activity:1",
            kind: "activity",
            at: "2026-07-25T00:00:02.000Z",
            attemptId: "attempt_1",
            turn: 1,
            channel: "response",
            summary: { text: "revised closed response", originalBytes: 23, truncated: false },
          }],
          order: initial.recent.entries.map(entry => entry.id),
          page: { ...initial.recent, retentionOmittedBefore: 8 },
        },
      ],
    };

    const updated = applyRunInspectionUpdate(initial, delta);

    expect(updated.revision).toBe("rev:2");
    expect(updated.kind).toBe("timeline");
    if (updated.kind !== "timeline") throw new Error("expected Timeline");
    expect(updated.current?.phase).toBe("settling");
    expect(updated.recent.entries).toHaveLength(3);
    expect(updated.recent.entries[0]).toMatchObject({
      id: "activity:1",
      summary: { text: "revised closed response" },
    });
    expect(formatRunInspectionDelta(delta, updated)).toContain("Current settling · attempt=2 · Read running");
    expect(formatRunInspectionDelta(delta, initial))
      .toContain("History 8 earlier entries expired from bounded history");
    expect(formatRunInspectionDelta(delta, updated))
      .not.toContain("expired from bounded history");
  });

  it("keeps the followed Timeline at the requested page limit", () => {
    const initial = timeline();
    const upsert = Array.from({ length: 4 }, (_, index) => ({
      id: `activity:${index + 3}`,
      kind: "activity" as const,
      at: `2026-07-25T00:00:0${index + 3}.000Z`,
      attemptId: "attempt_1",
      turn: 1,
      channel: "response" as const,
      summary: {
        text: `response ${index + 3}`,
        originalBytes: 10,
        truncated: false,
      },
    }));

    const updated = applyRunInspectionUpdate(initial, {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [{
        kind: "recent",
        upsert,
        order: ["activity:4", "activity:5", "activity:6"],
        page: {
          returned: 3,
          omittedBefore: initial.recent.omittedBefore + 3,
          hasOlder: true,
          olderCursor: "page:newer",
        },
      }],
    }, 3);

    if (updated.kind !== "timeline") throw new Error("expected Timeline");
    expect(updated.recent).toMatchObject({
      returned: 3,
      omittedBefore: initial.recent.omittedBefore + 3,
      hasOlder: true,
    });
    expect(updated.recent.entries.map(entry => entry.id)).toEqual([
      "activity:4",
      "activity:5",
      "activity:6",
    ]);
  });

  it("applies sparse current patches and null-clears without replacing Agent identity", () => {
    const initial = timeline();
    if (initial.current?.kind !== "agent") throw new Error("expected Agent current activity");
    const tools = initial.current.tools;

    const updated = applyRunInspectionUpdate(initial, {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [{
        kind: "current-patch",
        patch: {
          kind: "agent",
          attemptId: "attempt_2",
          attemptNo: 2,
          changes: {
            phase: "settling",
            response: null,
          },
        },
      }],
    });

    if (updated.kind !== "timeline" || updated.current?.kind !== "agent") {
      throw new Error("expected Agent Timeline");
    }
    expect(updated.current).toMatchObject({
      attemptId: initial.current.attemptId,
      turn: initial.current.turn,
      phase: "settling",
      tools,
    });
    expect(updated.current).not.toHaveProperty("response");
  });

  it("formats only the fields carried by a sparse current patch", () => {
    const initial = timeline();
    const delta: Extract<RunInspectionEmission, { kind: "delta" }> = {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [{
        kind: "current-patch",
        patch: {
          kind: "agent",
          attemptId: "attempt_2",
          attemptNo: 2,
          changes: {
            response: {
              text: "new response bytes",
              originalBytes: 18,
              truncated: false,
            },
          },
        },
      }],
    };
    const updated = applyRunInspectionUpdate(initial, delta);

    const text = formatRunInspectionDelta(delta, updated);

    expect(text).toContain("Current updated · attempt=2 · Response: new response bytes");
    expect(text).not.toContain("Read running");
    expect(text).not.toContain("updated · agent");
  });

  it("renders available-operation deltas as copyable commands", () => {
    const document = targetSummary({ availableActions: [] });
    const delta: Extract<RunInspectionEmission, { kind: "delta" }> = {
      schemaVersion: 2,
      kind: "delta",
      revision: revision("rev:2"),
      changes: [{
        kind: "available-actions",
        availableActions: [
          { kind: "retry", target: "review~abc" },
          { kind: "fork", target: "review~abc" },
        ],
      }],
    };

    expect(formatRunInspectionDelta(delta, document)).toBe([
      "Available operations:",
      "  Retry: acpus runs retry run_1 --target review~abc",
      "  Fork: acpus runs fork run_1 --target review~abc",
      "",
    ].join("\n"));
  });

  it("keeps checkpoints compact instead of replaying activity bodies", () => {
    const text = formatRunInspectionCheckpoint(timeline());

    expect(text).toBe("· checkpoint  running  review\n");
    expect(text).not.toContain("Recent:");
    expect(text).not.toContain("report.md");
  });
});

function targetSummary(
  overrides: Partial<RunInspectionTargetSummaryDocument> = {},
): RunInspectionTargetSummaryDocument {
  return {
    schemaVersion: 2,
    kind: "target",
    revision: revision("rev:1"),
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-25T00:00:02.000Z",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_1",
      attemptNo: 1,
    },
    state: {
      status: "running",
      startedAt: "2026-07-25T00:00:00.000Z",
      durationMs: 2_000,
    },
    pulse: {
      phase: "tool",
      headline: "Bash: rg src",
      turn: 1,
      updatedAt: "2026-07-25T00:00:02.000Z",
    },
    attention: {
      code: "awaiting_input",
      summary: "Operator input required",
    },
    availableActions: [
      { kind: "inspect-timeline", target: "review~abc" },
      { kind: "steer", target: "attempt_1" },
    ],
    ...overrides,
  };
}

function overview(): RunInspectionSnapshot {
  return {
    schemaVersion: 2,
    kind: "snapshot",
    revision: revision("rev:1"),
    run: {
      id: "run_1",
      name: "review",
      status: "running",
      workflowEntry: "review.workflow.ts",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:03.000Z",
      execution: { state: "active", lastStatus: "running" },
    },
    counts: { total: 1, running: 1 },
    items: [{
      key: "review~abc",
      role: "instance",
      path: ["review"],
      label: "review",
      kind: "agent",
      status: "running",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_1",
      attemptNo: 1,
      agent: {
        key: "observer",
        turn: 3,
        activeTool: { command: "Bash: rg src", status: "running" },
      },
    }],
    availableActions: [],
  };
}

function timeline(): RunInspectionTimelineDocument {
  return {
    schemaVersion: 2,
    kind: "timeline",
    revision: revision("rev:1"),
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-25T00:00:03.000Z",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_2",
      attemptNo: 2,
    },
    state: {
      status: "running",
      startedAt: "2026-07-25T00:00:00.000Z",
    },
    current: {
      kind: "agent",
      attemptId: "attempt_2",
      attemptNo: 2,
      turn: 2,
      turnKind: "steer",
      phase: "tool",
      updatedAt: "2026-07-25T00:00:03.000Z",
      response: {
        text: "checking the requested sources",
        originalBytes: 30,
        truncated: false,
      },
      intent: {
        kind: "plan",
        excerpt: {
          text: "verify citations then revise",
          originalBytes: 28,
          truncated: false,
        },
      },
      tools: {
        active: [{
          toolCallId: "tool_1",
          name: "Read",
          status: "running",
          input: { text: "report.md", originalBytes: 9, truncated: false },
          updatedAt: "2026-07-25T00:00:03.000Z",
        }],
        omittedActive: 0,
      },
    },
    recent: {
      entries: [
        {
          id: "activity:1",
          kind: "activity",
          at: "2026-07-25T00:00:01.000Z",
          attemptId: "attempt_1",
          attemptNo: 1,
          turn: 1,
          channel: "response",
          summary: { text: "draft response", originalBytes: 14, truncated: false },
        },
        {
          id: "control:2",
          kind: "control",
          at: "2026-07-25T00:00:02.000Z",
          action: "steered",
          attemptId: "attempt_1",
          attemptNo: 1,
          responseAtFenceBytes: 240,
        },
        {
          id: "activity:late",
          kind: "activity",
          at: "2026-07-25T00:00:02.500Z",
          attemptId: "attempt_1",
          attemptNo: 1,
          postFence: true,
          turn: 1,
          channel: "response",
          summary: { text: "late discarded output", originalBytes: 21, truncated: false },
        },
      ],
      returned: 3,
      omittedBefore: 8,
      hasOlder: true,
      olderCursor: "page:older",
      retentionOmittedBefore: 7,
    },
  };
}

function revision(value: string): RunInspectionRevision {
  return value as RunInspectionRevision;
}
