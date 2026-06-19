import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: Fanout + agent step", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("runs an agent step in each fanout lane", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-agent-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        key: "\${{ item.name }}"
        do:
          - id: review-one
            run: agent
            use: coder
            prompt: "Review \${{ item.name }}"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "review-one": { verdict: "ok" }
      }
    });
    cleanups.push(cleanup);

    const files = [
      { name: "a.ts" },
      { name: "b.ts" },
      { name: "c.ts" }
    ];
    const meta = await interpreter.start(ir, { input: { files } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);

    // Fanout parent node completed with array output (3 items)
    const fanoutNode = nodes.find((n) => n.nodeId === "review-files");
    expect(fanoutNode?.state).toBe("completed");
    expect(fanoutNode?.output).toEqual({ output: [
      { verdict: "ok" },
      { verdict: "ok" },
      { verdict: "ok" }
    ] });

    // 3 review-one nodes, each with composite nodeKey containing item: and lane:
    const reviewNodes = nodes.filter((n) => n.nodeId === "review-one");
    expect(reviewNodes.length).toBe(3);
    reviewNodes.forEach((n) => {
      expect(n.state).toBe("completed");
      expect(n.nodeKey).toMatch(/item:/);
      expect(n.nodeKey).toMatch(/lane:/);
      expect(n.output).toEqual({ output: { verdict: "ok" } });
    });

    // nodeKey set has no duplicates (session isolation)
    const reviewNodeKeys = reviewNodes.map((n) => n.nodeKey);
    expect(new Set(reviewNodeKeys).size).toBe(3);

    // Derived acpx session names should also be unique (they derive from nodeKey)
    // Verify each nodeKey is distinct
    const sortedKeys = [...reviewNodeKeys].sort();
    for (let i = 1; i < sortedKeys.length; i++) {
      expect(sortedKeys[i]).not.toBe(sortedKeys[i - 1]);
    }
  });
});
