import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Parallel join: race", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("returns a single-key map for the first branch to complete", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-race
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: branches
      join: race
      parallel:
        - id: fast
          run: agent
          use: coder
          prompt: "fast"
        - id: slow
          run: agent
          use: coder
          prompt: "slow"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        fast: { output: { who: "fast" }, delay: 1 },
        slow: { output: { who: "slow" }, delay: 50 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const branches = store.listNodeStates(meta.runId).find((n) => n.nodeId === "branches");
    expect(branches?.state).toBe("completed");
    expect(branches?.output).toEqual({ output: { fast: { output: { who: "fast" } } } });
  });

  it("join: all returns every branch keyed by id", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-all
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: branches
      join: all
      parallel:
        - id: a
          run: agent
          use: coder
          prompt: "a"
        - id: b
          run: agent
          use: coder
          prompt: "b"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { a: { x: 1 }, b: { x: 2 } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const branches = store.listNodeStates(meta.runId).find((n) => n.nodeId === "branches");
    expect(branches?.output).toEqual({ output: {
      a: { output: { x: 1 } },
      b: { output: { x: 2 } }
    } });
  });
});
