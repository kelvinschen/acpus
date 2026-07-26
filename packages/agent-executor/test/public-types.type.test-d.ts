import { assertType, expectTypeOf, test } from "vitest";
import type { AgentBackendFailure, AgentBackendFailureKind, AgentContextSummary, AgentTelemetryAvailability, AgentTokenUsageSummary, AgentToolCallSummary, AgentToolsSummary, AgentTraceEvent, AgentTurnObservation, AgentTurnProgress, AgentTurnRawDebug, AgentTurnRequest, AgentTurnResult, AgentTurnSummary, AgentTurnTiming, AgentTurnTrace } from "@acpus/agent-executor";
import { executeAgentTurn } from "@acpus/agent-executor";

const availability = { context: "unavailable", tokenUsage: "unavailable" } as const;
const summary = { eventCount: 1, availability, tools: { totalToolCallCount: 0, calls: [] } };
const timing = { startedAt: "2026-07-01T00:00:00.000Z", finishedAt: "2026-07-01T00:00:00.001Z", elapsedMs: 1 };

test("@acpus/agent-executor public types accept only resolved execution requests", () => {
  expectTypeOf(executeAgentTurn).toEqualTypeOf<(request: AgentTurnRequest) => Promise<AgentTurnResult>>();
  expectTypeOf<AgentTurnSummary>().toMatchTypeOf<{
    eventCount: number;
    availability: AgentTelemetryAvailability;
    context?: AgentContextSummary;
    tokenUsage?: AgentTokenUsageSummary;
    tools: AgentToolsSummary;
  }>();
  expectTypeOf<AgentToolsSummary["calls"][number]>().toEqualTypeOf<AgentToolCallSummary>();
  expectTypeOf<AgentTurnRequest["timeoutMs"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<AgentTurnRequest["config"]>().toEqualTypeOf<Record<string, string> | undefined>();
  assertType<AgentBackendFailureKind>("config");
  assertType<AgentBackendFailureKind>("spawn");
  assertType<AgentBackendFailureKind>("provider_exit");
  assertType<AgentBackendFailureKind>("timeout");
  // @ts-expect-error output conformance is a runtime failure kind, not an executor backend failure.
  assertType<AgentBackendFailureKind>("output_conformance");
  assertType<AgentTurnTiming>(timing);
  assertType<AgentTurnResult>({ status: "completed", responseText: "ok", stderr: "", summary, timing });
  assertType<AgentTurnProgress>({ responseText: "partial", summary, updatedAt: "2026-07-01T00:00:00.000Z" });
  assertType<AgentTurnRawDebug>({ stdout: "{\"jsonrpc\":\"2.0\"}\n" });
  assertType<AgentTraceEvent>({ schemaVersion: 1, sequence: 0, observedAt: "2026-07-01T00:00:00.000Z", elapsedMs: 0, type: "message", channel: "assistant", content: { type: "text", text: "ok" } });
  assertType<AgentTurnObservation>({
    event: { schemaVersion: 1, sequence: 0, observedAt: "2026-07-01T00:00:00.000Z", elapsedMs: 0, type: "message", channel: "assistant", content: { type: "text", text: "ok" } },
    progress: { responseText: "ok", summary, updatedAt: "2026-07-01T00:00:00.000Z" },
  });
  assertType<AgentTurnTrace>({ startedAt: "2026-07-01T00:00:00.000Z", elapsedMs: 1, events: [] });
  assertType<AgentTurnResult>({ status: "completed", responseText: "ok", stderr: "", summary, timing, rawDebug: { stdout: "{}\n" } });
  assertType<AgentBackendFailure>({ kind: "provider_exit", message: "bad config", upstream: { source: "acpx", operation: "sessions.ensure", code: "RUNTIME", protocol: { name: "json-rpc", code: -32603 }, data: { details: "bad config" } } });
  assertType<AgentTurnResult>({ status: "failed", failure: { kind: "config", message: "bad mode" }, responseText: "", stderr: "", summary: { eventCount: 0, availability, tools: { totalToolCallCount: 0, calls: [] } }, timing });
  assertType<AgentTurnResult>({ status: "cancelled", message: "cancelled", responseText: "", stderr: "", summary: { eventCount: 0, availability, tools: { totalToolCallCount: 0, calls: [] } }, timing });
  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    model: "gpt-5.4",
    config: { model: "gpt-5.4", mode: "agent" },
    timeoutMs: 30_000,
    captureRawDebug: true,
    captureTrace: true,
    onProgress: progress => {
      assertType<string>(progress.responseText);
      assertType<number>(progress.summary.eventCount);
      assertType<string>(progress.updatedAt);
    },
    onObservation: observation => {
      assertType<AgentTraceEvent>(observation.event);
      assertType<AgentTurnProgress>(observation.progress);
    },
  });
  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    onProgress: async progress => {
      assertType<string>(progress.responseText);
    },
    onObservation: async observation => {
      assertType<number>(observation.event.sequence);
    },
  });
  assertType<AgentTurnRequest>({
    agent: { kind: "command", command: "custom acp" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "deny-all",
  });

  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    // @ts-expect-error executeAgentTurn does not accept an acpx binary/path override.
    acpxPath: "/tmp/acpx",
  });

  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    // @ts-expect-error executeAgentTurn does not accept provider-command mappings.
    providerCommands: { codex: "node worker.js" },
  });

  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    // @ts-expect-error executeAgentTurn accepts resolved milliseconds, not authored duration strings.
    timeout: "30s",
  });
});
