import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileYaml, createTestInterpreter, waitForNodeState } from "../interpreter/helper.js";

const fixtures = join(import.meta.dirname, "../../../core/test/fixtures");
const compositeFixturePath = join(fixtures, "composite-e2e/workflow.yaml");

function compileCompositeFixture() {
  return compileYaml(readFileSync(compositeFixturePath, "utf8").replace(
    /use: "node \.\/packages\/mock-agent\/dist\/index\.js --script \.\/packages\/core\/test\/fixtures\/composite-e2e\/mock\.yaml"/,
    'use: "echo stub"'
  ));
}

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
    expect(fanoutNode?.output).toEqual({ output: [{ output: { done: true } }, { output: { done: true } }] });
  });

  it("evaluates item_index arithmetic as integer CEL", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-item-index-int-test
workflow:
  steps:
    - id: map-items
      fanout:
        over: input.items
        do:
          - id: process
            run: program
            cmd: ["process", "\${{ item_index + 1 }}"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        process: { stdout: "ok" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["x", "y"] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId).filter((n) => n.nodeId === "process");
    expect(nodes).toHaveLength(2);
    nodes.forEach((n) => expect(n.state).toBe("completed"));
  });

  it("retry preserves a fanout lane's composite node key (stable identity)", async () => {
    // A fanout lane agent step fails (no mock response). Retrying that lane must
    // re-execute under its ORIGINAL composite key (with item/lane dims), not a
    // re-resolved bare key — otherwise an agent's acpx session identity would
    // change across retry.
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

  it("Run-level pause/resume re-executes paused fanout lanes", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-run-pause-resume
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

    const runId = "fanout-run-pause-resume";
    const meta = interpreter.initRun(ir, { input: { files: ["a.txt", "b.txt", "c.txt"] }, runId });

    // Start the run but don't await — pause mid-flight.
    const runPromise = interpreter.runToCompletion(ir, { input: { files: ["a.txt", "b.txt", "c.txt"] }, runId }, meta.runId);

    await waitForNodeState(store, runId, "review-one", "running", 2000);
    interpreter.pauseRun(runId);

    await runPromise.catch(() => undefined);

    expect(store.readRunMeta(runId)?.status).toBe("paused");
    expect(store.listNodeStates(runId).some((n) => n.nodeId === "review-one" && n.state === "paused")).toBe(true);

    await interpreter.resumeRun(runId);
    await interpreter.runToCompletion(ir, { input: { files: ["a.txt", "b.txt", "c.txt"] }, runId }, runId);
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

  it("executes fanout guard loop topology with stable node keys and outputs", async () => {
    const ir = compileCompositeFixture();

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        work: { item: "fixture", round: 0, ok: true }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const workNodes = nodes
      .filter((n) => n.nodeId === "work")
      .sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    expect(workNodes).toHaveLength(4);
    expect(workNodes.map((n) => n.nodeKey.match(/(item:.*$)/)?.[1] ?? n.nodeKey).sort()).toEqual([
      "item:alpha/lane:0/round:0",
      "item:alpha/lane:0/round:1",
      "item:beta/lane:1/round:0",
      "item:beta/lane:1/round:1",
    ]);
    for (const node of workNodes) {
      expect(node.nodeKey).toMatch(/item:/);
      expect(node.nodeKey).toMatch(/lane:/);
      expect(node.nodeKey).toMatch(/round:/);
      expect(node.output).toEqual({ output: { item: "fixture", round: 0, ok: true } });
    }

    const skippedGuard = nodes.find((n) => n.nodeId === "skip_lane" && n.nodeKey.includes("item:skip"));
    expect(skippedGuard?.state).toBe("completed");
    expect(skippedGuard?.output).toEqual({ output: { matched: true, action: "complete" } });
    expect(nodes.some((n) => n.nodeId === "work" && n.nodeKey.includes("item:skip"))).toBe(false);

    const fanoutNode = nodes.find((n) => n.nodeId === "composite");
    expect(fanoutNode?.state).toBe("completed");
    expect(fanoutNode?.output).toEqual({ output: [expect.anything(), expect.anything(), expect.anything()] });
  });
});
