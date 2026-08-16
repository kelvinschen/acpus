import type {
  AgentTurnObservation,
  AgentTurnResult,
} from "@acpus/agent-executor";
import { describe, expect, it } from "vitest";
import { AgentObservationSemanticReducer } from "../src/observations/turn-semantics.js";

const startedAt = "2026-07-26T00:00:00.000Z";
type ObservationBase = "schemaVersion" | "sequence" | "observedAt" | "elapsedMs";
type ObservationEventInput = AgentTurnObservation["event"] extends infer Event
  ? Event extends unknown ? Omit<Event, ObservationBase> : never
  : never;

describe("Agent observation turn semantics", () => {
  it("bounds a streamed Unicode response while preserving its exact byte count", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);
    let current: ReturnType<typeof reducer.observe>["current"];
    const chunk = "🙂".repeat(100);

    for (let sequence = 0; sequence < 100; sequence += 1) {
      current = reducer.observe(observation(sequence, {
        type: "message",
        channel: "assistant",
        content: chunk,
      }), false).current;
    }

    expect(current?.response).toEqual({
      text: "🙂".repeat(384),
      originalBytes: 40_000,
      truncated: true,
    });
    expect(Buffer.byteLength(current?.response?.text ?? "")).toBe(1536);
  });

  it("merges a tool lifecycle behind one normalized, character-bounded activity", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);
    const expectedName = `${"🙂".repeat(159)}…`;

    const active = reducer.observe(observation(0, {
      type: "tool",
      action: "call",
      toolCallId: "tool-1",
      toolName: `  ${"🙂".repeat(161)}\n`,
      status: "running",
      rawInput: { query: "evidence" },
    }), false);
    const completed = reducer.observe(observation(1, {
      type: "tool",
      action: "update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { result: "passed" },
    }), false);

    expect(active.current?.tools?.active).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        name: expectedName,
        status: "running",
        input: expect.objectContaining({ text: '{"query":"evidence"}' }),
      }),
    ]);
    expect(completed.current).toMatchObject({
      phase: "between",
      tools: {
        active: [],
        recent: {
          toolCallId: "tool-1",
          name: expectedName,
          status: "completed",
          output: { text: '{"result":"passed"}' },
        },
      },
    });
    expect(completed.entries).toEqual([
      expect.objectContaining({
        id: "observation:attempt-1:1:0:tool",
        kind: "activity",
        channel: "tool",
        sourceSequence: 0,
        tool: expect.objectContaining({ name: expectedName, status: "completed" }),
      }),
    ]);
  });

  it("keeps ACP tool titles separate from stable tool names", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);

    const placeholder = reducer.observe(observation(0, {
      type: "tool",
      action: "call",
      toolCallId: "web-search",
      title: "tool call",
      status: "running",
    }), false);
    const refined = reducer.observe(observation(1, {
      type: "tool",
      action: "update",
      toolCallId: "web-search",
      title: '"ByteDance Doubao AI 100 million users 2024 2025 growth"',
      kind: "fetch",
      status: "running",
      rawInput: { query: "ByteDance Doubao AI 100 million users 2024 2025 growth" },
    }), false);
    const summarized = reducer.observe(observation(2, {
      type: "tool",
      action: "call",
      toolCallId: "search-summary",
      title: "Search something useful",
      kind: "search",
      status: "running",
    }), false);
    const retained = reducer.observe(observation(3, {
      type: "tool",
      action: "update",
      toolCallId: "search-summary",
      status: "completed",
    }), false);

    expect(placeholder.current?.tools?.active[0]).toMatchObject({ name: "Tool" });
    expect(placeholder.current?.tools?.active[0]).not.toHaveProperty("title");
    expect(refined.current?.tools?.active[0]).toMatchObject({
      name: "Fetch",
      title: '"ByteDance Doubao AI 100 million users 2024 2025 growth"',
    });
    expect(summarized.current?.tools?.active.at(-1)).toMatchObject({
      name: "Search",
      title: "Search something useful",
    });
    const retainedEntry = retained.entries[0];
    expect(retainedEntry?.kind === "activity" ? retainedEntry.tool : undefined).toMatchObject({
      name: "Search",
      title: "Search something useful",
      status: "completed",
    });
  });

  it("closes thought and plan segments when the semantic channel changes", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);

    const thought = reducer.observe(observation(0, {
      type: "message",
      channel: "thought",
      content: "Inspect evidence.",
    }), false);
    const plan = reducer.observe(observation(1, {
      type: "plan",
      value: "Run checks.",
    }), false);
    const response = reducer.observe(observation(2, {
      type: "message",
      channel: "assistant",
      content: "Done.",
    }), false);

    expect(thought.current).toMatchObject({
      phase: "thinking",
      intent: { kind: "reported-thought", excerpt: { text: "Inspect evidence." } },
    });
    expect(plan.entries).toEqual([
      expect.objectContaining({
        id: "observation:attempt-1:1:0:reported-thought",
        channel: "reported-thought",
        sourceSequence: 0,
        summary: { text: "Inspect evidence.", originalBytes: 17, truncated: false },
      }),
    ]);
    expect(plan.current).toMatchObject({
      phase: "planning",
      intent: { kind: "plan", excerpt: { text: "Run checks." } },
    });
    expect(response.entries).toEqual([
      expect.objectContaining({
        id: "observation:attempt-1:1:1:plan",
        channel: "plan",
        sourceSequence: 1,
        summary: { text: "Run checks.", originalBytes: 11, truncated: false },
      }),
    ]);
    expect(response.current).toMatchObject({
      phase: "responding",
      response: { text: "Done." },
    });
  });

  it("marks activity produced after a semantic fence without relying on timestamps", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);
    reducer.observe(observation(0, {
      type: "message",
      channel: "assistant",
      content: "before fence",
    }), false);

    const boundary = reducer.boundary(at(1));
    const late = reducer.observe(observation(1, {
      type: "message",
      channel: "assistant",
      content: " after fence",
    }), false);
    const terminal = reducer.terminal(completedTurn("before fence after fence", at(1)), false);

    expect(boundary.entries).toEqual([
      expect.objectContaining({
        channel: "response",
        summary: { text: "before fence", originalBytes: 12, truncated: false },
      }),
    ]);
    expect(boundary.entries[0]).not.toHaveProperty("postFence");
    expect(late.current).toMatchObject({
      postFence: true,
      response: { text: " after fence" },
    });
    expect(terminal.entries).toEqual([
      expect.objectContaining({
        channel: "response",
        postFence: true,
        summary: { text: " after fence", originalBytes: 12, truncated: false },
      }),
    ]);
    expect(terminal.current).toMatchObject({ phase: "settled", state: "settled", postFence: true });
  });

  it("checkpoints changed usage while preserving the completed-tool between phase", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);
    reducer.observe(observation(0, {
      type: "tool",
      action: "call",
      toolCallId: "tool-1",
      toolName: "Bash",
      status: "running",
    }), false);
    reducer.observe(observation(1, {
      type: "tool",
      action: "update",
      toolCallId: "tool-1",
      status: "completed",
    }), false);

    const unchanged = reducer.observe(observation(2, {
      type: "usage",
    }), false);
    const changed = reducer.observe(observation(3, {
      type: "usage",
      context: { used: 95, size: 100 },
      tokenUsage: { input_tokens: 90, output_tokens: 5 },
    }, diagnosticSummary()), false);

    expect(unchanged).toMatchObject({ checkpoint: false, current: undefined, entries: [] });
    expect(changed).toMatchObject({
      checkpoint: true,
      current: {
        phase: "between",
        context: { used: 95, size: 100 },
        tokenUsage: { source: "usage_update", totalTokens: 95 },
      },
    });
  });

  it("checkpoints only the first unknown event while exposing degraded completeness", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);

    const first = reducer.observe(observation(0, {
      type: "unknown",
      tag: "future_event",
      value: { value: 1 },
    }), true);
    const second = reducer.observe(observation(1, {
      type: "unknown",
      tag: "future_event",
      value: { value: 2 },
    }), true);

    expect(first).toMatchObject({ checkpoint: true, current: { completeness: "degraded" } });
    expect(second).toMatchObject({ checkpoint: false, current: { completeness: "degraded" } });
  });

  it("closes pending activity before recording an observation gap", () => {
    const reducer = createReducer();
    reducer.initialCurrent(startedAt);
    reducer.observe(observation(0, {
      type: "message",
      channel: "thought",
      content: "Partial reasoning.",
    }), false);

    const mutation = reducer.gap(at(1), 1, 3, "provider_settlement_missing");

    expect(mutation).toEqual({
      checkpoint: true,
      current: undefined,
      observedAt: at(1),
      entries: [
        expect.objectContaining({
          id: "observation:attempt-1:1:0:reported-thought",
          kind: "activity",
          sourceSequence: 0,
        }),
        {
          id: "observation:attempt-1:1:1:gap",
          kind: "gap",
          attemptId: "attempt-1",
          turn: 1,
          sourceSequence: 1,
          at: at(1),
          dropped: 3,
          reason: "provider_settlement_missing",
        },
      ],
    });
  });
});

function createReducer(): AgentObservationSemanticReducer {
  return new AgentObservationSemanticReducer({
    attemptId: "attempt-1",
    turn: 1,
    promptKind: "task",
  });
}

function observation(
  sequence: number,
  event: ObservationEventInput,
  summary: AgentTurnResult["summary"] = emptySummary(),
): AgentTurnObservation {
  const observedAt = at(sequence);
  return {
    event: {
      schemaVersion: 1,
      sequence,
      observedAt,
      elapsedMs: sequence * 1_000,
      ...event,
    } as AgentTurnObservation["event"],
    progress: { responses: [], summary, updatedAt: observedAt },
  };
}

function completedTurn(finalResponse: string, finishedAt: string): AgentTurnResult {
  return {
    status: "completed",
    responses: [finalResponse],
    finalResponse,
    stderr: "",
    summary: emptySummary(),
    timing: { startedAt, finishedAt, elapsedMs: 1_000 },
  };
}

function emptySummary(): AgentTurnResult["summary"] {
  return {
    eventCount: 0,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

function diagnosticSummary(): AgentTurnResult["summary"] {
  return {
    eventCount: 1,
    availability: { context: "available", tokenUsage: "available" },
    context: {
      used: 95,
      size: 100,
      updatedAt: at(3),
    },
    tokenUsage: {
      source: "usage_update",
      inputTokens: 90,
      outputTokens: 5,
      totalTokens: 95,
    },
    tools: { totalToolCallCount: 1, calls: [] },
  };
}

function at(sequence: number): string {
  return `2026-07-26T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}
