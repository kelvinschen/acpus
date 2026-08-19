import type { AcpEvent } from "@acpus/acp";
import { describe, expect, it } from "vitest";
import { observationEventFromRuntime } from "../src/runtime-event.js";

const observedAt = "2026-07-31T00:00:00.000Z";

describe("ACP event projection", () => {
  it.each([
    { type: "session", update: "available_commands", value: { commands: [] } },
    { type: "session", update: "current_mode", value: { mode: "code" } },
    { type: "session", update: "configuration", value: { option: "model" } },
    { type: "session", update: "info", value: { title: "session" } },
    { type: "activity", operation: "fs/read_text_file" },
    { type: "activity", operation: "fs/write_text_file" },
    { type: "activity", operation: "terminal/create" },
    { type: "activity", operation: "terminal/output" },
    { type: "activity", operation: "terminal/wait_for_exit" },
    { type: "activity", operation: "terminal/kill" },
    { type: "activity", operation: "terminal/release" },
  ] satisfies AcpEvent[])("omits $type events from persisted observations", event => {
    expect(observationEventFromRuntime(event, 1, observedAt, 10)).toBeUndefined();
  });

  it.each([
    { channel: "assistant" as const, content: { type: "text", text: "answer" } },
    { channel: "thought" as const, content: ["inspect", { next: true }] },
  ])("projects $channel message content", ({ channel, content }) => {
    expect(observationEventFromRuntime(
      { type: "message", channel, content, messageId: "message-1" },
      2,
      observedAt,
      20,
    )).toEqual({
      schemaVersion: 1,
      sequence: 2,
      observedAt,
      elapsedMs: 20,
      type: "message",
      channel,
      content,
    });
  });

  it("projects owned tool fields onto the observation vocabulary", () => {
    expect(observationEventFromRuntime(
      {
        type: "tool",
        action: "call",
        toolCallId: "tool-1",
        title: "Read file",
        name: "read_file",
        kind: "read",
        status: "in_progress",
        input: { path: "README.md" },
        output: { bytes: 12 },
        content: [{ type: "text", text: "contents" }],
        locations: [{ path: "README.md", line: 1 }],
      },
      3,
      observedAt,
      30,
    )).toEqual({
      schemaVersion: 1,
      sequence: 3,
      observedAt,
      elapsedMs: 30,
      type: "tool",
      action: "call",
      toolCallId: "tool-1",
      title: "Read file",
      toolName: "read_file",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "README.md" },
      rawOutput: { bytes: 12 },
      content: [{ type: "text", text: "contents" }],
      locations: [{ path: "README.md", line: 1 }],
    });
  });

  it("preserves explicit tool lifecycle actions with minimal metadata", () => {
    expect(observationEventFromRuntime(
      { type: "tool", action: "update", toolCallId: "tool-2" },
      4,
      observedAt,
      40,
    )).toEqual({
      schemaVersion: 1,
      sequence: 4,
      observedAt,
      elapsedMs: 40,
      type: "tool",
      action: "update",
      toolCallId: "tool-2",
    });
  });

  it.each([
    {
      event: { type: "usage", context: { used: 12, size: 100 } } as const,
      expected: { context: { used: 12, size: 100 } },
    },
    {
      event: {
        type: "usage",
        tokens: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 8 },
      } as const,
      expected: { tokenUsage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 8 } },
    },
  ])("projects independent usage telemetry: $expected", ({ event, expected }) => {
    expect(observationEventFromRuntime(event, 5, observedAt, 50)).toEqual({
      schemaVersion: 1,
      sequence: 5,
      observedAt,
      elapsedMs: 50,
      type: "usage",
      ...expected,
    });
  });

  it("keeps a usage event observable when only unsupported cost telemetry is present", () => {
    expect(observationEventFromRuntime(
      { type: "usage", cost: { amount: 0.01, currency: "USD" } },
      6,
      observedAt,
      60,
    )).toEqual({
      schemaVersion: 1,
      sequence: 6,
      observedAt,
      elapsedMs: 60,
      type: "usage",
    });
  });

  it("projects structured plans without degrading them", () => {
    const value = [{ content: "inspect then edit", priority: "high", status: "pending" }];
    expect(observationEventFromRuntime(
      { type: "plan", value },
      7,
      observedAt,
      70,
    )).toEqual({
      schemaVersion: 1,
      sequence: 7,
      observedAt,
      elapsedMs: 70,
      type: "plan",
      value,
    });
  });

  it("retains unknown event identity and value", () => {
    expect(observationEventFromRuntime(
      { type: "unknown", name: "provider_extension", value: { state: "new" } },
      8,
      observedAt,
      80,
    )).toEqual({
      schemaVersion: 1,
      sequence: 8,
      observedAt,
      elapsedMs: 80,
      type: "unknown",
      tag: "provider_extension",
      value: { state: "new" },
    });
  });
});
