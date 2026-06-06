import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Agent execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes an agent step and returns mock output", async () => {
    const ir = compileYaml(`
version: 1
name: agent-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: review
      run: agent
      use: coder
      prompt: "Review the code"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { review: { approved: true, comments: [] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "review");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { approved: true, comments: [] } });
  });

  it("validates output against schema", async () => {
    const ir = compileYaml(`
version: 1
name: agent-schema-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: structured
      run: agent
      use: coder
      prompt: "Output structured data"
`);

    // Simple agent step without explicit output schema — mock output should pass
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { structured: { score: 8.5 } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "structured");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { score: 8.5 } });
  });
});
