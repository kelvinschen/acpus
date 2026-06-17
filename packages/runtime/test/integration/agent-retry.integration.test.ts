import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter, waitForNodeState } from "../interpreter/helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { generateRunId } from "../../src/interpreter.js";
import type { RunStore } from "../../src/store.js";
import type { NodeExecutionState } from "../../src/types.js";

async function waitForToolTelemetry(
  store: RunStore,
  runId: string,
  nodeId: string,
  timeoutMs: number
): Promise<NodeExecutionState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = store.listNodeStates(runId).find((node) =>
      node.nodeId === nodeId && (node.agentTelemetry?.attempts[0]?.tools.totalToolCallCount ?? 0) > 0
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Node ${nodeId} did not publish tool telemetry within ${timeoutMs}ms`);
}

describe("run ID generation", () => {
  it("generates local-time sortable IDs with an uppercase random suffix", () => {
    const id = generateRunId(new Date(2026, 5, 8, 23, 12, 39));
    expect(id).toMatch(/^20260608231239[A-F0-9]{20}$/);
  });
});

describe("Agent automatic retry", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("publishes prompt artifact and live telemetry while an agent is running", async () => {
    const ir = compileYaml(`
version: 1
name: agent-live-details
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "hello \${{ input.name }}"
      output:
        ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { output: { ok: true }, delay: 60, transcript: "{\"jsonrpc\":\"2.0\"}\n" }
      }
    });
    cleanups.push(cleanup);

    const initial = interpreter.initRun(ir, { input: { name: "Ada" } });
    const runPromise = interpreter.runToCompletion(ir, { input: { name: "Ada" } }, initial.runId);

    const running = await waitForNodeState(store, initial.runId, "work", "running", 500);
    expect(running.artifactRefs?.filter((ref) => ref.endsWith("attempt-001.prompt.md"))).toHaveLength(1);
    expect(running.artifactRefs?.filter((ref) => ref.endsWith("attempt-001.transcript.jsonl"))).toHaveLength(0);
    expect(running.agentTelemetry?.currentAttempt).toBe(1);
    expect(running.agentTelemetry?.attempts[0]?.input?.preview).toContain("hello Ada");
    expect(running.agentTelemetry?.attempts[0]?.input?.preview).toContain("# OUTPUT SCHEMA");

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(initial.runId, running.nodeKey, "attempt-001.prompt.md").toString()).toContain("hello Ada");

    await runPromise;
  });

  it("publishes streamed tool call telemetry before the agent turn completes", async () => {
    const ir = compileYaml(`
version: 1
name: agent-live-tool-telemetry
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "inspect"
`);

    const toolStream = [
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "List files", kind: "search", status: "in_progress", rawInput: { omitted: true } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { omitted: true } } } })
    ].join("\n") + "\n";
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: {
          output: { ok: true },
          responseText: "done",
          streamTranscript: toolStream,
          streamBeforeDelay: true,
          delay: 80
        }
      }
    });
    cleanups.push(cleanup);

    const initial = interpreter.initRun(ir, { input: {} });
    const runPromise = interpreter.runToCompletion(ir, { input: {} }, initial.runId);

    const live = await waitForToolTelemetry(store, initial.runId, "work", 500);
    expect(live.agentTelemetry?.attempts[0]?.tools).toMatchObject({
      totalToolCallCount: 1,
      droppedToolCallCount: 0,
      recentCalls: [{ toolCallId: "call-1", title: "List files", kind: "search", status: "completed" }]
    });
    const retainedTool = live.agentTelemetry?.attempts[0]?.tools.recentCalls[0] as Record<string, unknown> | undefined;
    expect(retainedTool?.rawInput).toBeUndefined();
    expect(retainedTool?.rawOutput).toBeUndefined();

    await runPromise;
  });

  it("preserves prompt telemetry and prompt artifact when an agent is paused", async () => {
    const ir = compileYaml(`
version: 1
name: agent-paused-details
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "pause me \${{ input.name }}"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { output: { ok: true }, delay: 80, transcript: "{\"jsonrpc\":\"2.0\"}\n" }
      }
    });
    cleanups.push(cleanup);

    const initial = interpreter.initRun(ir, { input: { name: "Ada" } });
    const runPromise = interpreter.runToCompletion(ir, { input: { name: "Ada" } }, initial.runId);

    const running = await waitForNodeState(store, initial.runId, "work", "running", 500);
    interpreter.pauseRun(initial.runId);
    const paused = await runPromise;

    expect(paused.status).toBe("paused");
    const node = store.readNodeState(initial.runId, running.nodeKey);
    expect(node?.state).toBe("paused");
    expect(node?.agentTelemetry?.attempts[0]?.input?.preview).toContain("pause me Ada");
    expect(node?.agentTelemetry?.attempts[0]?.state).toBe("paused");
    expect(node?.artifactRefs?.filter((ref) => ref.endsWith("attempt-001.prompt.md"))).toHaveLength(1);

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(initial.runId, running.nodeKey, "attempt-001.prompt.md").toString()).toContain("pause me Ada");
  });

  it("writes compact telemetry artifacts instead of transcript artifacts", async () => {
    const ir = compileYaml(`
version: 1
name: agent-live-transcript-finalization
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: {
          output: { ok: true },
          streamTranscript: "{\"live\":true}\n",
          transcript: "{\"returned\":true}\n"
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    const artifacts = new ArtifactStore(store.getBaseDir());
    const telemetry = JSON.parse(artifacts.read(meta.runId, node!.nodeKey, "attempt-001.telemetry.json").toString()) as { output?: { preview?: string }; state?: string };
    expect(telemetry.state).toBe("completed");
    expect(telemetry.output?.preview).toContain("\"ok\": true");
    expect(node?.artifactRefs?.filter((ref) => ref.endsWith("attempt-001.telemetry.json"))).toHaveLength(1);
    expect(node?.artifactRefs?.filter((ref) => ref.endsWith("attempt-001.transcript.jsonl"))).toHaveLength(0);
  });

  it("does not write raw ACP debug artifacts by default", async () => {
    const ir = compileYaml(`
version: 1
name: agent-live-transcript-append-error
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { output: { ok: true }, transcript: "{\"returned\":true}\n" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("completed");
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-001.acp-debug.jsonl"))).toBe(false);
  });

  it("persists latest agent context usage from ACP usage updates", async () => {
    const ir = compileYaml(`
version: 1
name: agent-context-usage
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: {
          output: { ok: true },
          transcript: [
            JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 10, size: 100 } } }),
            JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 25, size: 100 } } })
          ].join("\n") + "\n"
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.agentTelemetry?.attempts[0]?.context).toMatchObject({ used: 25, size: 100 });
    expect(node?.agentTelemetry?.attempts[0]?.tokenUsage).toBeUndefined();
  });

  it("persists PromptResponse token usage from final acpx result", async () => {
    const ir = compileYaml(`
version: 1
name: agent-token-usage
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: {
          output: { ok: true },
          transcript: [
            JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }),
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 25, cachedWriteTokens: 5, thoughtTokens: 3, totalTokens: 183 } } })
          ].join("\n") + "\n"
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.agentTelemetry?.attempts[0]?.context).toBeUndefined();
    expect(node?.agentTelemetry?.attempts[0]?.tokenUsage).toEqual({
      source: "prompt_response",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 25,
      cachedWriteTokens: 5,
      thoughtTokens: 3,
      totalTokens: 183
    });

    const artifacts = new ArtifactStore(store.getBaseDir());
    const telemetry = JSON.parse(artifacts.read(meta.runId, node!.nodeKey, "attempt-001.telemetry.json").toString()) as {
      tokenUsage?: unknown;
    };
    expect(telemetry.tokenUsage).toEqual({
      source: "prompt_response",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 25,
      cachedWriteTokens: 5,
      thoughtTokens: 3,
      totalTokens: 183
    });
  });

  it("defaults schema-backed agent steps to two output retries", async () => {
    const ir = compileYaml(`
version: 1
name: agent-default-retry
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      output:
        ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { failureKind: "parse" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { ok: true } });
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-001.response.md"))).toBe(true);
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-002.response.md"))).toBe(true);
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-003.response.md"))).toBe(true);
  });

  it("retries a schema failure and succeeds within max attempts", async () => {
    const ir = compileYaml(`
version: 1
name: agent-retry-success
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      retry: { max: 2, backoff: 1s }
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("completed");
    // Success after an initial schema failure proves the retry fired.
    expect(node?.output).toEqual({ output: { ok: true } });
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-001.prompt.md"))).toBe(true);
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-001.response.md"))).toBe(true);
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-002.prompt.md"))).toBe(true);
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-002.response.md"))).toBe(true);
    expect(new Set(node?.artifactRefs).size).toBe(node?.artifactRefs?.length);
    expect(node?.artifactRefs?.filter((ref) => ref.endsWith(".telemetry.json"))).toHaveLength(2);
    expect(node?.artifactRefs?.filter((ref) => ref.endsWith(".transcript.jsonl"))).toHaveLength(0);

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(meta.runId, node!.nodeKey, "attempt-001.prompt.md").toString()).toBe("do");
    expect(artifacts.read(meta.runId, node!.nodeKey, "attempt-001.response.md").toString()).toContain("schema");
    expect(artifacts.read(meta.runId, node!.nodeKey, "attempt-002.response.md").toString()).toContain("\"ok\": true");
  });

  it("retries a parse failure and succeeds within max attempts", async () => {
    const ir = compileYaml(`
version: 1
name: agent-retry-parse
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      retry: { max: 2 }
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "parse" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { ok: true } });
  });

  it("sleeps the configured backoff between retries", async () => {
    const sleeps: number[] = [];
    const ir = compileYaml(`
version: 1
name: agent-retry-backoff
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      retry: { max: 1, backoff: 1s }
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { output: { ok: true } }] }
      },
      interpreterOptions: {
        nowTimestamp: "2025-01-01T00:00:00Z",
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("completed");
    // Exactly one backoff sleep of 1000ms between the failed and successful attempt.
    expect(sleeps).toEqual([1000]);
  });

  it("fails after exhausting retries", async () => {
    const ir = compileYaml(`
version: 1
name: agent-retry-exhausted
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      retry: { max: 1 }
      output:
        ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { failureKind: "schema" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("failed");
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-003.response.md"))).toBe(false);
  });

  it("honors retry max zero as an opt-out for schema-backed agent steps", async () => {
    const ir = compileYaml(`
version: 1
name: agent-retry-opt-out
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      retry: { max: 0 }
      output:
        ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("failed");
    expect(node?.artifactRefs?.some((ref) => ref.endsWith("attempt-002.response.md"))).toBe(false);
  });

  it("does not apply a default retry when no output schema is declared", async () => {
    const ir = compileYaml(`
version: 1
name: agent-no-schema-default-retry
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { output: { ok: true } }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
  });

  it("does not retry deterministic agent configuration template failures", async () => {
    const ir = compileYaml(`
version: 1
name: agent-config-failure-no-retry
agents:
  coder:
    type: command
    use: "echo stub"
    env:
      BROKEN: "\${{ missing_var }}"
workflow:
  steps:
    - id: work
      run: agent
      use: coder
      prompt: "do"
      output:
        ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("failed");
    expect(node?.attempt).toBe(1);
    expect(node?.error).toContain("(config)");
  });
});
