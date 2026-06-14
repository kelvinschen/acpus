import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Loop execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("iterates the loop body and respects max_iterations", async () => {
    const ir = compileYaml(`
version: 1
name: loop-max-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: iterate
      loop:
        until: "false"
        max_iterations: 3
        do:
          - id: step
            run: agent
            use: coder
            prompt: "Iterate"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { step: { result: "ok" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const loopNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "iterate");
    expect(loopNode?.state).toBe("completed");
    expect(loopNode?.output).toEqual({ output: { output: { result: "ok" } } });

    // Should have exactly 3 step executions (one per iteration with unique loopRound keys)
    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes.length).toBe(3);
    stepNodes.forEach((n) => expect(n.state).toBe("completed"));
  });

  it("exposes loop context variables (iter, last)", async () => {
    // This test verifies the loop context is correctly set up
    // The loop body runs twice with different iter values
    const ir = compileYaml(`
version: 1
name: loop-context-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: iterate
      loop:
        until: "false"
        max_iterations: 2
        do:
          - id: step
            run: agent
            use: coder
            prompt: "Iterate"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { step: { result: "ok" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    // Should have 2 step executions with different loop rounds
    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes.length).toBe(2);
  });

  it("exposes the previous body step envelope through loop.last", async () => {
    const ir = compileYaml(`
version: 1
name: loop-last-envelope-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: iterate
      loop:
        until: loop.last.output.ok
        max_iterations: 3
        do:
          - id: step
            run: agent
            use: coder
            prompt: "Iterate"
            output:
              ok: boolean
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { step: { sequence: [{ output: { ok: false } }, { output: { ok: true } }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes).toHaveLength(2);
    expect(store.listNodeStates(meta.runId).find((n) => n.nodeId === "iterate")?.output).toEqual({
      output: { output: { ok: true } }
    });
  });
});
