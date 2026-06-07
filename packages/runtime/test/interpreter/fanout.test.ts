import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

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
    type: mock
input:
  files: string
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
    type: mock
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
    type: mock
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
});
