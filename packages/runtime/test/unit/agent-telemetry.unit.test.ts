import { describe, expect, it } from "vitest";
import { AgentTelemetryAccumulator, upsertAgentAttemptTelemetry } from "../../src/agent-telemetry.js";

describe("AgentTelemetryAccumulator", () => {
  it("captures latest context usage, response text, stop reason, and compact tool calls", () => {
    const updates: unknown[] = [];
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt",
      inputArtifactRef: "artifact://runs/run/nodes/workflow%2Fagent/attempt-001.prompt.md",
      now: () => Date.parse("2026-06-12T10:00:00.000Z"),
      onTelemetry: (telemetry) => updates.push(telemetry)
    });

    accumulator.append([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 25293, size: 190000 } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", kind: "read", status: "in_progress" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", _meta: { claudeCode: { toolName: "Read" } } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } })
    ].join("\n") + "\n");

    expect(accumulator.responseText()).toBe("hello");
    expect(accumulator.finalStopReason()).toBe("end_turn");
    expect(accumulator.context()).toEqual({ used: 25293, size: 190000, updatedAt: "2026-06-12T10:00:00.000Z" });
    expect(accumulator.snapshot("completed", "2026-06-12T10:00:01.000Z")).toMatchObject({
      attempt: 1,
      state: "completed",
      context: { used: 25293, size: 190000 },
      input: { preview: "prompt", truncated: false },
      output: { preview: "hello", truncated: false },
      tools: {
        totalToolCallCount: 1,
        droppedToolCallCount: 0,
        recentCalls: [{ toolCallId: "read-1", title: "Read file", kind: "read", status: "completed", toolName: "Read" }]
      }
    });
    expect(updates.length).toBeGreaterThan(0);
  });

  it("keeps previews bounded when many message chunks arrive", () => {
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "x".repeat(100),
      previewEdgeBytes: 8
    });

    for (let i = 0; i < 100; i++) {
      accumulator.append(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "abcdefghij" } } }
      }) + "\n");
    }

    const output = accumulator.snapshot().output;
    expect(output?.originalBytes).toBe(1000);
    expect(output?.truncated).toBe(true);
    expect(Buffer.byteLength(output?.preview ?? "")).toBeLessThan(100);
  });

  it("does not infer tool calls from thought or message chunks", () => {
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt"
    });

    accumulator.append([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I will read packages/runtime/src/agent-telemetry.ts" } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I inspected the file." } } } })
    ].join("\n") + "\n");

    expect(accumulator.snapshot().tools).toMatchObject({
      totalToolCallCount: 0,
      droppedToolCallCount: 0,
      recentCalls: []
    });
  });

  it("keeps raw tool input and output out of compact telemetry", () => {
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt"
    });

    accumulator.append([
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "List files", kind: "search", status: "in_progress", rawInput: { large: true } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { large: true } } } })
    ].join("\n") + "\n");

    const tool = accumulator.snapshot().tools.recentCalls[0] as Record<string, unknown>;
    expect(tool).toMatchObject({ toolCallId: "call-1", title: "List files", kind: "search", status: "completed" });
    expect(tool.rawInput).toBeUndefined();
    expect(tool.rawOutput).toBeUndefined();
  });

  it("keeps total tool count accurate while retaining only recent tool calls", () => {
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt",
      maxToolCalls: 3,
      now: () => Date.parse("2026-06-12T10:00:00.000Z")
    });

    for (let i = 0; i < 5; i++) {
      accumulator.append(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", toolCallId: `tool-${i}`, title: `Tool ${i}`, status: "completed" } }
      }) + "\n");
    }

    const tools = accumulator.snapshot().tools;
    expect(tools.totalToolCallCount).toBe(5);
    expect(tools.droppedToolCallCount).toBe(2);
    expect(tools.recentCalls.map((tool) => tool.toolCallId)).toEqual(["tool-4", "tool-3", "tool-2"]);
  });

  it("upserts attempts while preserving earlier attempt history", () => {
    const first = new AgentTelemetryAccumulator({ attempt: 1, inputText: "first" }).snapshot("failed", "2026-06-12T10:00:00.000Z");
    const second = new AgentTelemetryAccumulator({ attempt: 2, inputText: "second" }).snapshot("running");

    const telemetry = upsertAgentAttemptTelemetry(upsertAgentAttemptTelemetry(undefined, first), second);

    expect(telemetry.currentAttempt).toBe(2);
    expect(telemetry.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });

  it("preserves non-zero used when acpx sends usage_update with used=0 (new API call start)", () => {
    // acpx sends used=0 at the start of every new LLM API call, then follows
    // with the real token count after the API responds. If the attempt fails
    // between the initial used=0 and the real response, we must not overwrite
    // a known measurement with 0.
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt",
      now: () => Date.parse("2026-06-12T10:00:00.000Z")
    });

    // First API call: initial allocation, then real usage
    accumulator.append(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 0, size: 200000 } }
    }) + "\n");
    expect(accumulator.context()).toEqual({ used: 0, size: 200000, updatedAt: "2026-06-12T10:00:00.000Z" });

    accumulator.append(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 40000, size: 200000 } }
    }) + "\n");
    expect(accumulator.context()?.used).toBe(40000);

    // Second API call: acpx sends used=0 again — must NOT overwrite the 40000
    accumulator.append(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 0, size: 200000 } }
    }) + "\n");
    expect(accumulator.context()?.used).toBe(40000); // preserved!
    expect(accumulator.context()?.size).toBe(200000); // size still updated

    // Real usage for the second call
    accumulator.append(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 60000, size: 200000 } }
    }) + "\n");
    expect(accumulator.context()?.used).toBe(60000); // real measurement replaces
  });

  it("allows used=0 when no prior measurement exists (first update of a session)", () => {
    const accumulator = new AgentTelemetryAccumulator({
      attempt: 1,
      inputText: "prompt",
      now: () => Date.parse("2026-06-12T10:00:00.000Z")
    });

    accumulator.append(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 0, size: 200000 } }
    }) + "\n");
    // First update with used=0 is valid — no prior measurement to preserve
    expect(accumulator.context()).toEqual({ used: 0, size: 200000, updatedAt: "2026-06-12T10:00:00.000Z" });
  });
});
