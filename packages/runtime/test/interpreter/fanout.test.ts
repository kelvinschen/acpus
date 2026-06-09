import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter, waitForNodeState } from "./helper.js";

describe("Fanout execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("expands lanes for each fanout item", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-test
agents:
  coder:
    type: command
    use: "echo stub"
input:
  files: [string]
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        do:
          - id: review-one
            run: agent
            use: coder
            prompt: "Review file"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "review-one": { approved: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { files: ["a.txt", "b.txt"] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    // Should have executed review-one for each fanout item
    const reviewNodes = nodes.filter((n) => n.nodeId === "review-one");
    expect(reviewNodes.length).toBeGreaterThanOrEqual(2);
    reviewNodes.forEach((n) => expect(n.state).toBe("completed"));
  });

  it("merges fanout outputs as array", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-array-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: map-items
      fanout:
        over: input.items
        do:
          - id: process
            run: agent
            use: coder
            prompt: "Process"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        process: { done: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["x", "y"] } });
    expect(meta.status).toBe("completed");

    const fanoutNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "map-items");
    expect(fanoutNode?.state).toBe("completed");
    // outputMerge: "array"
    expect(Array.isArray(fanoutNode?.output)).toBe(true);
  });

  it("retry preserves a fanout lane's composite node key (stable identity)", async () => {
    // A fanout lane agent step fails (no mock response). Retrying that lane must
    // re-execute under its ORIGINAL composite key (with item/lane dims), not a
    // re-resolved bare key — otherwise an agent's acpx session identity would
    // change across resume/retry.
    const ir = compileYaml(`
version: 1
name: fanout-identity
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        do:
          - id: work
            run: agent
            use: coder
            prompt: "do"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const runId = "fanout-identity-run";
    await interpreter.start(ir, { input: { items: ["a", "b"] }, runId });

    // Each lane's "work" node failed and carries a composite key with dynamics.
    const failedLanes = store.listNodeStates(runId).filter((n) => n.nodeId === "work");
    expect(failedLanes.length).toBe(2);
    failedLanes.forEach((n) => expect(n.state).toBe("failed"));
    const laneKey = failedLanes[0]!.nodeKey;
    // Composite key includes item/lane dimensions (not a bare "workflow/mapped/work").
    expect(laneKey).toMatch(/item:|lane:/);

    const keysBefore = new Set(store.listNodeStates(runId).map((n) => n.nodeKey));

    // Retry the specific lane by its composite key. It fails again (still no
    // mock response), but identity must be preserved regardless of outcome.
    await interpreter.retryNode(runId, laneKey).catch(() => undefined);

    // No new bare-key node was created; the same composite key was re-executed.
    const keysAfter = store.listNodeStates(runId).map((n) => n.nodeKey);
    const newKeys = keysAfter.filter((k) => !keysBefore.has(k));
    expect(newKeys).toEqual([]);
    expect(keysAfter).toContain(laneKey);
    expect(keysAfter).not.toContain("workflow/mapped/work");
  });

  it("pauses sibling lanes when one lane is paused", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-pause-propagation
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        do:
          - id: review-one
            run: program
            cmd: ["echo", "review"]
input:
  files: [string]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "review-one": { stdout: "ok", delay: 500 }
      }
    });
    cleanups.push(cleanup);

    const runId = "fanout-pause-test";
    const meta = interpreter.initRun(ir, { input: { files: ["a.txt", "b.txt", "c.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["a.txt", "b.txt", "c.txt"] }, runId }, meta.runId);

    // Wait for a lane to start, then pause it.
    const laneNode = await waitForNodeState(store, runId, "review-one", "running", 2000);
    interpreter.pauseNode(runId, laneNode.nodeKey);

    await runPromise.catch(() => undefined);

    // All lanes should be paused, not cancelled.
    const finalNodes = store.listNodeStates(runId);
    const reviewNodes = finalNodes.filter((n) => n.nodeId === "review-one");
    for (const node of reviewNodes) {
      expect(node.state).toBe("paused");
    }
  });

  it("resuming a paused lane resumes all siblings", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-pause-resume
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        do:
          - id: review-one
            run: program
            cmd: ["echo", "review"]
input:
  files: [string]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "review-one": { stdout: "ok", delay: 500, parsedOutput: "review-done" }
      }
    });
    cleanups.push(cleanup);

    const runId = "fanout-resume-test";
    const meta = interpreter.initRun(ir, { input: { files: ["a.txt", "b.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["a.txt", "b.txt"] }, runId }, meta.runId);

    // Wait for a lane to start, then pause it.
    const laneNode = await waitForNodeState(store, runId, "review-one", "running", 2000);
    interpreter.pauseNode(runId, laneNode.nodeKey);

    await runPromise.catch(() => undefined);

    // Verify lanes are paused.
    const pausedNodes = store.listNodeStates(runId).filter((n) => n.nodeId === "review-one");
    for (const n of pausedNodes) {
      expect(n.state).toBe("paused");
    }

    // Resume one lane — should propagate to all.
    await interpreter.resumeNode(runId, laneNode.nodeKey);

    const finalNodes = store.listNodeStates(runId);
    const reviewNodes = finalNodes.filter((n) => n.nodeId === "review-one");
    for (const node of reviewNodes) {
      expect(node.state).toBe("completed");
      // Verify output is correct (catches re-execution producing wrong outputs)
      expect(node.output).toEqual({ output: "review-done", exit_code: 0 });
    }

    const runMeta = store.readRunMeta(runId);
    expect(runMeta?.status).toBe("completed");
  });

  it("pauses all lanes when parallel inside fanout is paused", async () => {
    // Fanout with parallel branches inside each lane. Pausing a leaf in
    // one lane's parallel should propagate: leaf → parallel pauses sibling
    // branch → fanout pauses other lanes → all nodes paused.
    const ir = compileYaml(`
version: 1
name: fanout-parallel-pause-test
workflow:
  steps:
    - id: review-files
      fanout:
        over: input.files
        do:
          - id: inner-par
            parallel:
              - id: task-a
                run: program
                cmd: ["echo", "a"]
              - id: task-b
                run: program
                cmd: ["echo", "b"]
input:
  files: [string]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "task-a": { stdout: "a-ok", delay: 500 },
        "task-b": { stdout: "b-ok", delay: 500 }
      }
    });
    cleanups.push(cleanup);

    const runId = "fanout-parallel-pause-test";
    const meta = interpreter.initRun(ir, { input: { files: ["x.txt", "y.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["x.txt", "y.txt"] }, runId }, meta.runId);

    // Wait for task-a to enter running, then pause it.
    const taskA = await waitForNodeState(store, runId, "task-a", "running", 2000);
    interpreter.pauseNode(runId, taskA.nodeKey);

    await runPromise.catch(() => undefined);

    // All task-a and task-b nodes across all fanout lanes should be paused.
    const finalNodes = store.listNodeStates(runId);
    const taskANodes = finalNodes.filter((n) => n.nodeId === "task-a");
    const taskBNodes = finalNodes.filter((n) => n.nodeId === "task-b");

    for (const node of taskANodes) {
      expect(node.state).toBe("paused");
    }
    for (const node of taskBNodes) {
      expect(node.state).toBe("paused");
    }
  });
});
