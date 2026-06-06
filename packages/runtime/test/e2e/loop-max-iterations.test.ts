import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("E2E: Loop max iterations", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("respects max_iterations limit", async () => {
    const ir = compileYaml(`
version: 1
name: loop-max-iter-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: iterate
      loop:
        until: "false"
        max_iterations: 5
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

    // Should have exactly 5 step executions
    const stepNodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "step");
    expect(stepNodes.length).toBe(5);
    stepNodes.forEach((n) => expect(n.state).toBe("completed"));
  });
});
