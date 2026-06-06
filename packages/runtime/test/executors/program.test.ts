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
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.exitCode).toBe(0);
    expect((result.output as string).trim()).toBe("hello");
  });

  it("captures JSON output", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: 'echo \'{"key":"value"}\'',
      capture: { from: "stdout", parse: "json" }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({ key: "value" });
  });

  it("treats a non-zero exit code as data (no error)", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "exit 1" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.failureKind).toBeUndefined();
  });

  it("classifies a missing command as a spawn failure", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: ["this-command-does-not-exist-xyz"] });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("spawn");
  });

  it("captures from a file with capture.from: file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "acpus-capture-"));
    const filePath = join(dir, "out.json");
    writeFileSync(filePath, JSON.stringify({ from: "file" }));
    try {
      const executor = new ProgramExecutor();
      const node = makeProgramNode({
        cmd: "echo ignored",
        capture: { from: "file", parse: "json", path: filePath }
      });
      const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
      expect(result.exitCode).toBe(0);
      expect(result.output).toEqual({ from: "file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails capture when the file is missing", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: "echo ignored",
      capture: { from: "file", parse: "json", path: "/nonexistent/acpus-missing.json" }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("capture");
  });

  it("handles abort signal", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "sleep 60" });
    const controller = new AbortController();

    // Abort immediately
    setTimeout(() => controller.abort(), 10);

    const result = await executor.execute({ node, context: baseCtx(), signal: controller.signal, nodeKey: node.id });
    expect(result.partial).toBe(true);
  });

  it("resolves cmd template with expression", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: "echo ${{ input.name }}",
      capture: { from: "stdout", parse: "text" }
    });
    const ctx: ExpressionContext = { input: { name: "world" }, steps: {}, run_id: "test" };
    const result = await executor.execute({ node, context: ctx, signal: new AbortController().signal, nodeKey: node.id });
    expect(result.exitCode).toBe(0);
    expect((result.output as string).trim()).toBe("world");
  });
});
