import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter, waitForNodeState } from "./helper.js";
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
    type: command
    use: "echo stub"
  reviewer:
    type: command
    use: "echo stub"
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
    type: command
    use: "echo stub"
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

  it("pauses sibling branches when one branch is paused (not cancelled)", async () => {
    // Both branches have long delays so we can pause one before either finishes.
    // The slow sibling must be paused (not cancelled) so it can be resumed later.
    const ir = compileYaml(`
version: 1
name: parallel-pause-propagation
workflow:
  steps:
    - id: par
      parallel:
        - id: branch-a
          run: program
          cmd: ["echo", "a"]
        - id: branch-b
          run: program
          cmd: ["echo", "b"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "branch-a": { stdout: "a-out", delay: 500 },
        "branch-b": { stdout: "b-out", delay: 500 }
      }
    });
    cleanups.push(cleanup);

    const runId = "parallel-pause-test";
    const meta = interpreter.initRun(ir, { input: {}, runId });

    // Start the run but don't await it — we need to pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: {}, runId }, meta.runId);

    // Wait for branch-a to enter running, then pause it.
    const branchA = await waitForNodeState(store, runId, "branch-a", "running", 2000);
    interpreter.pauseNode(runId, branchA.nodeKey);

    await runPromise.catch(() => undefined);

    const finalNodes = store.listNodeStates(runId);
    const a = finalNodes.find((n) => n.nodeId === "branch-a");
    const b = finalNodes.find((n) => n.nodeId === "branch-b");

    // The paused branch and its sibling must both be "paused", NOT "cancelled".
    expect(a?.state).toBe("paused");
    expect(b?.state).toBe("paused");
  });

  it("still cancels siblings on genuine failure (fast-stop preserved)", async () => {
    // Same structure as the fail-fast test, but using a different join:all setup
    // to verify that genuine failures still cancel siblings.
    const ir = compileYaml(`
version: 1
name: parallel-fail-fast-preserved
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
    // Genuine failure still cancels siblings.
    expect(slow?.state).toBe("cancelled");
  });

  it("resuming a paused branch resumes all siblings and completes the run", async () => {
    const ir = compileYaml(`
version: 1
name: parallel-pause-resume
workflow:
  steps:
    - id: par
      parallel:
        - id: branch-a
          run: program
          cmd: ["echo", "a"]
        - id: branch-b
          run: program
          cmd: ["echo", "b"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "branch-a": { stdout: "a-out", delay: 500, parsedOutput: "a-result" },
        "branch-b": { stdout: "b-out", delay: 500, parsedOutput: "b-result" }
      }
    });
    cleanups.push(cleanup);

    const runId = "parallel-resume-test";
    const meta = interpreter.initRun(ir, { input: {}, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: {}, runId }, meta.runId);

    // Wait for branch-a to enter running, then pause it to trigger sibling pausing.
    const branchA = await waitForNodeState(store, runId, "branch-a", "running", 2000);
    interpreter.pauseNode(runId, branchA.nodeKey);

    await runPromise.catch(() => undefined);

    // Verify both branches are paused.
    const pausedNodes = store.listNodeStates(runId);
    expect(pausedNodes.find((n) => n.nodeId === "branch-a")?.state).toBe("paused");
    expect(pausedNodes.find((n) => n.nodeId === "branch-b")?.state).toBe("paused");

    // Now resume one branch — should propagate to all siblings.
    await interpreter.resumeNode(runId, branchA.nodeKey);

    const finalNodes = store.listNodeStates(runId);
    expect(finalNodes.find((n) => n.nodeId === "branch-a")?.state).toBe("completed");
    expect(finalNodes.find((n) => n.nodeId === "branch-b")?.state).toBe("completed");

    // Verify outputs are correct (catches re-execution producing wrong outputs)
    expect(finalNodes.find((n) => n.nodeId === "branch-a")?.output).toEqual({ output: "a-result", exit_code: 0 });
    expect(finalNodes.find((n) => n.nodeId === "branch-b")?.output).toEqual({ output: "b-result", exit_code: 0 });

    const runMeta = store.readRunMeta(runId);
    expect(runMeta?.status).toBe("completed");
  });

  it("pauses all branches and their children when a nested fanout lane is paused", async () => {
    // Parallel with 2 branches, each containing a fanout. Pausing a leaf inside
    // branch-a's fanout should propagate: leaf → fanout pauses other lanes in
    // branch-a → parallel pauses branch-b → branch-b's fanout lanes get paused.
    const ir = compileYaml(`
version: 1
name: nested-pause-test
workflow:
  steps:
    - id: par
      parallel:
        - id: branch-a
          fanout:
            over: input.files
            do:
              - id: review-a
                run: program
                cmd: ["echo", "a"]
        - id: branch-b
          fanout:
            over: input.files
            do:
              - id: review-b
                run: program
                cmd: ["echo", "b"]
input:
  files: [string]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "review-a": { stdout: "a-ok", delay: 500 },
        "review-b": { stdout: "b-ok", delay: 500 }
      }
    });
    cleanups.push(cleanup);

    const runId = "nested-pause-test";
    const meta = interpreter.initRun(ir, { input: { files: ["x.txt", "y.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["x.txt", "y.txt"] }, runId }, meta.runId);

    // Wait for review-a (in branch-a's fanout) to enter running, then pause it.
    const reviewA = await waitForNodeState(store, runId, "review-a", "running", 2000);
    interpreter.pauseNode(runId, reviewA.nodeKey);

    await runPromise.catch(() => undefined);

    // All review-a and review-b nodes should be paused (not cancelled).
    const finalNodes = store.listNodeStates(runId);
    const reviewANodes = finalNodes.filter((n) => n.nodeId === "review-a");
    const reviewBNodes = finalNodes.filter((n) => n.nodeId === "review-b");

    for (const node of reviewANodes) {
      expect(node.state).toBe("paused");
    }
    for (const node of reviewBNodes) {
      expect(node.state).toBe("paused");
    }
  });

  it("resuming after nested composite pause completes all branches", async () => {
    // Parallel with 2 branches, each containing a fanout. Pause a leaf,
    // verify all nodes are paused, then resume and verify completion.
    const ir = compileYaml(`
version: 1
name: nested-pause-resume-test
workflow:
  steps:
    - id: par
      parallel:
        - id: branch-a
          fanout:
            over: input.files
            do:
              - id: review-a
                run: program
                cmd: ["echo", "a"]
        - id: branch-b
          fanout:
            over: input.files
            do:
              - id: review-b
                run: program
                cmd: ["echo", "b"]
input:
  files: [string]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "review-a": { stdout: "a-ok", delay: 500, parsedOutput: "a-done" },
        "review-b": { stdout: "b-ok", delay: 500, parsedOutput: "b-done" }
      }
    });
    cleanups.push(cleanup);

    const runId = "nested-pause-resume-test";
    const meta = interpreter.initRun(ir, { input: { files: ["x.txt", "y.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["x.txt", "y.txt"] }, runId }, meta.runId);

    // Wait for review-a (in branch-a's fanout) to enter running, then pause it.
    const reviewA = await waitForNodeState(store, runId, "review-a", "running", 2000);
    interpreter.pauseNode(runId, reviewA.nodeKey);

    await runPromise.catch(() => undefined);

    // All review-a and review-b nodes should be paused.
    const pausedNodes = store.listNodeStates(runId);
    const reviewANodes = pausedNodes.filter((n) => n.nodeId === "review-a");
    const reviewBNodes = pausedNodes.filter((n) => n.nodeId === "review-b");
    for (const node of reviewANodes) expect(node.state).toBe("paused");
    for (const node of reviewBNodes) expect(node.state).toBe("paused");

    // Resume — should propagate and complete the run.
    await interpreter.resumeNode(runId, reviewA.nodeKey);

    const finalNodes = store.listNodeStates(runId);
    for (const node of finalNodes.filter((n) => n.nodeId === "review-a")) {
      expect(node.state).toBe("completed");
      expect(node.output).toEqual({ output: "a-done", exit_code: 0 });
    }
    for (const node of finalNodes.filter((n) => n.nodeId === "review-b")) {
      expect(node.state).toBe("completed");
      expect(node.output).toEqual({ output: "b-done", exit_code: 0 });
    }

    const runMeta = store.readRunMeta(runId);
    expect(runMeta?.status).toBe("completed");
  });
});
