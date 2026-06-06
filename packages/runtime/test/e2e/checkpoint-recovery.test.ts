import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("E2E: Checkpoint recovery", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("persists state for completed nodes after failure", async () => {
    const ir = compileYaml(`
version: 1
name: checkpoint-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Step A"
    - id: step-b
      run: agent
      use: coder
      prompt: "Step B"
`);

    // Run where step-a succeeds but step-b fails (no mock response)
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { "step-a": { done: true } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    // Verify step-a's output is persisted
    const stepA = store.readNodeState(meta.runId, "workflow/step-a");
    expect(stepA?.state).toBe("completed");
    expect(stepA?.output).toEqual({ done: true });

    // Step-b should be failed
    const stepB = store.readNodeState(meta.runId, "workflow/step-b");
    expect(stepB?.state).toBe("failed");
  });

  it("can resume a new run with the same store", async () => {
    const ir = compileYaml(`
version: 1
name: checkpoint-resume-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Step A"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { "step-a": { done: true } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    // Verify IR and input are persisted for potential resume
    const savedIr = store.readIr(meta.runId);
    expect(savedIr).toBeDefined();
    expect(savedIr!.name).toBe("checkpoint-resume-test");

    const savedInput = store.readInput(meta.runId);
    expect(savedInput).toEqual({});
  });
});
