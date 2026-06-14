import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: Multi-agent chaining", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("chains 3 agent steps with inter-step context references", async () => {
    const ir = compileYaml(`
version: 1
name: multi-agent-chaining-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: a
      run: agent
      use: coder
      prompt: "Step A"

    - id: b
      run: agent
      use: coder
      prompt: "Got \${{ steps.a.output.project }}"

    - id: c
      run: agent
      use: coder
      prompt: "Then \${{ steps.b.output.version }}"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        a: { project: "acpus" },
        b: { version: "1.0" },
        c: { done: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);

    // Each step should be completed with the expected output
    const stepA = nodes.find((n) => n.nodeId === "a");
    expect(stepA?.state).toBe("completed");
    expect(stepA?.output).toEqual({ output: { project: "acpus" } });

    const stepB = nodes.find((n) => n.nodeId === "b");
    expect(stepB?.state).toBe("completed");
    expect(stepB?.output).toEqual({ output: { version: "1.0" } });

    const stepC = nodes.find((n) => n.nodeId === "c");
    expect(stepC?.state).toBe("completed");
    expect(stepC?.output).toEqual({ output: { done: true } });

    // 3 distinct nodeKeys (session isolation)
    const agentNodeKeys = nodes
      .filter((n) => n.nodeId === "a" || n.nodeId === "b" || n.nodeId === "c")
      .map((n) => n.nodeKey);
    const uniqueKeys = new Set(agentNodeKeys);
    expect(uniqueKeys.size).toBe(3);
  });
});
