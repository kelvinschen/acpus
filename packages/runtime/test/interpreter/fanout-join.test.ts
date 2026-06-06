import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Fanout join and success criteria", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("join: all fails the fanout when a lane fails (default min_success = lane count)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-all-fail
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        do:
          - id: work
            run: agent
            use: coder
            prompt: "work"
`);

    // Only the first lane has a response; the second lane fails (no response).
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { sequence: [{ output: { ok: true } }, { failureKind: "schema" }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("failed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("failed");
  });

  it("succeeds when successful lanes meet success_criteria.min_success", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-min-success
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: all
        success_criteria:
          min_success: 1
        do:
          - id: work
            run: agent
            use: coder
            prompt: "work"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { sequence: [{ output: { ok: true } }, { failureKind: "schema" }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    // Output is the array of successful lane outputs (one success).
    expect(fanout?.output).toEqual([{ output: { ok: true } }]);
  });

  it("join: race completes on the first lane and outputs a single success (default min_success = 1)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-race
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: race
        do:
          - id: work
            run: agent
            use: coder
            prompt: "work"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      // The fast lane resolves first; the slow lane is not awaited for success.
      agentResponses: { work: { sequence: [{ output: { who: "fast" }, delay: 1 }, { output: { who: "slow" }, delay: 50 }] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    expect(Array.isArray(fanout?.output)).toBe(true);
    expect((fanout?.output as unknown[]).length).toBe(1);
  });

  it("join: quorum completes once the quorum count of lanes settle (default min_success = quorum)", async () => {
    const ir = compileYaml(`
version: 1
name: fanout-quorum
agents:
  coder:
    type: mock
workflow:
  steps:
    - id: mapped
      fanout:
        over: input.items
        join: quorum
        quorum: 2
        do:
          - id: work
            run: agent
            use: coder
            prompt: "work"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { work: { output: { ok: true } } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { items: ["a", "b", "c"] } });
    expect(meta.status).toBe("completed");

    const fanout = store.listNodeStates(meta.runId).find((n) => n.nodeId === "mapped");
    expect(fanout?.state).toBe("completed");
    // Quorum of 2 successful lanes satisfies the default min_success.
    expect((fanout?.output as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});
