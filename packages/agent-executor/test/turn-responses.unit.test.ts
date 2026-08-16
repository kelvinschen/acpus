import type { AcpRuntimeEvent } from "acpx/runtime";
import { describe, expect, it } from "vitest";
import { createTurnResponseCollector } from "../src/turn-responses.js";

describe("turn response collection", () => {
  it("preserves exact output text independently of delta chunking", () => {
    const split = collect(output(" α\n"), output("β "));
    const joined = collect(output(" α\nβ "));

    expect(split.complete()).toEqual({ responses: [" α\nβ "], finalResponse: " α\nβ " });
    expect(joined.complete()).toEqual(split.complete());
  });

  it("treats an omitted stream as output and settles an empty turn explicitly", () => {
    expect(collect({ type: "text_delta", text: "default output" }).complete()).toEqual({
      responses: ["default output"],
      finalResponse: "default output",
    });
    expect(collect().complete()).toEqual({ responses: [], finalResponse: "" });
  });

  it("segments thought and plan without invalidating the latest candidate", () => {
    const responses = collect(
      output("first"),
      thought("reasoning"),
      output("second"),
      status("plan", "next"),
    );

    expect(responses.complete()).toEqual({ responses: ["first", "second"], finalResponse: "second" });
  });

  it("invalidates every response before a tool invocation", () => {
    expect(collect(output("before"), tool({ tag: "tool_call" }), output("after")).complete()).toEqual({
      responses: ["before", "after"],
      finalResponse: "after",
    });
    expect(collect(output("before"), tool({ tag: "tool_call" })).complete()).toEqual({
      responses: ["before"],
      finalResponse: "",
    });
    expect(collect(output("before"), tool()).complete()).toEqual({
      responses: ["before"],
      finalResponse: "",
    });
  });

  it("preserves the latest response candidate across tool updates", () => {
    const invocation = tool({ tag: "tool_call", toolCallId: "known", status: "in_progress" });
    const completion = tool({ tag: "tool_call_update", toolCallId: "known", status: "completed" });

    expect(collect(invocation, output("final"), completion).complete()).toEqual({
      responses: ["final"],
      finalResponse: "final",
    });
    expect(collect(output("candidate"), completion).complete()).toEqual({
      responses: ["candidate"],
      finalResponse: "candidate",
    });
  });

  it("lets output after a tool update become the newer response candidate", () => {
    const invocation = tool({ tag: "tool_call", toolCallId: "known", status: "in_progress" });
    const completion = tool({ tag: "tool_call_update", toolCallId: "known", status: "completed" });

    expect(collect(invocation, output("progress"), completion, output("final")).complete()).toEqual({
      responses: ["progress", "final"],
      finalResponse: "final",
    });
    expect(collect(invocation, output("candidate"), tool({ tag: "tool_call", toolCallId: "next" }), completion).complete()).toEqual({
      responses: ["candidate"],
      finalResponse: "",
    });
  });

  it("treats tools without ids or metadata and consecutive tools as boundaries", () => {
    expect(collect(output("before"), tool(), tool(), output("after")).complete()).toEqual({
      responses: ["before", "after"],
      finalResponse: "after",
    });
  });

  it("keeps usage and unknown status inside one response epoch", () => {
    expect(collect(
      output("a"),
      status("usage_update", "usage"),
      status("provider_specific", "unknown"),
      output("b"),
    ).complete()).toEqual({ responses: ["ab"], finalResponse: "ab" });
  });

  it("ignores empty output deltas and preserves non-empty whitespace", () => {
    expect(collect(output(""), output(" \n")).complete()).toEqual({
      responses: [" \n"],
      finalResponse: " \n",
    });
  });

  it("returns snapshots detached from collector state", () => {
    const collector = collect(output("first"));
    const snapshot = collector.snapshot() as string[];
    snapshot[0] = "mutated";
    snapshot.push("extra");
    collector.observe(thought("boundary"));
    collector.observe(output("second"));

    expect(collector.complete()).toEqual({ responses: ["first", "second"], finalResponse: "second" });
  });
});

function collect(...events: AcpRuntimeEvent[]) {
  const collector = createTurnResponseCollector();
  for (const event of events) collector.observe(event);
  return collector;
}

function output(text: string): AcpRuntimeEvent {
  return { type: "text_delta", stream: "output", text };
}

function thought(text: string): AcpRuntimeEvent {
  return { type: "text_delta", stream: "thought", text };
}

function status(tag: string, text: string): AcpRuntimeEvent {
  return { type: "status", tag, text };
}

function tool(overrides: Partial<Extract<AcpRuntimeEvent, { type: "tool_call" }>> = {}): AcpRuntimeEvent {
  return { type: "tool_call", text: "tool", ...overrides };
}
