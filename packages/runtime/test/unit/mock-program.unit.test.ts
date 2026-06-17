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
  return { input: {}, steps: {}, workflow: { name: "test", description: "", source_path: "", source_dir: "" }, run_id: "test" };
}

describe("MockProgramExecutor", () => {
  it("returns mock output for configured step", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { parsedOutput: { files: ["a.txt"] } }
    });
    const node = makeProgramNode({ cmd: ["ls"] });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.output).toEqual({ files: ["a.txt"] });
    expect(result.exitCode).toBe(0);
  });

  it("fails fast on a non-allow-listed exit code", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { exitCode: 1, stdout: "failed" }
    });
    const node = makeProgramNode({ cmd: ["exit", "1"] });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.failureKind).toBe("exit");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("failed");
  });

  it("treats an allow-listed non-zero exit as step data", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { exitCode: 1, stdout: "tests failed" }
    });
    const node = makeProgramNode({ cmd: ["pnpm", "test"], expect: { exit_code: [0, 1] } });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.exitCode).toBe(1);
    expect(result.failureKind).toBeUndefined();
  });

  it("surfaces a simulated non-recoverable failure", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { failureKind: "timeout" }
    });
    const node = makeProgramNode({ cmd: ["sleep", "1"] });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

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
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.output).toEqual({ key: "value" });
  });

  it("does not use stdout as the raw preview for file captures", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": {
        stdout: "command stdout that was not captured",
        parsedOutput: { count: "not-a-number" }
      }
    });
    const node = makeProgramNode({
      cmd: "echo",
      capture: { from: "file", parse: "json", path: "out.json" },
      output: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false
      }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.failureKind).toBe("schema");
    expect(result.error).toContain('captured output preview: {"count":"not-a-number"}');
    expect(result.error).not.toContain("command stdout that was not captured");
  });

  it("uses explicit raw captured output for file capture previews", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": {
        stdout: "command stdout that was not captured",
        capturedOutputRaw: '{"count":"not-a-number"}'
      }
    });
    const node = makeProgramNode({
      cmd: "echo",
      capture: { from: "file", parse: "json", path: "out.json" },
      output: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false
      }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.failureKind).toBe("schema");
    expect(result.error).toContain('captured output preview: {"count":"not-a-number"}');
    expect(result.error).not.toContain("command stdout that was not captured");
  });

  it("returns partial result on abort", async () => {
    const executor = new MockProgramExecutor({
      "test-cmd": { parsedOutput: {}, delay: 1000 }
    });
    const node = makeProgramNode({ cmd: "long-running" });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute({ node, context: baseCtx(), signal: controller.signal, nodeKey: node.id });
    expect(result.partial).toBe(true);
  });
});
