import { describe, expect, it, vi } from "vitest";
import { approximateTokenSize } from "tokenx";
import {
  AgentTranscriptAccumulator,
  mergeAgentExecutionSummaries,
  parseAgentTranscript
} from "../src/agentTranscript.js";

vi.mock("tokenx", () => ({
  approximateTokenSize: (input: string) => {
    if (input.includes("THROW_TOKENX")) throw new Error("tokenx failed");
    return input.length;
  }
}));

describe("parseAgentTranscript", () => {
  it("counts unique tool calls and returns the last three updated tools", () => {
    const transcript = [
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "a", status: "pending", title: "Read", kind: "read" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "b", status: "pending", title: "Bash", kind: "execute" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "c", status: "pending", title: "Write", kind: "edit" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "d", status: "pending", title: "Glob", kind: "search" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", _meta: { claudeCode: { toolName: "Bash" } } } } })
    ].join("\n");

    const summary = parseAgentTranscript(transcript);
    expect(summary.toolCallCount).toBe(4);
    expect(summary.recentToolCalls.map((tool) => tool.toolCallId)).toEqual(["b", "d", "c"]);
    expect(summary.recentToolCalls[0]).toMatchObject({ title: "Bash", status: "completed", kind: "execute", toolName: "Bash" });
  });

  it("uses exact output token fields and ignores context used/size usage", () => {
    const exact = parseAgentTranscript([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 10, size: 100 } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", _meta: { usage: { input_tokens: 20, output_tokens: 7 } } } } })
    ].join("\n"));
    expect(exact.outputTokens).toBe(7);
    expect(exact.outputTokenSource).toBe("exact");

    const contextOnly = parseAgentTranscript(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 10, size: 100 } } })
    );
    expect(contextOnly.outputTokens).toBeUndefined();
    expect(contextOnly.outputTokenSource).toBe("unknown");
  });

  it("estimates output tokens from agent message chunks with tokenx", () => {
    const output = "Hello from the agent.";
    const summary = parseAgentTranscript([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from " } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the agent." } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "ignored-output", status: "completed", content: { type: "text", text: "tool output" } } } })
    ].join("\n"));

    expect(summary.outputTokens).toBe(approximateTokenSize(output));
    expect(summary.outputTokenSource).toBe("estimated");
  });

  it("does not throw when estimating unusual unicode output", () => {
    const summary = parseAgentTranscript(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\uD800\uD83D\uDC69\u200D\uD83D\uDCBB" } } } })
    );

    expect(summary.outputTokenSource === "estimated" || summary.outputTokenSource === "unknown").toBe(true);
  });

  it("falls back to unknown when tokenx estimation throws", () => {
    const summary = parseAgentTranscript(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "THROW_TOKENX" } } } })
    );

    expect(summary.outputTokens).toBeUndefined();
    expect(summary.outputTokenSource).toBe("unknown");
  });

  it("recovers partial JSON lines when more transcript bytes arrive", () => {
    const accumulator = new AgentTranscriptAccumulator();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "a", status: "pending", title: "Read" } } });

    accumulator.append(line.slice(0, 35));
    expect(accumulator.summary().toolCallCount).toBe(0);

    accumulator.append(line.slice(35) + "\n");
    expect(accumulator.summary().toolCallCount).toBe(1);
  });

  it("merges tool calls and token totals across attempts", () => {
    const first = parseAgentTranscript([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "a", status: "completed", title: "Read" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } } })
    ].join("\n"));
    const second = parseAgentTranscript([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "b", status: "completed", title: "Bash" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } } } })
    ].join("\n"));

    const merged = mergeAgentExecutionSummaries([first, second]);
    expect(merged.toolCallCount).toBe(2);
    expect(merged.recentToolCalls.map((tool) => tool.toolCallId)).toEqual(["b", "a"]);
    expect(merged.outputTokenSource).toBe("estimated");
    expect(merged.outputTokens).toBe((first.outputTokens ?? 0) + (second.outputTokens ?? 0));
  });

  it("preserves earlier tool metadata when a later attempt update omits it", () => {
    const first = parseAgentTranscript(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "same-id",
            title: "Read file",
            kind: "read",
            status: "pending",
            _meta: { claudeCode: { toolName: "Read" } }
          }
        }
      })
    );
    const second = parseAgentTranscript(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "same-id",
            status: "completed"
          }
        }
      })
    );

    const merged = mergeAgentExecutionSummaries([first, second]);
    expect(merged.toolCallCount).toBe(1);
    expect(merged.recentToolCalls[0]).toMatchObject({
      toolCallId: "same-id",
      title: "Read file",
      kind: "read",
      toolName: "Read",
      status: "completed"
    });
  });
});
