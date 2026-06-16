import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Signal execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("completes with the default payload on timeout when on_timeout=default", async () => {
    const ir = compileYaml(`
version: 1
name: signal-default-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: signal-step
      run: signal
      prompt: "Approve this?"
      output:
        approved: boolean
      timeout: 50ms
      on_timeout: default
      default:
        approved: true
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { approved: true } });
  });

  it("fails on timeout with on_timeout=fail", async () => {
    const ir = compileYaml(`
version: 1
name: signal-fail-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: signal-step
      run: signal
      prompt: "Approve this?"
      timeout: 50ms
      on_timeout: fail
`);

    const { interpreter, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
  });

  // ── External decision channel ──

  const signalIr = (output = "      output:\n        approved: boolean"): ReturnType<typeof compileYaml> =>
    compileYaml(`
version: 1
name: signal-human-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: signal-step
      run: signal
      prompt: "Decide this?"
${output}
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

  it("enters awaiting and completes with the injected payload as output", async () => {
    const ir = signalIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step")!.nodeKey;
    interpreter.submitSignal(meta.runId, nodeKey, { approved: true });

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { approved: true } });
  });

  it("accepts any payload when no output schema is declared", async () => {
    const ir = signalIr("      ");
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step")!.nodeKey;
    interpreter.submitSignal(meta.runId, nodeKey, { target: "branch_b", limit: 5 });

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.output).toEqual({ output: { target: "branch_b", limit: 5 } });
  });

  it("rejects a schema-invalid payload and keeps the node awaiting", async () => {
    const ir = signalIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step")!.nodeKey;

    expect(() => interpreter.submitSignal(meta.runId, nodeKey, { approved: "yes" })).toThrow(/validation failed/i);
    // The node stays awaiting; a conforming payload then resolves it.
    const stillAwaiting = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(stillAwaiting?.state).toBe("awaiting");
    interpreter.submitSignal(meta.runId, nodeKey, { approved: false });

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.output).toEqual({ output: { approved: false } });
  });

  it("submitSignal throws when the node is not awaiting", async () => {
    const ir = signalIr();
    const { interpreter, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);
    const meta = interpreter.initRun(ir, { input: {} });
    expect(() => interpreter.submitSignal(meta.runId, "signal-step", { approved: true })).toThrow(/not awaiting/);
  });

  it("persists the rendered prompt (expressions resolved) while awaiting", async () => {
    const ir = compileYaml(`
version: 1
name: signal-prompt-render
input:
  topic: string
workflow:
  steps:
    - id: signal-step
      run: signal
      prompt: "Decide on: \${{ input.topic }}."
      output:
        approved: boolean
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: { topic: "release readiness" } });
    const done = interpreter.runToCompletion(ir, { input: { topic: "release readiness" } }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.renderedPrompt).toBe("Decide on: release readiness.");
    expect(node?.renderedPrompt).not.toContain("${{");

    interpreter.submitSignal(meta.runId, node!.nodeKey, { approved: true });
    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
  });

  it("an external signal wins the race against a configured timeout", async () => {
    const ir = compileYaml(`
version: 1
name: signal-race-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: signal-step
      run: signal
      prompt: "Decide this?"
      output:
        approved: boolean
      timeout: 10s
      on_timeout: fail
`);
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    const nodeKey = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step")!.nodeKey;
    interpreter.submitSignal(meta.runId, nodeKey, { approved: true });

    const finalMeta = await done;
    expect(finalMeta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.output).toEqual({ output: { approved: true } });
  });

  it("cancelling an awaiting signal node transitions it to cancelled", async () => {
    const ir = signalIr();
    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = interpreter.initRun(ir, { input: {} });
    const done = interpreter.runToCompletion(ir, { input: {} }, meta.runId);

    await waitForNode(store, meta.runId, "signal-step", (s) => s === "awaiting");
    interpreter.cancelRun(meta.runId);

    const finalMeta = await done;
    expect(finalMeta.status).toBe("cancelled");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "signal-step");
    expect(node?.state).toBe("cancelled");
  });

});
