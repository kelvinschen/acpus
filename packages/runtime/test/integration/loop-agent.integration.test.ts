import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: Loop + agent step", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("loops an agent step until condition is met using sequence responses", async () => {
    const ir = compileYaml(`
version: 1
name: loop-agent-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: fix-loop
      loop:
        until: loop.last.output.ok == true
        max_iterations: 3
        do:
          - id: fix-once
            run: agent
            use: coder
            prompt: "Fix attempt"
`);

    // sequence: first two calls return { ok: false }, third returns { ok: true }
    // pickResponse advances by stepId across loop iterations
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "fix-once": {
          sequence: [
            { output: { ok: false } },
            { output: { ok: false } },
            { output: { ok: true } }
          ]
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);

    // Loop parent node completed, output is last round (outputMerge: "last")
    const loopNode = nodes.find((n) => n.nodeId === "fix-loop");
    expect(loopNode?.state).toBe("completed");
    // Last round's child output envelope
    expect(loopNode?.output).toEqual({ output: { output: { ok: true } } });

    // 3 fix-once nodes, each with composite nodeKey containing round:N
    const fixNodes = nodes.filter((n) => n.nodeId === "fix-once");
    expect(fixNodes.length).toBe(3);
    fixNodes.forEach((n) => {
      expect(n.state).toBe("completed");
      expect(n.nodeKey).toMatch(/round:\d+/);
    });

    // nodeKey set has no duplicates
    const fixNodeKeys = fixNodes.map((n) => n.nodeKey);
    expect(new Set(fixNodeKeys).size).toBe(3);

    // Sort by round number, then assert outputs in order
    const sorted = [...fixNodes].sort((a, b) => {
      const ra = a.nodeKey.match(/round:(\d+)/)?.[1];
      const rb = b.nodeKey.match(/round:(\d+)/)?.[1];
      return Number(ra) - Number(rb);
    });
    expect(sorted[0]?.output).toEqual({ output: { ok: false } });
    expect(sorted[1]?.output).toEqual({ output: { ok: false } });
    expect(sorted[2]?.output).toEqual({ output: { ok: true } });
  });
});
