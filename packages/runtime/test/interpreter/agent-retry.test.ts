import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Agent automatic retry", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
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
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { sequence: [{ failureKind: "schema" }, { failureKind: "schema" }] }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "work");
    expect(node?.state).toBe("failed");
  });

  it("does not retry without a retry policy", async () => {
    const ir = compileYaml(`
version: 1
name: agent-no-retry
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
});
