import type { AcpEvent, AcpTurnResult } from "@acpus/acp";
import { describe, expect, it } from "vitest";
import { createAgentTurnReducer } from "../src/turn-reducer.js";

const startedAt = "2026-08-19T00:00:00.000Z";

describe("parent-owned ACP turn reduction", () => {
  it("segments exact assistant text and invalidates a pre-tool final candidate", () => {
    const reducer = reduce(output("before"), tool("call"));
    expect(reducer.snapshot().responses).toEqual(["before"]);
    expect(reducer.finalResponse()).toBe("");

    reducer.observe(envelope(3, output("after")));
    expect(reducer.snapshot().responses).toEqual(["before", "after"]);
    expect(reducer.finalResponse()).toBe("after");
  });

  it("keeps chunking, thought, plan, and tool-update boundaries deterministic", () => {
    const reducer = reduce(
      output(" α\n"),
      output("β "),
      thought("inspect"),
      output("final"),
      { type: "plan", value: [{ content: "next" }] },
      tool("update"),
    );
    expect(reducer.snapshot().responses).toEqual([" α\nβ ", "final"]);
    expect(reducer.finalResponse()).toBe("final");
  });

  it("reduces tools and usage without losing raw event count", () => {
    const reducer = reduce(
      { type: "activity", operation: "session/request_permission" },
      { type: "tool", action: "call", toolCallId: "tool-1", name: "read_file", status: "in_progress", input: { path: "README.md" } },
      { type: "usage", context: { used: 12, size: 100 }, tokens: { inputTokens: 20 } },
      { type: "tool", action: "update", toolCallId: "tool-1", status: "completed" },
    );
    const snapshot = reducer.snapshot(terminal({ outputTokens: 5, totalTokens: 25 }));

    expect(snapshot.summary).toMatchObject({
      eventCount: 4,
      stopReason: "end_turn",
      availability: { context: "available", tokenUsage: "available" },
      context: { used: 12, size: 100 },
      tokenUsage: { source: "prompt_response", outputTokens: 5, totalTokens: 25 },
      tools: {
        totalToolCallCount: 1,
        calls: [{ toolCallId: "tool-1", toolName: "read_file", status: "completed" }],
      },
    });
  });

  it("returns detached snapshots and ignores non-text assistant content", () => {
    const reducer = reduce(
      output("first"),
      { type: "message", channel: "assistant", content: { type: "image", data: "ignored" } },
    );
    const snapshot = reducer.snapshot();
    (snapshot.responses as string[])[0] = "mutated";
    reducer.observe(envelope(3, output("second")));
    expect(reducer.snapshot().responses).toEqual(["firstsecond"]);
  });
});

function reduce(...events: AcpEvent[]) {
  const reducer = createAgentTurnReducer(startedAt);
  events.forEach((event, index) => reducer.observe(envelope(index + 1, event)));
  return reducer;
}

function envelope(sequence: number, event: AcpEvent) {
  return { sequence, observedAt: `2026-08-19T00:00:0${sequence}.000Z`, elapsedMs: sequence, event };
}

function output(text: string): AcpEvent {
  return { type: "message", channel: "assistant", content: { type: "text", text } };
}

function thought(text: string): AcpEvent {
  return { type: "message", channel: "thought", content: { type: "text", text } };
}

function tool(action: "call" | "update"): AcpEvent {
  return { type: "tool", action, toolCallId: "tool-1" };
}

function terminal(usage: NonNullable<AcpTurnResult["usage"]>): AcpTurnResult {
  return { status: "completed", stopReason: "end_turn", usage };
}
