import type { AgentTurnEvent, AgentTurnSnapshot, AgentTurnSummary } from "@acpus/agent-executor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentProgressTurn } from "../src/progress/agent.js";
import type { NodeProgressWriter } from "../src/progress/writer.js";
import type { WriteNodeProgressInput } from "../src/store/store.js";

const observedAt = "2026-07-01T00:00:00.000Z";

describe("Agent progress turn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reduces raw ACP response, intent, telemetry, and tool events", () => {
    const writes: WriteNodeProgressInput[] = [];
    const reporter = progressTurn(recordingWriter(writes));

    reporter.callbacks.onEvent(event(0, { type: "plan", value: "Run the focused test." }));
    reporter.callbacks.onEvent(event(1, { type: "message", channel: "thought", content: { type: "text", text: "Inspect the diff." } }));
    reporter.callbacks.onEvent(event(2, { type: "message", channel: "assistant", content: { type: "text", text: "working" } }));
    reporter.callbacks.onEvent(event(3, { type: "usage", context: { used: 90, size: 200 }, tokens: { inputTokens: 10, outputTokens: 2 } }));
    reporter.callbacks.onEvent(event(4, { type: "tool", action: "call", toolCallId: "tool-1", name: "Bash", status: "running", output: "4 tests passed" }));

    expect(writes.at(-1)).toMatchObject({
      kind: "agent",
      status: "running",
      output: { tail: "working", totalBytes: 7, truncated: false },
      context: { used: 90, size: 200 },
      tokenUsage: { source: "usage_update", inputTokens: 10, outputTokens: 2 },
      intent: { kind: "reported-thought", value: { type: "text", text: "Inspect the diff." } },
      tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolCallId: "tool-1", toolName: "Bash", output: "4 tests passed" }] },
    });
  });

  it("throttles response-only chunks until the interval", () => {
    const writes: WriteNodeProgressInput[] = [];
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const reporter = progressTurn(recordingWriter(writes));

    reporter.callbacks.onEvent(event(0, output("one")));
    now = 999;
    reporter.callbacks.onEvent(event(1, output("two")));
    expect(writes.map(write => write.output?.tail)).toEqual(["one"]);
    now = 1_000;
    reporter.callbacks.onEvent(event(2, output("three")));
    expect(writes.map(write => write.output?.tail)).toEqual(["one", "onetwothree"]);
  });

  it("publishes the supplied parent-owned terminal snapshot and stops after abort", () => {
    const writes: WriteNodeProgressInput[] = [];
    const controller = new AbortController();
    const reporter = progressTurn(recordingWriter(writes), controller.signal);
    reporter.callbacks.onEvent(event(0, output("partial")));
    reporter.publishTerminal("completed", snapshot(["final"]), "accepted");
    expect(writes.at(-1)).toMatchObject({ status: "completed", message: "accepted", output: { tail: "final" } });
    controller.abort();
    reporter.callbacks.onEvent(event(1, output("late")));
    reporter.publishTerminal("cancelled", snapshot(["late"]));
    expect(writes).toHaveLength(2);
  });

  it("does not swallow writer failures", () => {
    const sentinel = new Error("progress unavailable");
    const reporter = progressTurn({ writeNodeProgress: () => { throw sentinel; } });
    expect(() => reporter.callbacks.onEvent(event(0, output("one")))).toThrow(sentinel);
    expect(() => reporter.publishTerminal("failed", snapshot(["final"]))).toThrow(sentinel);
  });

  it("records and clears ACP activity against the current raw-event snapshot", () => {
    const writes: WriteNodeProgressInput[] = [];
    vi.spyOn(Date, "now").mockReturnValue(0);
    const reporter = progressTurn(recordingWriter(writes));
    reporter.callbacks.onEvent(event(0, output("partial")));
    reporter.recordAcpActivity("2026-07-30T00:00:00.000Z");
    reporter.clearAcpActivity();
    expect(writes.at(-2)).toMatchObject({ output: { tail: "partial" }, acpActivityAt: "2026-07-30T00:00:00.000Z" });
    expect(writes.at(-1)).not.toHaveProperty("acpActivityAt");
  });
});

function progressTurn(writer: NodeProgressWriter, signal?: AbortSignal) {
  return createAgentProgressTurn({
    writer,
    runId: "run_1",
    nodeKey: "review.dynamic",
    nodeId: "review",
    attemptId: "attempt_1",
    attemptNo: 2,
    ownerEpoch: 3,
    turn: 1,
    ...(signal ? { signal } : {}),
  });
}

function recordingWriter(writes: WriteNodeProgressInput[]): NodeProgressWriter {
  return { writeNodeProgress: input => writes.push(input) };
}

function event(sequence: number, value: AgentTurnEvent["event"]): AgentTurnEvent {
  return { sequence, observedAt, elapsedMs: sequence, event: value };
}

function output(text: string): AgentTurnEvent["event"] {
  return { type: "message", channel: "assistant", content: { type: "text", text } };
}

function snapshot(responses: readonly string[]): AgentTurnSnapshot {
  return { responses, summary: summary(), timing: { startedAt: observedAt, finishedAt: observedAt, elapsedMs: 0 } };
}

function summary(): AgentTurnSummary {
  return { eventCount: 0, availability: { context: "unavailable", tokenUsage: "unavailable" }, tools: { totalToolCallCount: 0, calls: [] } };
}
