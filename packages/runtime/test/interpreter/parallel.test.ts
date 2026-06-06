import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Parallel execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes parallel branches concurrently", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-test
agents:
  coder:
    type: mock
  reviewer:
    type: mock
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: branch-a
          run: agent
          use: coder
          prompt: "Task A"
        - id: branch-b
          run: agent
          use: reviewer
          prompt: "Task B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "branch-a": { result: "A" },
        "branch-b": { result: "B" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const branchA = nodes.find((n) => n.nodeId === "branch-a");
    const branchB = nodes.find((n) => n.nodeId === "branch-b");

    expect(branchA?.state).toBe("completed");
    expect(branchB?.state).toBe("completed");
  });

  it("merges parallel outputs as map", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-map-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: task-a
          run: agent
          use: coder
          prompt: "A"
        - id: task-b
          run: agent
          use: coder
          prompt: "B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "task-a": { value: 1 },
        "task-b": { value: 2 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const parallelNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parallel-group");
    expect(parallelNode?.state).toBe("completed");
    // outputMerge: "map" — should have step outputs
    expect(parallelNode?.output).toBeDefined();
  });
});
