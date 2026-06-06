import { describe, it, expect } from "vitest";
import { ProgramExecutor } from "../../src/executors/program.js";
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

describe("ProgramExecutor", () => {
  it("captures stdout from echo", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: "echo hello",
      capture: { from: "stdout", parse: "text" }
    });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect((result.output as string).trim()).toBe("hello");
  });

  it("captures JSON output", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: 'echo \'{"key":"value"}\'',
      capture: { from: "stdout", parse: "json" }
    });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({ key: "value" });
  });

  it("handles non-zero exit code", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "exit 1" });
    const result = await executor.execute(node, baseCtx(), new AbortController().signal);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("handles abort signal", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "sleep 60" });
    const controller = new AbortController();

    // Abort immediately
    setTimeout(() => controller.abort(), 10);

    const result = await executor.execute(node, baseCtx(), controller.signal);
    expect(result.partial).toBe(true);
  });

  it("resolves cmd template with expression", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: "echo ${{ input.name }}",
      capture: { from: "stdout", parse: "text" }
    });
    const ctx: ExpressionContext = { input: { name: "world" }, steps: {}, run_id: "test" };
    const result = await executor.execute(node, ctx, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect((result.output as string).trim()).toBe("world");
  });
});
