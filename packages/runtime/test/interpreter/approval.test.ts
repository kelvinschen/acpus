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
    type: mock
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
    expect(node?.output).toEqual({ approved: true, timedOut: true });
  });

  it("fails on timeout with on_timeout=fail", async () => {
    const ir = compileYaml(`
version: 1
name: approval-fail-test
agents:
  coder:
    type: mock
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
});
