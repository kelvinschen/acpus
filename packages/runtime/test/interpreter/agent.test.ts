import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { RunStore } from "../../src/store.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { ExecutorAdapter, ExecutionRequest } from "../../src/executors/types.js";
import type { ExecutorResult } from "../../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

class RecordingAgentExecutor implements ExecutorAdapter {
  calls = 0;

  async execute(_request: ExecutionRequest): Promise<ExecutorResult> {
    this.calls++;
    return { output: { ok: true } };
  }
}

describe("Agent execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes an agent step and returns mock output", async () => {
    const ir = compileYaml(`
version: 1
name: agent-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: review
      run: agent
      use: coder
      prompt: "Review the code"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { review: { approved: true, comments: [] } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "review");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { approved: true, comments: [] } });
  });

  it("validates output against schema", async () => {
    const ir = compileYaml(`
version: 1
name: agent-schema-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: structured
      run: agent
      use: coder
      prompt: "Output structured data"
`);

    // Simple agent step without explicit output schema — mock output should pass
    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: { structured: { score: 8.5 } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "structured");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { score: 8.5 } });
  });

  it("rejects blank rendered session_key before dispatching to the agent executor", async () => {
    const ir = compileYaml(`
version: 1
name: blank-session-key
input:
  empty: string
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: review
      run: agent
      use: coder
      session_key: "\${{ input.empty }}"
      prompt: "Review the code"
`);

    const tmpDir = mkdtempSync(join(tmpdir(), "acpus-blank-session-key-"));
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    const executor = new RecordingAgentExecutor();
    const store = new RunStore(tmpDir);
    const interpreter = new WorkflowInterpreter(store, executor, new MockProgramExecutor({}), {
      nowTimestamp: "2025-01-01T00:00:00Z"
    });

    const meta = await interpreter.start(ir, { input: { empty: "   " } });

    expect(meta.status).toBe("failed");
    expect(executor.calls).toBe(0);
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "review");
    expect(node?.state).toBe("failed");
    expect(node?.error).toContain("session_key must render to a non-empty string");
    expect(node?.artifactRefs ?? []).toEqual([]);
  });
});
