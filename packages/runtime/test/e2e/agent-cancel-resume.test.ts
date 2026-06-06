import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("E2E: Agent cancel and resume", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("marks node as failed when agent step has no response", async () => {
    const ir = compileYaml(`
version: 1
name: agent-cancel-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: task
      run: agent
      use: coder
      prompt: "Do work"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    // Without a mock response, the agent step fails
    expect(meta.status).toBe("failed");

    const taskNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "task");
    expect(taskNode?.state).toBe("failed");
  });

  it("succeeds when agent step has a response", async () => {
    const ir = compileYaml(`
version: 1
name: agent-resume-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: task
      run: agent
      use: coder
      prompt: "Do work"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { task: { done: true } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const taskNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "task");
    expect(taskNode?.state).toBe("completed");
    expect(taskNode?.output).toEqual({ output: { done: true } });
  });
});
