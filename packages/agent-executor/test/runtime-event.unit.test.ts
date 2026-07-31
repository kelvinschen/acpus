import type { AcpRuntimeEvent } from "acpx/runtime";
import { describe, expect, it } from "vitest";
import { observationEventFromRuntime } from "../src/runtime-event.js";

const observedAt = "2026-07-31T00:00:00.000Z";
const clientOperationMethods = [
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
] as const;
const clientOperationStatuses = ["running", "completed", "failed"] as const;
const clientOperationEvents = clientOperationMethods.flatMap(method =>
  clientOperationStatuses.map(status => ({
    type: "status" as const,
    text: `${method} ${status} ordinary operation detail`,
  })));

describe("ACP runtime event projection", () => {
  it.each([
    { type: "status", text: "available commands updated", tag: "available_commands_update" },
    { type: "status", text: "mode updated", tag: "current_mode_update" },
    { type: "status", text: "config updated", tag: "config_option_update" },
    { type: "status", text: "session updated", tag: "session_info_update" },
    { type: "status", text: "session resumed" },
    { type: "status", text: "usage updated", tag: "usage_update" },
  ] satisfies AcpRuntimeEvent[])("omits normal status from observations: $text", event => {
    expect(observationEventFromRuntime(event, 1, observedAt, 10)).toBeUndefined();
  });

  it.each(clientOperationEvents)("omits known client operation status: $text", event => {
    expect(observationEventFromRuntime(event, 1, observedAt, 10)).toBeUndefined();
  });

  it.each([
    "session reconnect fallback: backend session missing",
    "unparsed provider warning",
    "fs/read_text_file pending ordinary operation detail",
    "fs/delete completed ordinary operation detail",
  ])("retains unknown untagged status: %s", text => {
    expect(observationEventFromRuntime(
      { type: "status", text },
      2,
      observedAt,
      20,
    )).toEqual({
      schemaVersion: 1,
      sequence: 2,
      observedAt,
      elapsedMs: 20,
      type: "unknown",
      value: text,
    });
  });

  it("projects plan status without degrading it", () => {
    expect(observationEventFromRuntime(
      { type: "status", text: "plan: inspect then edit", tag: "plan" },
      3,
      observedAt,
      30,
    )).toEqual({
      schemaVersion: 1,
      sequence: 3,
      observedAt,
      elapsedMs: 30,
      type: "plan",
      value: "plan: inspect then edit",
    });
  });

  it("projects reported usage", () => {
    expect(observationEventFromRuntime(
      { type: "status", text: "usage updated", tag: "usage_update", used: 12, size: 100 },
      4,
      observedAt,
      40,
    )).toEqual({
      schemaVersion: 1,
      sequence: 4,
      observedAt,
      elapsedMs: 40,
      type: "usage",
      context: { used: 12, size: 100 },
    });
  });

  it("projects a breakdown without context-window counters", () => {
    expect(observationEventFromRuntime(
      {
        type: "status",
        text: "usage updated",
        tag: "usage_update",
        breakdown: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 8 },
      },
      5,
      observedAt,
      50,
    )).toEqual({
      schemaVersion: 1,
      sequence: 5,
      observedAt,
      elapsedMs: 50,
      type: "usage",
      tokenUsage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 8 },
    });
  });

  it("retains a genuinely unknown status tag", () => {
    expect(observationEventFromRuntime(
      { type: "status", text: "new provider state", tag: "future_status" },
      6,
      observedAt,
      60,
    )).toEqual(expect.objectContaining({
      type: "unknown",
      tag: "future_status",
      value: "new provider state",
    }));
  });
});
