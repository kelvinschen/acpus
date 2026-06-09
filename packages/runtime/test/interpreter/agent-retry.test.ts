import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { generateRunId } from "../../src/interpreter.js";

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
