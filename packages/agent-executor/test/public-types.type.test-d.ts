import { assertType, expectTypeOf, test } from "vitest";
import type { AgentBackendFailureKind, AgentTurnRawDebug, AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { executeAgentTurn } from "@acpus/agent-executor";

const telemetry = { eventCount: 1, tools: { totalToolCallCount: 0, calls: [] } };

test("@acpus/agent-executor public types accept only resolved execution requests", () => {
  expectTypeOf(executeAgentTurn).toEqualTypeOf<(request: AgentTurnRequest) => Promise<AgentTurnResult>>();
  assertType<AgentBackendFailureKind>("config");
  assertType<AgentBackendFailureKind>("spawn");
  assertType<AgentBackendFailureKind>("provider_exit");
  assertType<AgentBackendFailureKind>("timeout");
  // @ts-expect-error output conformance is a runtime failure kind, not an executor backend failure.
  assertType<AgentBackendFailureKind>("output_conformance");
  assertType<AgentTurnResult>({ status: "completed", responseText: "ok", stderr: "", telemetry });
  assertType<AgentTurnRawDebug>({ stdout: "{\"jsonrpc\":\"2.0\"}\n" });
  assertType<AgentTurnResult>({ status: "completed", responseText: "ok", stderr: "", telemetry, rawDebug: { stdout: "{}\n" } });
  assertType<AgentTurnResult>({ status: "failed", failureKind: "config", message: "bad mode", responseText: "", stderr: "", telemetry: { eventCount: 0, tools: { totalToolCallCount: 0, calls: [] } } });
  assertType<AgentTurnResult>({ status: "cancelled", message: "cancelled", responseText: "", stderr: "", telemetry: { eventCount: 0, tools: { totalToolCallCount: 0, calls: [] } } });
  assertType<AgentTurnRequest>({
    agent: { kind: "named", name: "codex" },
    prompt: "review this",
    cwd: process.cwd(),
    env: process.env,
    sessionName: "session",
    permissionMode: "approve-all",
    model: "gpt-5.4",
    agentMode: "agent",
    captureRawDebug: true,
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
});
