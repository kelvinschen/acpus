import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";
import { ArtifactStore } from "../../src/artifacts.js";

describe("Parallel execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes parallel branches concurrently", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-test
agents:
  coder:
    type: mock
  reviewer:
    type: mock
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: branch-a
          run: agent
          use: coder
          prompt: "Task A"
        - id: branch-b
          run: agent
          use: reviewer
          prompt: "Task B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "branch-a": { result: "A" },
        "branch-b": { result: "B" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const branchA = nodes.find((n) => n.nodeId === "branch-a");
    const branchB = nodes.find((n) => n.nodeId === "branch-b");

    expect(branchA?.state).toBe("completed");
    expect(branchB?.state).toBe("completed");
  });

  it("merges parallel outputs as map", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-map-test
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: parallel-group
      parallel:
        - id: task-a
          run: agent
          use: coder
          prompt: "A"
        - id: task-b
          run: agent
          use: coder
          prompt: "B"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "task-a": { value: 1 },
        "task-b": { value: 2 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const parallelNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parallel-group");
    expect(parallelNode?.state).toBe("completed");
    // outputMerge: "map" — should have step outputs
    expect(parallelNode?.output).toBeDefined();
  });

  it("keeps each concurrent branch's artifact refs isolated (no cross-contamination)", async () => {
    // Two program branches run concurrently with different delays to force their
    // executions to interleave at await points. Each node's artifactRefs must
    // reference its OWN stdout, proving refs are not shared across siblings.
    const ir = compileYaml(`
version: 1
name: parallel-artifact-isolation
workflow:
  steps:
    - id: par
      parallel:
        - id: slow
          run: program
          cmd: ["echo", "slow"]
        - id: fast
          run: program
          cmd: ["echo", "fast"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        slow: { stdout: "slow-out", delay: 40 },
        fast: { stdout: "fast-out", delay: 5 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const slow = nodes.find((n) => n.nodeId === "slow");
    const fast = nodes.find((n) => n.nodeId === "fast");
    expect(slow?.artifactRefs?.length).toBe(2);
    expect(fast?.artifactRefs?.length).toBe(2);

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(meta.runId, slow!.nodeKey, "stdout.log").toString()).toBe("slow-out");
    expect(artifacts.read(meta.runId, fast!.nodeKey, "stdout.log").toString()).toBe("fast-out");
    // Refs must point at the node's own artifact directory.
    expect(slow?.artifactRefs?.every((u) => u.includes("workflow:par:slow"))).toBe(true);
    expect(fast?.artifactRefs?.every((u) => u.includes("workflow:par:fast"))).toBe(true);
  });

  it("cancels still-running sibling branches when join:all fails fast", async () => {
    // A fast branch fails almost immediately; a slow branch is still running.
    // join:all must fail fast AND cancel the slow sibling (not leave it running).
    const ir = compileYaml(`
version: 1
name: parallel-fail-fast
workflow:
  steps:
    - id: par
      join: all
      parallel:
        - id: boom
          run: program
          cmd: ["echo", "boom"]
        - id: slow
          run: program
          cmd: ["echo", "slow"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        boom: { failureKind: "timeout", delay: 5 },
        slow: { stdout: "slow-out", delay: 200 }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const nodes = store.listNodeStates(meta.runId);
    const boom = nodes.find((n) => n.nodeId === "boom");
    const slow = nodes.find((n) => n.nodeId === "slow");
    expect(boom?.state).toBe("failed");
    // The key assertion: the slow sibling must NOT linger in "running".
    expect(slow?.state).toBe("cancelled");
  });
});
