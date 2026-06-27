import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: Fanout concurrency", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes fanout items with concurrency", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-concurrency-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: map-items
      fanout:
        over: input.items
        max_concurrency: 2
        do:
          - id: process
            run: agent
            use: coder
            prompt: "Process"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { process: { done: true } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b", "c", "d"] } });
    expect(meta.status).toBe("completed");

    const fanoutNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "map-items");
    expect(fanoutNode?.state).toBe("completed");
    // outputMerge: "array" — should have 4 results
    expect(fanoutNode?.output).toEqual({
      output: [
        { done: true },
        { done: true },
        { done: true },
        { done: true }
      ]
    });
  });
});
