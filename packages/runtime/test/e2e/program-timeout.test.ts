import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("E2E: Program timeout", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("records a program timeout as a node failure", async () => {
    const ir = compileYaml(`
version: 1
name: program-timeout-test
workflow:
  steps:
    - id: slow-cmd
      run: program
      cmd: ["sleep", "100"]
      timeout: 10ms
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "slow-cmd": { failureKind: "timeout" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "slow-cmd");
    expect(node?.state).toBe("failed");
  });
});
