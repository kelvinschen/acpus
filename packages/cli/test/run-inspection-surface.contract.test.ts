import { describe, expect, it } from "vitest";
import type {
  RunInspectionCandidatesDocument,
  RunInspectionEvidenceCandidatesDocument,
  RunInspectionEvidenceDocument,
  RunInspectionItem,
  RunInspectionSnapshot,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
  RunInspectionTimelineEntry,
} from "@acpus/runtime";
import {
  formatInspectionCandidates,
  formatRunInspectionDocument,
  formatRunInspectionHeader,
  formatRunInspectionTimelineEntry,
} from "../src/run-inspection-surface.js";

describe("Inspection v2 text surface", () => {
  it("renders a compact target decision summary with available operations", () => {
    const text = formatRunInspectionDocument(targetSummary());

    expect(text).toBe([
      "Run run_1  running",
      "Target review  @1a2b3c4d5e6f  agent",
      "State running  2s",
      "Pulse tool  turn=1  Bash: rg src",
      "Attention awaiting_input  Operator input required",
      "Available operations:",
      "  Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline",
      "",
    ].join("\n"));
    expect(text).not.toContain("instances");
    expect(text).not.toContain("\nInput:");
    expect(text).not.toContain("\nOutput:");
  });

  it("renders candidate pages with short refs and one shell-safe next command", () => {
    const document: RunInspectionCandidatesDocument = {
      schemaVersion: 2,
      kind: "candidates",
      run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:02.000Z" },
      target: "review batch's [界]",
      candidates: {
        entries: [
          {
            ref: "@1a2b3c4d5e6f",
            status: "running",
            breadcrumb: "batch[0] › review",
            kind: "dynamic-node",
          },
          {
            ref: "@6f5e4d3c2b1a",
            status: "completed",
            breadcrumb: "batch[1] › review",
            kind: "dynamic-node",
          },
        ],
        page: 1,
        limit: 2,
        total: 4,
        hasMore: true,
        nextPage: 2,
      },
    };

    expect(formatRunInspectionDocument(document)).toBe([
      "Run run_1  running",
      "Target review batch's [界]  matches=4",
      "  ⠋ @1a2b3c4d5e6f  batch[0] › review  dynamic-node",
      "  ✓ @6f5e4d3c2b1a  batch[1] › review  dynamic-node",
      "Select: acpus runs inspect run_1 --target @ref",
      "Next: acpus runs inspect run_1 --target 'review batch'\\''s [界]' --limit 2 --page 2",
      "",
    ].join("\n"));
  });

  it("retains the requested inspection view in candidate handoff commands", () => {
    const document: RunInspectionCandidatesDocument = {
      schemaVersion: 2,
      kind: "candidates",
      run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:02.000Z" },
      target: "review",
      candidates: {
        entries: [],
        page: 1,
        limit: 5,
        total: 6,
        hasMore: true,
        nextPage: 2,
      },
    };

    const timeline = formatInspectionCandidates(document, { timeline: true });
    expect(timeline).toContain("Select: acpus runs inspect run_1 --target @ref --timeline");
    expect(timeline).toContain("Next: acpus runs inspect run_1 --target review --timeline --limit 5 --page 2");

    const evidence = formatInspectionCandidates(document, { evidence: true });
    expect(evidence).toContain("Select: acpus runs inspect run_1 --target @ref --evidence");
    expect(evidence).toContain("Next: acpus runs inspect run_1 --target review --evidence --limit 5 --page 2");

    const scoped = formatInspectionCandidates(document, { all: true, controls: true });
    expect(scoped).toContain("Select: acpus runs inspect run_1 --target @ref --all --controls");
    expect(scoped).toContain("Next: acpus runs inspect run_1 --target review --all --controls --limit 5 --page 2");
  });

  it("carries active Agent pulse on its Tree row without resource or age telemetry", () => {
    const text = formatRunInspectionDocument(overview());
    const header = formatRunInspectionHeader({
      ...overview().run,
      agentUsage: { instances: 2, attempts: 3, turns: 7 },
    });

    expect(text).toContain("Tree:\n┌─ ⠋ review · agent(observer) · @1a2b3c4d5e6f · running · turn 3 · ⠋ Bash: rg src");
    expect(text).toContain("Counts total=1  running=1");
    expect(text).not.toContain("Active:");
    expect(header).not.toContain("Agent usage");
    expect(text).not.toContain("Agent usage");
    expect(text).not.toContain("Context");
    expect(text).not.toContain("Tokens");
    expect(text).not.toContain("updated");
    expect(text).not.toContain("no update yet");
  });

  it("keeps every distinct active leaf in Tree without an Active summary", () => {
    const document = overview();
    document.counts = { total: 5, starting: 1, running: 4 };
    document.items = Array.from({ length: 5 }, (_, index) => ({
      key: `work~${index}`,
      role: "instance",
      path: [`work[${index}]`],
      label: `work${index}`,
      kind: "task",
      status: "running",
      nodeId: "work",
      nodeKey: `work~${index}`,
    }));

    const text = formatRunInspectionDocument(document);

    expect(text).toContain([
      "┌─ ⠋ work0 · task · running",
      "├─ ⠋ work1 · task · running",
      "├─ ⠋ work2 · task · running",
      "├─ ⠋ work3 · task · running",
      "└─ ⠋ work4 · task · running",
    ].join("\n"));
    expect(text).not.toContain("Active:");
  });

  it("renders a semantic fanout fold with only its owner ref and scoped expansion", () => {
    const text = formatRunInspectionDocument(fanoutOverview("awaiting"));

    expect(text).toContain("┌─ ⠋ batch · fanout · @batch");
    expect(text).toContain("└┄ … item[0–3] ×4 · ⏳ · awaiting");
    expect(text).toContain("Expand: acpus runs inspect run_1 --target @batch --all");
    expect(text).not.toContain("@context-0");
    expect(text).not.toContain("@child-0");
    expect(text).not.toContain("Signal: acpus runs signal run_1 --target @child-0");
  });

  it("uses an authored static owner selector for folded Tree and Attention expansion", () => {
    const document = fanoutOverview("awaiting");
    const { ref: _ref, nodeKey: _nodeKey, ...staticOwner } = document.items[0]!;
    document.items[0] = {
      ...staticOwner,
      role: "static",
    };

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("batch · fanout · batch");
    expect(text).toContain("Expand: acpus runs inspect run_1 --target batch --all");
  });

  it("keeps singleton Signal actionable but shows failed work as diagnosis, not Retry or Fork", () => {
    const waiting = overview();
    waiting.items[0] = {
      ...waiting.items[0]!,
      kind: "signal",
      status: "awaiting",
      signal: { target: "raw-signal", schemaSummary: "{ approved: boolean }" },
    };
    waiting.counts = { total: 1, awaiting: 1 };
    expect(formatRunInspectionDocument(waiting)).toContain(
      "Signal: acpus runs signal run_1 --target @1a2b3c4d5e6f --payload '<json>'",
    );

    const failed = overview();
    failed.items[0] = {
      ...failed.items[0]!,
      status: "failed",
      failure: { origin: "task", message: "review failed" },
    };
    failed.counts = { total: 1, failed: 1 };
    failed.availableActions = [];
    const failedText = formatRunInspectionDocument(failed);
    expect(failedText).toContain("Error (task): review failed");
    expect(failedText).not.toContain("Retry:");
    expect(failedText).not.toContain("Fork:");
  });

  it("labels explicit target controls as runtime-approved capability rather than recommendation", () => {
    const text = formatRunInspectionDocument(targetSummary({
      availableActions: [
        { kind: "inspect-timeline", target: "@1a2b3c4d5e6f" },
        { kind: "retry", target: "@1a2b3c4d5e6f" },
        { kind: "cancel", target: "@1a2b3c4d5e6f" },
        { kind: "steer", target: "@1a2b3c4d5e6f#1" },
      ],
    }));

    expect(text).toContain([
      "Available operations:",
      "  Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline",
      "Controls (runtime-approved capability; not a recommendation):",
      "  Retry: acpus runs retry run_1 --target @1a2b3c4d5e6f",
      "  Cancel: acpus runs cancel run_1 --target @1a2b3c4d5e6f",
      "  Steer: acpus runs steer run_1 --target '@1a2b3c4d5e6f#1' --instruction '<correction>'",
    ].join("\n"));
  });

  it("renders singleton overview controls only when Runtime projects capability actions", () => {
    const document = overview();
    document.availableActions = [
      { kind: "retry", itemKey: document.items[0]!.key, target: "raw-retry" },
      { kind: "cancel", itemKey: document.items[0]!.key, target: "raw-cancel" },
      { kind: "steer", itemKey: document.items[0]!.key, target: "raw-steer" },
    ];

    const text = formatRunInspectionDocument(document);

    expect(text).toContain([
      "Controls (runtime-approved capability; not a recommendation):",
      "  review  @1a2b3c4d5e6f",
      "     Retry: acpus runs retry run_1 --target @1a2b3c4d5e6f",
      "     Cancel: acpus runs cancel run_1 --target @1a2b3c4d5e6f",
      "     Steer: acpus runs steer run_1 --target '@1a2b3c4d5e6f#1' --instruction '<correction>'",
    ].join("\n"));
  });

  it("renders folded controls as owner-scoped expansion, never a representative command", () => {
    const document = fanoutOverview("failed");
    document.availableActions = Array.from({ length: 4 }, (_, index) => ({
      kind: "retry" as const,
      itemKey: `child-${index}`,
      target: `raw-retry-${index}`,
    }));

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("Controls (runtime-approved capability; not a recommendation):");
    expect(text).toContain("  item[0–3] ×4\n     Expand: acpus runs inspect run_1 --target @batch --all");
    expect(text).not.toContain("Retry: acpus runs retry run_1 --target @child-0");
  });

  it("renders the Run failure once while preserving an independently visible child problem", () => {
    const document = fanoutOverview("failed");
    document.run.failure = { origin: "runtime", message: "run-level failure" };
    for (const item of document.items) {
      if (item.kind === "agent") item.failure = { origin: "task", message: "child failure" };
    }
    const text = formatRunInspectionDocument(document);

    expect(text.match(/run-level failure/g)).toHaveLength(1);
    expect(text.match(/child failure/g)).toHaveLength(1);
  });

  it("reports degraded visibility in its self-contained view", () => {
    const document = targetSummary({
      visibility: { state: "degraded", reason: "observation-gap" },
    });

    expect(formatRunInspectionDocument(document)).toContain(
      "Visibility degraded/observation-gap  Inspection may be incomplete; Agent execution health is unknown.",
    );
  });

  it("shows bounded evidence metadata only through the explicit Evidence document", () => {
    const document = evidence();
    document.evidence = {
      ...document.evidence,
      directory: "/private/runtime/runs/run_1/evidence/agents/attempt_1",
      state: "sealed",
      completeness: "complete",
      turnCount: 3,
      gapCount: 0,
      providerOutcome: "completed",
      schedulerDisposition: "discarded",
      dispositionReason: "operator_steered",
      records: {
        entries: [
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
        page: 1,
        limit: 12,
        total: 2,
        hasMore: false,
      },
    };

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("Evidence sealed/complete  turns=3  gaps=0  scheduler=discarded/operator_steered  provider=completed");
    expect(text).toContain("turn-001.jsonl  prompt=task/88B/sha256:first  durable=400B  fence=350B  final=510B");
    expect(text).toContain("trace=partial/turn-001.trace.jsonl.partial/12345B");
    expect(text).not.toContain("<steering>");
    expect(text).not.toContain("steerId");
  });

  it("keeps exact Evidence operands when distinct state exceeds the soft envelope", () => {
    const long = "e".repeat(480);
    const document = evidence();
    document.evidence = {
      ...document.evidence,
        directory: `/${long}`,
        state: "sealed",
        completeness: "complete",
        turnCount: 2,
        gapCount: 0,
        providerOutcome: "completed",
        schedulerDisposition: "pending",
        records: {
          entries: [1, 2].map(turn => ({
            turn,
            file: `${long}-${turn}.jsonl`,
            prompt: { kind: "task", bytes: 480, digest: long },
            lastDurableResponseBytes: 480,
          })),
          page: 1,
          limit: 12,
          total: 2,
          hasMore: false,
        },
    };
    const text = formatRunInspectionDocument(document);

    expect(Buffer.byteLength(text)).toBeGreaterThan(1_536);
    expect(text).toContain(`  Directory: /${long}`);
    expect(text).toContain(`${long}-2.jsonl  prompt=task/480B/${long}`);
    expect(text).toContain("Evidence review  @1a2b3c4d5e6f#1");
    expect(text).not.toContain("Controls (runtime-approved capability; not a recommendation):");
  });

  it("renders exact-attempt Evidence candidates and preserves evidence paging", () => {
    const document: RunInspectionEvidenceCandidatesDocument = {
      schemaVersion: 2,
      kind: "evidence-candidates",
      run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:02.000Z" },
      target: "review batch",
      candidates: {
        entries: [{ target: "@1a2b3c4d5e6f#2", attemptNo: 2, status: "running", breadcrumb: "batch[0] › review" }],
        page: 1,
        limit: 5,
        total: 6,
        hasMore: true,
        nextPage: 2,
      },
    };

    const text = formatRunInspectionDocument(document);

    expect(text).toContain("Evidence review batch  matches=6");
    expect(text).toContain("@1a2b3c4d5e6f#2  attempt=2");
    expect(text).toContain("Select: acpus runs inspect run_1 --target '@ref#N' --evidence");
    expect(text).toContain("Next: acpus runs inspect run_1 --target 'review batch' --evidence --limit 5 --page 2");
  });

  it("renders one unified Timeline with current activity and closed semantic history", () => {
    const text = formatRunInspectionDocument(timeline());

    expect(text).toContain("Timeline review  @1a2b3c4d5e6f  running");
    expect(text).toContain("Current:\n  tool  attempt=2  turn=2/steer");
    expect(text).toContain("Response: checking the requested sources");
    expect(text).toContain("Plan: verify citations then revise");
    expect(text).toContain("Tool: Read running in=report.md");
    expect(text).toContain("Recent:\n  2026-07-25T00:00:01.000Z  response  attempt=1  turn=1  draft response");
    expect(text).toContain("steered  attempt=1  response-at-fence=240B");
    expect(text).toContain("response  attempt=1  turn=1  post-fence/discarded  late discarded output");
    expect(text).toContain(
      "Older: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline --limit 5 --page 2",
    );
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

  it("formats standalone semantic Timeline entries without a replayed document", () => {
    const phase = {
      id: "private-timeline-entry",
      kind: "phase",
      at: "2026-07-25T00:00:03.000Z",
      attemptNo: 2,
      turn: 3,
      phase: "tool",
    } as unknown as RunInspectionTimelineEntry;
    const restored = {
      id: "private-timeline-entry-2",
      kind: "visibility",
      at: "2026-07-25T00:00:04.000Z",
      state: "restored",
    } as unknown as RunInspectionTimelineEntry;

    expect(formatRunInspectionTimelineEntry(phase)).toBe(
      "Timeline: 2026-07-25T00:00:03.000Z  phase tool  attempt=2  turn=3\n",
    );
    expect(formatRunInspectionTimelineEntry(restored)).toBe(
      "Timeline: 2026-07-25T00:00:04.000Z  Visibility restored\n",
    );
  });

  it("renders Timeline and Follow as separate copyable commands", () => {
    const text = formatRunInspectionDocument(targetSummary({
      availableActions: [
        { kind: "inspect-timeline", target: "@1a2b3c4d5e6f" },
        { kind: "follow-target", target: "@1a2b3c4d5e6f" },
      ],
    }));

    expect(text).toContain([
      "Available operations:",
      "  Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline",
      "  Follow: acpus runs inspect run_1 --target @1a2b3c4d5e6f --follow",
    ].join("\n"));
  });

});

function targetSummary(
  overrides: Partial<RunInspectionTargetSummaryDocument> = {},
): RunInspectionTargetSummaryDocument {
  return {
    schemaVersion: 2,
    kind: "target",
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-25T00:00:02.000Z",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "@1a2b3c4d5e6f",
      ref: "@1a2b3c4d5e6f",
      label: "review",
      kind: "agent",
      nodeId: "review",
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
      { kind: "inspect-timeline", target: "@1a2b3c4d5e6f" },
    ],
    ...overrides,
  };
}

function evidence(): RunInspectionEvidenceDocument {
  return {
    schemaVersion: 2,
    kind: "evidence",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:02.000Z" },
    subject: {
      targetKind: "attempt",
      id: "@1a2b3c4d5e6f#1",
      ref: "@1a2b3c4d5e6f#1",
      label: "review",
      kind: "agent",
      nodeId: "review",
      attemptNo: 1,
    },
    evidence: {
      directory: "/private/runtime/runs/run_1/evidence/agents/attempt_1",
      state: "recording",
      completeness: "complete",
      turnCount: 1,
      gapCount: 0,
      schedulerDisposition: "pending",
      records: {
        entries: [],
        page: 1,
        limit: 12,
        total: 0,
        hasMore: false,
      },
    },
  };
}

function overview(): RunInspectionSnapshot {
  return {
    schemaVersion: 2,
    kind: "snapshot",
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
      ref: "@1a2b3c4d5e6f",
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

function fanoutOverview(status: RunInspectionItem["status"]): RunInspectionSnapshot {
  const document = overview();
  document.counts = { total: 4, [status === "awaiting" ? "awaiting" : "failed"]: 4 };
  document.items = [{
    key: "batch-raw",
    role: "instance",
    path: ["batch"],
    label: "batch",
    kind: "fanout",
    status: status === "awaiting" ? "running" : "failed",
    nodeId: "batch",
    nodeKey: "batch-raw",
    ref: "@batch",
  }];
  for (let index = 0; index < 4; index += 1) {
    const contextKey = `context-${index}`;
    document.items.push({
      key: contextKey,
      parentKey: "batch-raw",
      role: "context",
      path: [`batch[${index}]`],
      label: `item[${index}]`,
      kind: "fanout_item",
      status,
      nodeId: "batch",
      nodeKey: `context-raw-${index}`,
      frameKey: `frame-raw-${index}`,
      ref: `@context-${index}`,
      scope: { kind: "fanout_item", itemIndex: index, empty: false },
    });
    document.items.push({
      key: `child-${index}`,
      parentKey: contextKey,
      role: "instance",
      path: [`batch[${index}]`, "review"],
      label: "review",
      kind: status === "awaiting" ? "signal" : "agent",
      status,
      nodeId: "review",
      nodeKey: `child-raw-${index}`,
      ref: `@child-${index}`,
      ...(status === "awaiting" ? { signal: { target: `raw-signal-${index}`, schemaSummary: "{ approved: boolean }" } } : {}),
    });
  }
  return document;
}

function timeline(): RunInspectionTimelineDocument {
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-25T00:00:03.000Z",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "@1a2b3c4d5e6f",
      ref: "@1a2b3c4d5e6f",
      label: "review",
      kind: "agent",
      nodeId: "review",
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
      page: 1,
      limit: 5,
      returned: 3,
      omittedBefore: 8,
      hasOlder: true,
      olderPage: 2,
      retentionOmittedBefore: 7,
    },
  };
}
