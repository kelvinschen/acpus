import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

describe("Approval execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("resolves approval with timeout and on_timeout=approve", async () => {
    const ir = compileYaml(`
version: 1
name: approval-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve-step
      approval:
        prompt: "Approve this?"
        timeout: 50ms
        on_timeout: approve
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ approved: true, decision: "timeout", at: "2025-01-01T00:00:00Z" });
  });

  it("resolves approval with timeout and on_timeout=reject", async () => {
    const ir = compileYaml(`
version: 1
name: approval-reject-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve-step
      approval:
        prompt: "Approve this?"
        timeout: 50ms
        on_timeout: reject
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ approved: false, decision: "timeout", at: "2025-01-01T00:00:00Z" });
  });

  it("fails on timeout with on_timeout=fail", async () => {
    const ir = compileYaml(`
version: 1
name: approval-fail-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve-step
      approval:
        prompt: "Approve this?"
        timeout: 50ms
        on_timeout: fail
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
  });

  // ── Human-in-the-loop decision channel ──

  const humanGateIr = (): ReturnType<typeof compileYaml> =>
    compileYaml(`
version: 1
name: approval-human-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve-step
      approval:
        prompt: "Approve this?"
`);

  /** Poll persisted node state until predicate holds (bounded). */
  async function waitForNode(
    store: { listNodeStates: (runId: string) => Array<{ nodeId: string; state: string }> },
    runId: string,
    nodeId: string,
    pred: (state: string) => boolean
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const node = store.listNodeStates(runId).find((n) => n.nodeId === nodeId);
      if (node && pred(node.state)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${nodeId}`);
  }

  it("enters awaiting and completes with approved=true on human approve", async () => {
    const ir = humanGateIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "approve-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step")!.nodeKey;
    interpreter.submitApproval(meta.runId, nodeKey, true);

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ approved: true, decision: "approved", at: "2025-01-01T00:00:00Z" });
  });

  it("completes with approved=false (not failed) on human reject", async () => {
    const ir = humanGateIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "approve-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step")!.nodeKey;
    interpreter.submitApproval(meta.runId, nodeKey, false);

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ approved: false, decision: "rejected", at: "2025-01-01T00:00:00Z" });
  });

  it("submitApproval throws when the node is not awaiting", async () => {
    const ir = humanGateIr();
    const { interpreter, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });
    expect(() => interpreter.submitApproval(meta.runId, "approve-step", true)).toThrow(/not awaiting/);
  });

  it("human approve wins the race against a configured timeout", async () => {
    const ir = compileYaml(`
version: 1
name: approval-race-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve-step
      approval:
        prompt: "Approve this?"
        timeout: 10s
        on_timeout: fail
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "approve-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step")!.nodeKey;
    interpreter.submitApproval(meta.runId, nodeKey, true);

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.output).toEqual({ approved: true, decision: "approved", at: "2025-01-01T00:00:00Z" });
  });

  it("cancelling an awaiting gate transitions it to cancelled", async () => {
    const ir = humanGateIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "approve-step", (s) => s === "awaiting");
    interpreter.cancelRun(meta.runId);

    const finalMeta = await done;
    expect(finalMeta.status).toBe("cancelled");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve-step");
    expect(node?.state).toBe("cancelled");
  });

});
