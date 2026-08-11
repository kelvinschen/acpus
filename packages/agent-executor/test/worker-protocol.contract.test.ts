import { describe, expect, it } from "vitest";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  isAcpWorkerParentMessage,
} from "../src/worker-protocol.js";

const parentBase = {
  protocolVersion: 4,
  workerId: "worker",
  attemptId: "attempt",
};

const childBase = {
  protocolVersion: 4,
  workerId: "worker",
  attemptId: "attempt",
};

function initialize() {
  return {
    ...parentBase,
    type: "initialize",
    sessionStateDirectory: "/tmp/sessions",
    cwd: "/tmp/workspace",
    env: { HOME: "/tmp/home" },
    agent: { kind: "named", name: "configured" },
    resolvedLaunch: "configured-acp --stdio",
    permissionMode: "approve-all",
  };
}

function runTurnRequest() {
  return {
    agent: { kind: "command", command: "agent --stdio" },
    prompt: "Review this change.",
    cwd: "/tmp/workspace",
    env: { HOME: "/tmp/home", OPTIONAL: undefined },
    sessionName: "review",
    permissionMode: "approve-reads",
    model: "model",
    config: { effort: "high" },
    timeoutMs: 1_000,
  };
}

function runTurn(request: unknown = runTurnRequest()) {
  return {
    ...parentBase,
    type: "run-turn",
    turnId: "turn",
    request,
  };
}

function summary() {
  return {
    eventCount: 2,
    availability: { context: "available", tokenUsage: "partial" },
    stopReason: "end_turn",
    context: { used: 10, size: 100, updatedAt: "2026-08-01T00:00:00.500Z" },
    tokenUsage: { source: "prompt_response", inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    tools: {
      totalToolCallCount: 1,
      calls: [{
        toolCallId: "tool-1",
        title: "Read file",
        kind: "read",
        toolName: "read_file",
        status: "completed",
        input: { preview: "README.md", truncated: false, originalBytes: 9, headBytes: 9 },
        startedAt: "2026-08-01T00:00:00.100Z",
        updatedAt: "2026-08-01T00:00:00.200Z",
        completedAt: "2026-08-01T00:00:00.200Z",
      }],
    },
    cwd: "/tmp/workspace",
    acpxRecordId: "record-1",
  };
}

function progress() {
  return {
    responses: ["working"],
    summary: summary(),
    updatedAt: "2026-08-01T00:00:00.500Z",
  };
}

function eventBase() {
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt: "2026-08-01T00:00:00.500Z",
    elapsedMs: 500,
  };
}

const observationEvents = [
  {
    name: "message",
    event: { ...eventBase(), type: "message", channel: "assistant", content: { text: ["hello", 1, true, null] }, tag: "text" },
  },
  {
    name: "tool",
    event: {
      ...eventBase(),
      type: "tool",
      action: "call",
      toolCallId: "tool-1",
      title: "Read file",
      kind: "read",
      toolName: "read_file",
      status: "running",
      rawInput: { path: "README.md" },
      rawOutput: null,
      content: ["reading"],
      locations: [{ path: "README.md", line: 1 }],
    },
  },
  {
    name: "usage",
    event: { ...eventBase(), type: "usage", context: { used: 10 }, tokenUsage: { input: 5 } },
  },
  {
    name: "plan",
    event: { ...eventBase(), type: "plan", value: [{ step: "review" }] },
  },
  {
    name: "unknown",
    event: { ...eventBase(), type: "unknown", tag: "provider_status", value: { state: "warming" } },
  },
  {
    name: "turn_end",
    event: {
      ...eventBase(),
      type: "turn_end",
      status: "failed",
      stopReason: "provider_exit",
      failure: { code: 1 },
      message: "failed",
    },
  },
] as const;

function observation(event: unknown) {
  return {
    ...childBase,
    type: "turn-observation",
    turnId: "turn",
    observation: { event, progress: progress() },
  };
}

function observationWithProgress(value: unknown) {
  return {
    ...observation(observationEvents[0].event),
    observation: { event: observationEvents[0].event, progress: value },
  };
}

function observationWithSummary(value: unknown) {
  return observationWithProgress({ ...progress(), summary: value });
}

function resultBase() {
  return {
    responses: ["intermediate", "final"],
    stderr: "",
    summary: summary(),
    timing: {
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
      elapsedMs: 1_000,
    },
  };
}

function turnResult(result: unknown) {
  return {
    ...childBase,
    type: "turn-result",
    turnId: "turn",
    result,
  };
}

describe("ACP worker protocol", () => {
  it("exposes protocol version 4", () => {
    expect(ACP_WORKER_PROTOCOL_VERSION).toBe(4);
  });

  it.each([
    { name: "initialize with a named selector and command launch", value: initialize() },
    {
      name: "initialize with a command selector and structured launch",
      value: {
        ...initialize(),
        agent: { kind: "command", command: "configured acp --stdio" },
        resolvedLaunch: ["configured acp", "--stdio"],
        model: "model",
      },
    },
    { name: "run-turn", value: runTurn() },
    { name: "abort-turn", value: { ...parentBase, type: "abort-turn", turnId: "turn", reason: "inactivity" } },
    { name: "close-attempt", value: { ...parentBase, type: "close-attempt", reason: "complete" } },
  ])("accepts the $name parent variant", ({ value }) => {
    expect(isAcpWorkerParentMessage(value)).toBe(true);
  });

  it.each([
    { name: "an unsupported parent protocol version", value: { ...initialize(), protocolVersion: 3 } },
    { name: "an extra parent field", value: { ...initialize(), private: true } },
    { name: "an extra named-selector field", value: { ...initialize(), agent: { kind: "named", name: "configured", command: "other" } } },
    { name: "an extra command-selector field", value: { ...initialize(), agent: { kind: "command", command: "agent", name: "other" } } },
    { name: "an empty resolved command", value: { ...initialize(), resolvedLaunch: "" } },
    { name: "an empty resolved argv", value: { ...initialize(), resolvedLaunch: [] } },
    { name: "an empty first resolved argv item", value: { ...initialize(), resolvedLaunch: [""] } },
    { name: "a missing resolved launch", value: { ...initialize(), resolvedLaunch: undefined } },
    { name: "an invalid environment value", value: { ...initialize(), env: { HOME: 42 } } },
    { name: "an empty run-turn request", value: runTurn({}) },
    { name: "an extra run-turn request field", value: runTurn({ ...runTurnRequest(), signal: "unexpected" }) },
    { name: "an invalid run-turn config value", value: runTurn({ ...runTurnRequest(), config: { effort: 1 } }) },
    { name: "an extra abort-turn field", value: { ...parentBase, type: "abort-turn", turnId: "turn", reason: "timeout", private: true } },
  ])("rejects $name", ({ value }) => {
    expect(isAcpWorkerParentMessage(value)).toBe(false);
  });

  it.each([
    { name: "ready", value: { ...childBase, type: "ready" } },
    { name: "acp-activity", value: { ...childBase, type: "acp-activity", turnId: "turn", observedAt: "2026-08-01T00:00:00.000Z" } },
    { name: "worker-failure", value: { ...childBase, type: "worker-failure", message: "failed" } },
    { name: "closed", value: { ...childBase, type: "closed" } },
  ])("accepts the $name child variant", ({ value }) => {
    expect(isAcpWorkerChildMessage(value)).toBe(true);
  });

  it.each(observationEvents)("accepts the $name observation event", ({ event }) => {
    expect(isAcpWorkerChildMessage(observation(event))).toBe(true);
  });

  it.each(observationEvents)("rejects an extra field on the $name observation event", ({ event }) => {
    expect(isAcpWorkerChildMessage(observation({ ...event, private: true }))).toBe(false);
  });

  it.each([
    { name: "an empty observation event", value: observation({}) },
    {
      name: "a non-JSON message value",
      value: observation({ ...eventBase(), type: "message", channel: "assistant", content: { nested: [Number.POSITIVE_INFINITY] } }),
    },
    { name: "an invalid tool action", value: observation({ ...eventBase(), type: "tool", action: "start" }) },
    { name: "an invalid turn-end status", value: observation({ ...eventBase(), type: "turn_end", status: "unknown" }) },
    {
      name: "an extra progress field",
      value: observationWithProgress({ ...progress(), private: true }),
    },
    {
      name: "an extra observation field",
      value: { ...observation(observationEvents[0].event), observation: { event: observationEvents[0].event, progress: progress(), private: true } },
    },
    {
      name: "an extra summary field",
      value: observationWithSummary({ ...summary(), private: true }),
    },
    {
      name: "an extra availability field",
      value: observationWithSummary({ ...summary(), availability: { ...summary().availability, private: true } }),
    },
    {
      name: "an extra context field",
      value: observationWithSummary({ ...summary(), context: { ...summary().context, private: true } }),
    },
    {
      name: "an extra token-usage field",
      value: observationWithSummary({ ...summary(), tokenUsage: { ...summary().tokenUsage, private: true } }),
    },
    {
      name: "an extra tools field",
      value: observationWithSummary({ ...summary(), tools: { ...summary().tools, private: true } }),
    },
    {
      name: "an empty tool call",
      value: observationWithSummary({ ...summary(), tools: { totalToolCallCount: 1, calls: [{}] } }),
    },
    {
      name: "an extra tool-call field",
      value: observationWithSummary({ ...summary(), tools: { totalToolCallCount: 1, calls: [{ ...summary().tools.calls[0], private: true }] } }),
    },
    {
      name: "an extra tool-input field",
      value: observationWithSummary({
        ...summary(),
        tools: {
          totalToolCallCount: 1,
          calls: [{
            ...summary().tools.calls[0],
            input: { ...summary().tools.calls[0]!.input, private: true },
          }],
        },
      }),
    },
  ])("rejects $name", ({ value }) => {
    expect(isAcpWorkerChildMessage(value)).toBe(false);
  });

  it.each([
    {
      name: "completed",
      result: { ...resultBase(), status: "completed", finalResponse: "final" },
    },
    {
      name: "failed",
      result: {
        ...resultBase(),
        status: "failed",
        failure: {
          kind: "inactivity_stale",
          origin: "runtime",
          retryable: true,
          message: "inactive",
          evidence: { failAfterMs: 1_000, silentForMs: 1_001, silenceStartedAt: "2026-08-01T00:00:00.000Z" },
          upstream: { source: "acpx", operation: "prompt", code: "EXIT", origin: "provider" },
        },
      },
    },
    {
      name: "cancelled",
      result: { ...resultBase(), status: "cancelled", message: "cancelled" },
    },
  ])("accepts the $name terminal result", ({ result }) => {
    expect(isAcpWorkerChildMessage(turnResult(result))).toBe(true);
  });

  it.each([
    { name: "an unsupported child protocol version", value: { ...childBase, type: "ready", protocolVersion: 3 } },
    { name: "an extra child field", value: { ...childBase, type: "ready", private: true } },
    { name: "a missing completed response", value: turnResult({ ...resultBase(), status: "completed" }) },
    {
      name: "a failed-only field on completed",
      value: turnResult({ ...resultBase(), status: "completed", finalResponse: "final", failure: { kind: "provider_exit", message: "failed" } }),
    },
    {
      name: "a completed-only field on failed",
      value: turnResult({ ...resultBase(), status: "failed", finalResponse: "stale", failure: { kind: "provider_exit", message: "failed" } }),
    },
    {
      name: "an extra timing field",
      value: turnResult({ ...resultBase(), status: "completed", finalResponse: "final", timing: { ...resultBase().timing, private: true } }),
    },
    {
      name: "an extra failure field",
      value: turnResult({ ...resultBase(), status: "failed", failure: { kind: "provider_exit", message: "failed", private: true } }),
    },
    {
      name: "an extra failure evidence field",
      value: turnResult({ ...resultBase(), status: "failed", failure: { kind: "inactivity_stale", message: "inactive", evidence: { failAfterMs: 1, silentForMs: 2, silenceStartedAt: "now", private: true } } }),
    },
    {
      name: "an extra failure upstream field",
      value: turnResult({ ...resultBase(), status: "failed", failure: { kind: "provider_exit", message: "failed", upstream: { source: "acpx", operation: "prompt", private: true } } }),
    },
    {
      name: "an extra terminal result field",
      value: turnResult({ ...resultBase(), status: "cancelled", message: "cancelled", private: true }),
    },
  ])("rejects $name", ({ value }) => {
    expect(isAcpWorkerChildMessage(value)).toBe(false);
  });
});
