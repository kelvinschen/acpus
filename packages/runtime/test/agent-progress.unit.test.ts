import type {
  AgentToolCallSummary,
  AgentTurnObservation,
  AgentTurnProgress,
  AgentTurnResult,
  AgentTurnSummary,
} from "@acpus/agent-executor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentProgressTurn } from "../src/progress/agent.js";
import type { NodeProgressWriter } from "../src/progress/writer.js";
import type { WriteNodeProgressInput } from "../src/store/store.js";

const observedAt = "2026-07-01T00:00:00.000Z";
type ObservationBase = "schemaVersion" | "sequence" | "observedAt" | "elapsedMs";
type WithoutObservationBase<T> = T extends unknown ? Omit<T, ObservationBase> : never;
type ObservationEventInput = WithoutObservationBase<AgentTurnObservation["event"]>;

describe("Agent progress turn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("projects the latest bounded observation channels and three latest tools", () => {
    const writes: WriteNodeProgressInput[] = [];
    const reporter = progressTurn(recordingWriter(writes));
    const tools = [1, 2, 3, 4].map(toolCall);
    const current = progress("working", {
      context: { used: 90, size: 200, updatedAt: observedAt },
      tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      tools: { totalToolCallCount: 4, calls: tools },
    });

    reporter.callbacks.onObservation(observation({
      type: "plan",
      value: "Run the focused test.",
    }, current));
    reporter.callbacks.onObservation(observation({
      type: "message",
      channel: "thought",
      content: "Inspect the resulting diff.",
    }, current, 1));
    reporter.callbacks.onObservation(observation({
      type: "tool",
      action: "update",
      toolCallId: "tool-4",
      status: "running",
      rawOutput: "4 tests passed",
      content: "fallback output",
    }, current, 2));
    reporter.callbacks.onObservation(observation({
      type: "tool",
      action: "update",
      toolCallId: "tool-4",
      status: "running",
    }, current, 3));
    reporter.callbacks.onProgress(current);

    expect(writes).toEqual([{
      runId: "run_1",
      nodeKey: "review.dynamic",
      nodeId: "review",
      attemptId: "attempt_1",
      attemptNo: 2,
      ownerEpoch: 3,
      kind: "agent",
      status: "running",
      message: "turn 1",
      output: { tail: "working", totalBytes: 7, truncated: false },
      context: { used: 90, size: 200, updatedAt: observedAt },
      tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      tools: {
        turn: 1,
        totalToolCallCount: 4,
        lastCalls: [
          projectedToolCall(tools[1]!),
          projectedToolCall(tools[2]!),
          { ...projectedToolCall(tools[3]!), output: "4 tests passed" },
        ],
      },
      intent: {
        kind: "reported-thought",
        value: "Inspect the resulting diff.",
        updatedAt: observedAt,
      },
    }]);
  });

  it("throttles response-only changes until the exact interval while flushing semantic changes", () => {
    const writes: WriteNodeProgressInput[] = [];
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const reporter = progressTurn(recordingWriter(writes));

    reporter.callbacks.onProgress(progress("one"));
    now = 999;
    reporter.callbacks.onProgress(progress("two"));
    expect(writes.map(write => write.output?.tail)).toEqual(["one"]);

    now = 1_000;
    reporter.callbacks.onProgress(progress("three"));
    expect(writes.map(write => write.output?.tail)).toEqual(["one", "three"]);

    now = 1_001;
    reporter.callbacks.onProgress(progress("four", {
      context: { used: 1, size: 10, updatedAt: observedAt },
    }));
    expect(writes.map(write => write.output?.tail)).toEqual(["one", "three", "four"]);

    reporter.callbacks.onObservation(observation({
      type: "tool",
      action: "update",
      toolCallId: "tool-1",
      rawOutput: "done",
    }, progress("five", { tools: { totalToolCallCount: 1, calls: [toolCall(1)] } })));
    reporter.callbacks.onProgress(progress("five", { tools: { totalToolCallCount: 1, calls: [toolCall(1)] } }));
    expect(writes.at(-1)).toMatchObject({
      output: { tail: "five" },
      tools: { lastCalls: [{ toolCallId: "tool-1", output: "done" }] },
    });
  });

  it("publishes terminal state immediately from the final result and stops after abort", () => {
    const writes: WriteNodeProgressInput[] = [];
    const controller = new AbortController();
    const reporter = progressTurn(recordingWriter(writes), { signal: controller.signal });
    const running = progress("partial");
    reporter.callbacks.onProgress(running);
    reporter.callbacks.onObservation(observation({
      type: "plan",
      value: "Finish cleanly.",
    }, running));

    reporter.publishTerminal("completed", completedResult("final"), "accepted");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      status: "completed",
      message: "accepted",
      output: { tail: "final", totalBytes: 5, truncated: false },
      tools: { turn: 1 },
      intent: { kind: "plan", value: "Finish cleanly." },
    });

    controller.abort();
    reporter.callbacks.onProgress(progress("late"));
    reporter.publishTerminal("cancelled", completedResult("late"));
    expect(writes).toHaveLength(2);
  });

  it("does not swallow writer failures or throttle the immediate retry", () => {
    const sentinel = new Error("progress unavailable");
    const writeNodeProgress = vi.fn(() => {
      throw sentinel;
    });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const reporter = progressTurn({ writeNodeProgress });

    expect(() => reporter.callbacks.onProgress(progress("one"))).toThrow(sentinel);
    expect(() => reporter.callbacks.onProgress(progress("two"))).toThrow(sentinel);
    expect(writeNodeProgress).toHaveBeenCalledTimes(2);
    expect(() => reporter.publishTerminal("failed", completedResult("final"))).toThrow(sentinel);
    expect(writeNodeProgress).toHaveBeenCalledTimes(3);
  });

  it("keeps response tails and observation edges on complete UTF-8 code points", () => {
    const writes: WriteNodeProgressInput[] = [];
    const reporter = progressTurn(recordingWriter(writes));
    const exactTail = `${"x".repeat(16 * 1024 - 7)}😀汉`;
    const response = `前${exactTail}`;
    const detail = `前${"y".repeat(5 * 1024)}😀汉`;
    const current = progress(response);

    reporter.callbacks.onObservation(observation({ type: "plan", value: detail }, current));
    reporter.callbacks.onProgress(current);

    expect(writes[0]?.output).toEqual({
      tail: exactTail,
      totalBytes: Buffer.byteLength(response, "utf8"),
      truncated: true,
    });
    const bounded = writes[0]?.intent && typeof writes[0].intent === "object" && !Array.isArray(writes[0].intent)
      ? writes[0].intent.value
      : undefined;
    expect(bounded).toMatchObject({
      truncated: true,
      originalBytes: Buffer.byteLength(JSON.stringify(detail), "utf8"),
    });
    if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) throw new Error("expected bounded intent");
    for (const edge of [bounded.head, bounded.tail]) {
      expect(edge).toBeTypeOf("string");
      expect(Buffer.byteLength(String(edge), "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(hasLoneSurrogate(String(edge))).toBe(false);
    }
    expect(String(bounded.tail).endsWith("😀汉\"")).toBe(true);
  });

  it("isolates observation and throttle state between repair turns", () => {
    const writes: WriteNodeProgressInput[] = [];
    vi.spyOn(Date, "now").mockReturnValue(0);
    const writer = recordingWriter(writes);
    const first = progressTurn(writer);
    const firstProgress = progress("first", { tools: { totalToolCallCount: 1, calls: [toolCall(1)] } });
    first.callbacks.onObservation(observation({ type: "plan", value: "First plan" }, firstProgress));
    first.callbacks.onObservation(observation({
      type: "tool",
      action: "update",
      toolCallId: "tool-1",
      rawOutput: "first output",
    }, firstProgress, 1));
    first.callbacks.onProgress(firstProgress);

    const second = progressTurn(writer, { turn: 2 });
    second.callbacks.onProgress(progress("second", { tools: { totalToolCallCount: 1, calls: [toolCall(1)] } }));
    second.publishTerminal("completed", completedResult(""));

    expect(writes).toHaveLength(3);
    expect(writes[1]).toEqual(expect.objectContaining({
      message: "turn 2",
      output: { tail: "second", totalBytes: 6, truncated: false },
      tools: { turn: 2, totalToolCallCount: 1, lastCalls: [projectedToolCall(toolCall(1))] },
    }));
    expect(writes[1]).not.toHaveProperty("intent");
    expect(writes[2]).toEqual(expect.objectContaining({
      status: "completed",
      message: "turn 2 completed",
      tools: { turn: 2, totalToolCallCount: 0, lastCalls: [] },
    }));
    expect(writes[2]).not.toHaveProperty("output");
  });
});

function progressTurn(
  writer: NodeProgressWriter,
  options: { signal?: AbortSignal; turn?: number } = {},
) {
  return createAgentProgressTurn({
    writer,
    runId: "run_1",
    nodeKey: "review.dynamic",
    nodeId: "review",
    attemptId: "attempt_1",
    attemptNo: 2,
    ownerEpoch: 3,
    turn: options.turn ?? 1,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function recordingWriter(writes: WriteNodeProgressInput[]): NodeProgressWriter {
  return { writeNodeProgress: input => writes.push(input) };
}

function progress(responseText: string, overrides: Partial<AgentTurnSummary> = {}): AgentTurnProgress {
  return {
    responseText,
    updatedAt: observedAt,
    summary: { ...summary(), ...overrides },
  };
}

function summary(): AgentTurnSummary {
  return {
    eventCount: 0,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

function completedResult(responseText: string): AgentTurnResult {
  return {
    status: "completed",
    responseText,
    stderr: "",
    summary: summary(),
    timing: { startedAt: observedAt, finishedAt: observedAt, elapsedMs: 0 },
  };
}

function observation(
  event: ObservationEventInput,
  current: AgentTurnProgress,
  sequence = 0,
): AgentTurnObservation {
  return {
    event: {
      schemaVersion: 1,
      sequence,
      observedAt,
      elapsedMs: sequence,
      ...event,
    } as AgentTurnObservation["event"],
    progress: current,
  };
}

function toolCall(index: number): AgentToolCallSummary {
  return {
    toolCallId: `tool-${index}`,
    toolName: index === 4 ? "Bash" : "Read",
    status: index === 4 ? "running" : "completed",
    input: {
      preview: index === 4 ? "{\"cmd\":\"pnpm test\"}" : `file-${index}.ts`,
      truncated: false,
      originalBytes: 20,
      headBytes: 20,
    },
    startedAt: observedAt,
    updatedAt: observedAt,
  };
}

function projectedToolCall(call: AgentToolCallSummary) {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    status: call.status,
    inputPreview: call.input?.preview,
    startedAt: call.startedAt,
    updatedAt: call.updatedAt,
  };
}

function hasLoneSurrogate(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}
