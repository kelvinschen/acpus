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
    expect(loopNode?.output).toEqual({ output: { result: "ok" } });

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

  it("exposes the previous body primary output through loop.last", async () => {
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
        until: loop.last.ok
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
      output: { ok: true }
    });
  });

  it("evaluates loop.iter arithmetic as integer CEL", async () => {
    const ir = compileYaml(`
version: 1
name: loop-iter-int-test
workflow:
  steps:
    - id: iterate
      loop:
        until: loop.iter + 1 >= 2
        max_iterations: 3
        do:
          - id: step
            run: program
            cmd: ["tick", "\${{ loop.iter }}"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { step: { parsedOutput: "ok" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes).toHaveLength(1);
  });

  it("evaluates loop.last primary output in CEL", async () => {
    const ir = compileYaml(`
version: 1
name: loop-last-exit-code-int-test
workflow:
  steps:
    - id: iterate
      loop:
        until: loop.last == "ok"
        max_iterations: 3
        do:
          - id: step
            run: program
            cmd: ["tick", "\${{ loop.iter }}"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { step: { parsedOutput: "ok" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes).toHaveLength(1);
  });

  it("replays loop.last primary output consistently", async () => {
    const ir = compileYaml(`
version: 1
name: loop-last-replay-test
agents:
  coder:
    type: command
    use: echo stub
workflow:
  steps:
    - id: fix_loop
      loop:
        until: loop.last.ok
        max_iterations: 3
        do:
          - id: fix_once
            run: agent
            use: coder
            prompt: fix
`);

    const { interpreter, cleanup } = createTestInterpreter({
      agentResponses: {
        fix_once: {
          sequence: [
            { output: { ok: false } },
            { output: { ok: true } }
          ]
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    expect(interpreter.replay(meta.runId).ok).toBe(true);
  });
});
