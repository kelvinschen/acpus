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
  async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
    try {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      return await fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

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

  it("executes string cmd with shell semantics", async () => {
    await withEnv({ ACPUS_PROGRAM_SHELL_TEST: "from-shell-env" }, async () => {
      const executor = new ProgramExecutor();
      const node = makeProgramNode({
        cmd: "printf '%s' \"$ACPUS_PROGRAM_SHELL_TEST\"",
        capture: { from: "stdout", parse: "text" }
      });
      const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("from-shell-env");
    });
  });

  it("executes array cmd without shell expansion", async () => {
    await withEnv({ ACPUS_PROGRAM_ARRAY_TEST: "expanded-by-shell" }, async () => {
      const executor = new ProgramExecutor();
      const node = makeProgramNode({
        cmd: [process.execPath, "-e", "console.log(process.argv[1])", "$ACPUS_PROGRAM_ARRAY_TEST"],
        capture: { from: "stdout", parse: "text" }
      });
      const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
      expect(result.exitCode).toBe(0);
      expect((result.output as string).trim()).toBe("$ACPUS_PROGRAM_ARRAY_TEST");
    });
  });

  it("inherits executor process env", async () => {
    await withEnv({ ACPUS_PROGRAM_INHERITED_ENV: "visible-to-program" }, async () => {
      const executor = new ProgramExecutor();
      const node = makeProgramNode({
        cmd: [process.execPath, "-e", "console.log(JSON.stringify({ inherited: process.env.ACPUS_PROGRAM_INHERITED_ENV ?? null }))"],
        capture: { from: "stdout", parse: "json" }
      });
      const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
      expect(result.exitCode).toBe(0);
      expect(result.output).toEqual({ inherited: "visible-to-program" });
    });
  });

  it("applies step env overrides and stringifies non-string values", async () => {
    await withEnv({ ACPUS_PROGRAM_OVERRIDE_ENV: "inherited-value" }, async () => {
      const executor = new ProgramExecutor();
      const node = makeProgramNode({
        cmd: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({ override: process.env.ACPUS_PROGRAM_OVERRIDE_ENV, bool: process.env.ACPUS_PROGRAM_BOOL_ENV, number: process.env.ACPUS_PROGRAM_NUMBER_ENV }))"
        ],
        env: {
          ACPUS_PROGRAM_OVERRIDE_ENV: "${{ input.override }}",
          ACPUS_PROGRAM_BOOL_ENV: true,
          ACPUS_PROGRAM_NUMBER_ENV: 42
        },
        capture: { from: "stdout", parse: "json" }
      });
      const ctx: ExpressionContext = { input: { override: "step-value" }, steps: {}, run_id: "test" };
      const result = await executor.execute({ node, context: ctx, signal: new AbortController().signal, nodeKey: node.id });
      expect(result.exitCode).toBe(0);
      expect(result.output).toEqual({
        override: "step-value",
        bool: "true",
        number: "42"
      });
    });
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

  it("includes captured output preview on schema validation failure", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: [process.execPath, "-e", "console.log(JSON.stringify({ count: 'not-a-number' }))"],
      capture: { from: "stdout", parse: "json" },
      output: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false
      }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("schema");
    expect(result.error).toContain("Output validation failed:");
    expect(result.error).toContain("must be integer");
    expect(result.error).toContain("captured output preview:");
    expect(result.error).toContain('{"count":"not-a-number"}');
  });

  it("fails the node fast when exit code is not allow-listed (default `[0]`)", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "exit 1" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("exit");
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/exit_code=1/);
  });

  it("includes a stderr tail in the failure message", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "echo 'syntax: bad' 1>&2; exit 2" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("exit");
    expect(result.error).toMatch(/syntax: bad/);
  });

  it("treats an allow-listed non-zero exit as step data, not failure", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({ cmd: "exit 1", expect: { exit_code: [0, 1] } });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.failureKind).toBeUndefined();
  });

  it("does not run schema validation on a non-allow-listed exit failure", async () => {
    const executor = new ProgramExecutor();
    const node = makeProgramNode({
      cmd: "echo 'not json'; exit 1",
      capture: { from: "stdout", parse: "json" },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.failureKind).toBe("exit");
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
    const node = makeProgramNode({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"] });
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
