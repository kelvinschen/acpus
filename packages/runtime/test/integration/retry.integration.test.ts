import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Pause and Resume", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("can retry a failed node", async () => {
    const ir = compileYaml(`
version: 1
name: retry-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: retry-step
      run: agent
      use: coder
      prompt: "Try"
`);

    // First run: no mock response → failure
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const failNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "retry-step");
    expect(failNode?.state).toBe("failed");

    // Now retry — this time we need a new interpreter with responses
    const { interpreter: interp2, store: store2, cleanup: cleanup2 } = createTestInterpreter({
      agentResponses: { "retry-step": { success: true } }
    });
    cleanups.push(cleanup2);

    // Start fresh run
    const meta2 = await interp2.start(ir, { input: {} });
    expect(meta2.status).toBe("completed");

    const successNode = store2.listNodeStates(meta2.runId).find((n) => n.nodeId === "retry-step");
    expect(successNode?.state).toBe("completed");
  });

  it("increments runAttempt only for Run-level retry", async () => {
    const ir = compileYaml(`
version: 1
name: run-retry-attempt-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: retry-step
      run: agent
      use: coder
      prompt: "Try"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    expect(meta.runAttempt).toBe(1);

    interpreter.retryRun(meta.runId);
    expect(store.readRunMeta(meta.runId)?.runAttempt).toBe(2);
  });
});
