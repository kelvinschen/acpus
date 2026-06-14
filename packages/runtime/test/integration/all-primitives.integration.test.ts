import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: All primitives", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes a workflow with all node types", async () => {
    const ir = compileYaml(`
version: 1
name: all-primitives-e2e
agents:
  coder:
    type: command
    use: "echo stub"
  reviewer:
    type: command
    use: "echo stub"
input:
  mode: string
workflow:
  steps:
    - id: build
      run: agent
      use: coder
      prompt: "Build"

    - id: review-parallel
      parallel:
        - id: review-a
          run: agent
          use: reviewer
          prompt: "Review A"
        - id: review-b
          run: agent
          use: reviewer
          prompt: "Review B"

    - id: route
      switch:
        cases:
          - when: input.mode == "fast"
            do:
              - id: fast-deploy
                run: program
                cmd: "deploy --fast"
        default:
          do:
            - id: slow-deploy
              run: program
              cmd: "deploy"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        build: { status: "built" },
        "review-a": { status: "approved" },
        "review-b": { status: "approved" }
      },
      programResponses: {
        "fast-deploy": { parsedOutput: { deployed: true } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { mode: "fast" } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);

    // All top-level nodes should be completed
    const buildNode = nodes.find((n) => n.nodeId === "build");
    expect(buildNode?.state).toBe("completed");
    expect(buildNode?.output).toEqual({ output: { status: "built" } });

    const parallelNode = nodes.find((n) => n.nodeId === "review-parallel");
    expect(parallelNode?.state).toBe("completed");

    const reviewA = nodes.find((n) => n.nodeId === "review-a");
    expect(reviewA?.state).toBe("completed");

    const reviewB = nodes.find((n) => n.nodeId === "review-b");
    expect(reviewB?.state).toBe("completed");

    const routeNode = nodes.find((n) => n.nodeId === "route");
    expect(routeNode?.state).toBe("completed");

    const fastDeploy = nodes.find((n) => n.nodeId === "fast-deploy");
    expect(fastDeploy?.state).toBe("completed");
    expect(fastDeploy?.output).toEqual({ output: { deployed: true }, exit_code: 0 });

    // slow-deploy should NOT have been executed (switch selected fast path)
    const slowDeploy = nodes.find((n) => n.nodeId === "slow-deploy");
    expect(slowDeploy).toBeUndefined();
  });
});
