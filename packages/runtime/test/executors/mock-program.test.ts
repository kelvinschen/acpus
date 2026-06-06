import { describe, it, expect } from "vitest";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext } from "../../src/types.js";

function makeProgramNode(metadata: Record<string, unknown>): IrNode {
  return {
    id: "test-cmd",
    kind: "run.program",
    nodePath: ["workflow", "test-cmd"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/test-cmd" },
    metadata
  };
}

function baseCtx(): ExpressionContext {
  return { input: {}, steps: {}, run_id: "test" };
}

describe("MockProgramExecutor", () => {
  it("returns mock output for configured step", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { parsedOutput: { files: ["a.txt"] } }
    });
    const node = makeProgramNode({ cmd: ["ls"] });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.output).toEqual({ files: ["a.txt"] });
    expect(result.exitCode).toBe(0);
  });

  it("treats a non-zero exit code as data (no error)", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { exitCode: 1, stdout: "failed" }
    });
    const node = makeProgramNode({ cmd: ["exit", "1"] });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.failureKind).toBeUndefined();
    expect(result.stdout).toBe("failed");
  });

  it("surfaces a simulated non-recoverable failure", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { failureKind: "timeout" }
    });
    const node = makeProgramNode({ cmd: ["sleep", "1"] });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.failureKind).toBe("timeout");
  });

  it("parses JSON capture from stdout", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { stdout: '{"key": "value"}' }
    });
    const node = makeProgramNode({
      cmd: "echo",
      capture: { from: "stdout", parse: "json" }
    });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);

    expect(result.output).toEqual({ key: "value" });
  });

  it("returns partial result on abort", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { parsedOutput: {}, delay: 1000 }
    });
    const node = makeProgramNode({ cmd: "long-running" });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(node, baseCtx(), controller.signal);
    expect(result.partial).toBe(true);
  });
});
