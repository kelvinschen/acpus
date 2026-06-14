import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Integration: Approval timeout", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("follows on_timeout=approve", async () => {
    const ir = compileYaml(`
version: 1
name: approval-timeout-approve
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve
      approval:
        prompt: "OK?"
        timeout: 50ms
        on_timeout: approve
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "approve");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { approved: true, decision: "timeout", at: "2025-01-01T00:00:00Z" } });
  });

  it("follows on_timeout=fail", async () => {
    const ir = compileYaml(`
version: 1
name: approval-timeout-fail
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: approve
      approval:
        prompt: "OK?"
        timeout: 50ms
        on_timeout: fail
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
  });
});
