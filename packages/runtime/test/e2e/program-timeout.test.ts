import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("E2E: Program timeout", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("records program failure on non-zero exit code", async () => {
    const ir = compileYaml(`
version: 1
name: program-timeout-test
workflow:
  steps:
    - id: failing-cmd
      run: program
      cmd: ["exit", "1"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "failing-cmd": { exitCode: 1, stdout: "error output" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "failing-cmd");
    expect(node?.state).toBe("failed");
  });
});
