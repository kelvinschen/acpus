import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Fanout execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("expands lanes for each fanout item", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-test
agents:
  coder:
    type: mock
input:
  files: string
defaults:
  files:
    - "a.txt"
    - "b.txt"
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        do:
          - id: review-one
            run: agent
            use: coder
            prompt: "Review file"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "review-one": { approved: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { files: ["a.txt", "b.txt"] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    // Should have executed review-one for each fanout item
    const reviewNodes = nodes.filter((n) => n.nodeId === "review-one");
    expect(reviewNodes.length).toBeGreaterThanOrEqual(2);
    reviewNodes.forEach((n) => expect(n.state).toBe("completed"));
  });

  it("merges fanout outputs as array", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-array-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: map-items
      fanout:
        over: input.items
        do:
          - id: process
            run: agent
            use: coder
            prompt: "Process"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        process: { done: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["x", "y"] } });
    expect(meta.status).toBe("completed");

    const fanoutNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "map-items");
    expect(fanoutNode?.state).toBe("completed");
    // outputMerge: "array"
    expect(Array.isArray(fanoutNode?.output)).toBe(true);
  });
});
