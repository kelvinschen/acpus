import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Switch execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("selects the first matching branch", async () => {
    const ir = compileYaml(`
version: 1
name: switch-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: input.mode == "fast"
            do:
              - id: fast-path
                run: agent
                use: coder
                prompt: "Fast"
          - when: input.mode == "slow"
            do:
              - id: slow-path
                run: agent
                use: coder
                prompt: "Slow"
        default:
          do:
            - id: default-path
              run: agent
              use: coder
              prompt: "Default"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "fast-path": { speed: "fast" },
        "slow-path": { speed: "slow" },
        "default-path": { speed: "default" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { mode: "fast" } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const fastPath = nodes.find((n) => n.nodeId === "fast-path");
    const slowPath = nodes.find((n) => n.nodeId === "slow-path");
    const defaultPath = nodes.find((n) => n.nodeId === "default-path");

    expect(fastPath?.state).toBe("completed");
    expect(slowPath).toBeUndefined(); // should not execute
    expect(defaultPath).toBeUndefined(); // should not execute
    expect(nodes.find((n) => n.nodeId === "route")?.output).toEqual({ output: { speed: "fast" } });
  });

  it("falls through to default branch", async () => {
    const ir = compileYaml(`
version: 1
name: switch-default-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: input.mode == "fast"
            do:
              - id: fast-path
                run: agent
                use: coder
                prompt: "Fast"
        default:
          do:
            - id: default-path
              run: agent
              use: coder
              prompt: "Default"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "fast-path": { speed: "fast" },
        "default-path": { speed: "default" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { mode: "unknown" } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const fastPath = nodes.find((n) => n.nodeId === "fast-path");
    const defaultPath = nodes.find((n) => n.nodeId === "default-path");

    expect(fastPath).toBeUndefined();
    expect(defaultPath?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "route")?.output).toEqual({ output: { speed: "default" } });
  });
});
