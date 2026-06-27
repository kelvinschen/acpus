import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("Pause and Resume", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("can retry a failed node", async () => {
    const ir = compileYaml(`
version: 1
name: retry-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: retry-step
      run: agent
      use: coder
      prompt: "Try"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "retry-step": {
          sequence: [
            { failureKind: "spawn" },
            { output: { ok: true } }
          ]
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const failedCheckpoint = store.readCheckpoints(meta.runId).find((checkpoint) => checkpoint.nodeKey === "workflow/retry-step");
    expect(failedCheckpoint).toMatchObject({ sequence: 1, state: "failed" });

    await interpreter.retryNode(meta.runId, "workflow/retry-step");

    const successNode = store.listNodeStates(meta.runId).find((n) => n.nodeId === "retry-step");
    expect(successNode?.state).toBe("completed");
    expect(successNode?.output).toEqual({ output: { ok: true } });

    expect(store.readCheckpoints(meta.runId).filter((checkpoint) => checkpoint.nodeKey === "workflow/retry-step")).toEqual([{
      ...failedCheckpoint!,
      state: "completed",
      completedAt: expect.any(String)
    }]);
  });

  it("increments runAttempt only for Run-level retry", async () => {
    const ir = compileYaml(`
version: 1
name: run-retry-attempt-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: retry-step
      run: agent
      use: coder
      prompt: "Try"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({});
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    expect(meta.runAttempt).toBe(1);

    interpreter.retryRun(meta.runId);
    expect(store.readRunMeta(meta.runId)?.runAttempt).toBe(2);
  });
});
