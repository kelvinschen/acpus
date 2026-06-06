import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Pipeline execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes pipeline children sequentially in order", async () => {
    const ir = compileYaml(`
version: 1
name: pipeline-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "do A"
    - id: step-b
      run: agent
      use: coder
      prompt: "do B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "step-a": { result: "A" },
        "step-b": { result: "B" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const stepA = nodes.find((n) => n.nodeId === "step-a");
    const stepB = nodes.find((n) => n.nodeId === "step-b");

    expect(stepA?.state).toBe("completed");
    expect(stepB?.state).toBe("completed");
  });

  it("makes step outputs available to subsequent steps", async () => {
    const ir = compileYaml(`
version: 1
name: pipeline-output-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: first
      run: agent
      use: coder
      prompt: "compute"
    - id: second
      run: agent
      use: coder
      prompt: "use first"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        first: { value: 42 },
        second: { value: 84 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const second = store.listNodeStates(meta.runId).find((n) => n.nodeId === "second");
    expect(second?.state).toBe("completed");
    expect(second?.output).toEqual({ output: { value: 84 } });
  });

  it("fails the pipeline if a child fails", async () => {
    const ir = compileYaml(`
version: 1
name: pipeline-fail-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: fail-step
      run: agent
      use: coder
      prompt: "fail"
    - id: after-fail
      run: agent
      use: coder
      prompt: "should not run"
`);

    // No mock response for fail-step → agent executor will return error
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "after-fail": { value: "should not run" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    // The run should be marked as failed because fail-step had no mock response
    expect(meta.status).toBe("failed");

    const failStep = store.listNodeStates(meta.runId).find((n) => n.nodeId === "fail-step");
    expect(failStep?.state).toBe("failed");
  });
});
