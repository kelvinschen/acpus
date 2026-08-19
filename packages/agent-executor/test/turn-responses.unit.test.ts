import type { AcpEvent } from "@acpus/acp";
import { describe, expect, it } from "vitest";
import { createTurnResponseCollector } from "../src/turn-responses.js";

describe("turn response collection", () => {
  it("preserves exact assistant text independently of event chunking", () => {
    const split = collect(output(" α\n"), output("β "));
    const joined = collect(output(" α\nβ "));

    expect(split.complete()).toEqual({ responses: [" α\nβ "], finalResponse: " α\nβ " });
    expect(joined.complete()).toEqual(split.complete());
  });

  it("accepts only assistant text content blocks", () => {
    expect(collect(
      output("a"),
      message("assistant", { type: "image", data: "ignored" }),
      message("assistant", "plain JSON string"),
      output("b"),
    ).complete()).toEqual({ responses: ["ab"], finalResponse: "ab" });
    expect(collect().complete()).toEqual({ responses: [], finalResponse: "" });
  });

  it("segments thought and plan without invalidating the latest candidate", () => {
    const responses = collect(
      output("first"),
      thought("reasoning"),
      output("second"),
      plan([{ content: "next", status: "pending" }]),
    );

    expect(responses.complete()).toEqual({ responses: ["first", "second"], finalResponse: "second" });
  });

  it("invalidates every response before a tool invocation", () => {
    expect(collect(output("before"), tool("call"), output("after")).complete()).toEqual({
      responses: ["before", "after"],
      finalResponse: "after",
    });
    expect(collect(output("before"), tool("call")).complete()).toEqual({
      responses: ["before"],
      finalResponse: "",
    });
  });

  it("segments on tool updates without invalidating the latest candidate", () => {
    expect(collect(tool("call"), output("final"), tool("update")).complete()).toEqual({
      responses: ["final"],
      finalResponse: "final",
    });
    expect(collect(output("progress"), tool("update"), output("final")).complete()).toEqual({
      responses: ["progress", "final"],
      finalResponse: "final",
    });
  });

  it("keeps usage, session, activity, and unknown events inside one response segment", () => {
    expect(collect(
      output("a"),
      { type: "usage", context: { used: 1, size: 10 } },
      { type: "session", update: "current_mode", value: { mode: "code" } },
      { type: "activity", operation: "terminal/output" },
      { type: "unknown", name: "extension", value: { state: true } },
      output("b"),
    ).complete()).toEqual({ responses: ["ab"], finalResponse: "ab" });
  });

  it("ignores empty assistant text and preserves non-empty whitespace", () => {
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

function collect(...events: AcpEvent[]) {
  const collector = createTurnResponseCollector();
  for (const event of events) collector.observe(event);
  return collector;
}

function output(text: string): AcpEvent {
  return message("assistant", { type: "text", text });
}

function thought(text: string): AcpEvent {
  return message("thought", { type: "text", text });
}

function message(
  channel: Extract<AcpEvent, { type: "message" }>["channel"],
  content: Extract<AcpEvent, { type: "message" }>["content"],
): AcpEvent {
  return { type: "message", channel, content };
}

function plan(value: Extract<AcpEvent, { type: "plan" }>["value"]): AcpEvent {
  return { type: "plan", value };
}

function tool(action: "call" | "update"): AcpEvent {
  return { type: "tool", action, toolCallId: "tool-1" };
}
