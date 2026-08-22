import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type DiagnosticIR, type WorkflowIR } from "@acpus/core/ir";
import { classifyCompileWorkerResultReadFailure } from "../src/compiler/worker.js";
import {
  interpretCompileWorkerOutput,
  parseCompileWorkerEnvelope,
} from "../src/compiler/worker-protocol.js";

const compiled = {
  sourceDigest: `sha256:${"a".repeat(64)}` as const,
  ir: {
    irVersion: 8 as const,
    name: "worker-result",
    agents: {},
    root: { nodes: [], output: { kind: "literal" as const, value: null } },
    diagnostics: [],
  },
};

describe("compile worker protocol", () => {
  it.each(["EACCES", "EIO", "EISDIR"])("preserves %s result read failures even when the worker exits unsuccessfully", code => {
    const error = Object.assign(new Error(`read failed: ${code}`), { code });

    expect(classifyCompileWorkerResultReadFailure(completedProcess(1), "/scratch/compile-result.json", error)).toEqual({
      type: "worker-result-read-failed",
      path: "/scratch/compile-result.json",
      code,
      message: `Workflow compile worker result '/scratch/compile-result.json' could not be read: read failed: ${code}`,
      stdoutTail: "stdout",
      stderrTail: "stderr",
    });
  });

  it.each(["ENOENT", "ENOTDIR"])("uses the worker exit failure when an unsuccessful worker produced no result (%s)", code => {
    const error = Object.assign(new Error(`missing: ${code}`), { code });

    expect(classifyCompileWorkerResultReadFailure(completedProcess(1), "/scratch/compile-result.json", error)).toEqual({
      type: "worker-exit-failed",
      message: "Workflow compile worker exited without a readable result (exit code 1).",
      exitCode: 1,
      signal: null,
      stdoutTail: "stdout",
      stderrTail: "stderr",
    });
  });

  it("preserves a missing result as a read failure after a successful worker exit", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });

    expect(classifyCompileWorkerResultReadFailure(completedProcess(0), "/scratch/compile-result.json", error)).toMatchObject({
      type: "worker-result-read-failed",
      path: "/scratch/compile-result.json",
      code: "ENOENT",
    });
  });

  it("accepts the closed versioned success envelope", () => {
    const result = parseCompileWorkerEnvelope(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: compiled,
    }));

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success).toEqual({ schemaVersion: 1, ok: true, result: compiled });
  });

  it("rejects a compile result carrying the previous WorkflowIR version", () => {
    const result = parseCompileWorkerEnvelope(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      result: {
        ...compiled,
        ir: { ...compiled.ir, irVersion: 6 },
      },
    }));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected protocol failure");
    expect(result.failure.type).toBe("worker-result-invalid");
  });

  it.each([
    ["invalid JSON", "{", "worker-result-invalid-json"],
    ["unknown version", JSON.stringify({ schemaVersion: 2, ok: true, result: compiled }), "worker-result-invalid"],
    ["extra envelope field", JSON.stringify({ schemaVersion: 1, ok: true, result: compiled, extra: true }), "worker-result-invalid"],
    ["invalid digest", JSON.stringify({ schemaVersion: 1, ok: true, result: { ...compiled, sourceDigest: "sha256:no" } }), "worker-result-invalid"],
    ["unknown error tag", JSON.stringify({ schemaVersion: 1, ok: false, error: { type: "mystery", message: "no" } }), "worker-result-invalid"],
    ["extra source-change field", JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: {
        type: "workflow-source-changed",
        entry: "/workspace/workflow.ts",
        message: "changed",
        actual: "sha256:unexpected",
      },
    }), "worker-result-invalid"],
  ])("rejects %s", (_name, raw, type) => {
    const result = parseCompileWorkerEnvelope(raw);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected protocol failure");
    expect(result.failure.type).toBe(type);
  });

  it("accepts reported Core findings in any order alongside compiler diagnostics", () => {
    const ir = invalidNestedIr();
    const findings = validateWorkflowIR(ir);
    const compilerDiagnostic: DiagnosticIR = {
      code: "BUILD001",
      severity: "error",
      message: "Lowering failed.",
      path: "root",
    };
    ir.diagnostics = [
      compilerDiagnostic,
      ...[...findings].reverse(),
      findings[0]!,
    ];

    const result = parseIr(ir);

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success.ok && result.success.result.ir.diagnostics).toEqual(ir.diagnostics);
  });

  it("rejects a worker IR that omits one of several Core findings", () => {
    const ir = invalidNestedIr();
    ir.diagnostics = validateWorkflowIR(ir).slice(0, 1);

    const result = parseIr(ir);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected protocol failure");
    expect(result.failure.type).toBe("worker-result-invalid");
  });

  it("rejects malformed diagnostics even when their Core finding is reported", () => {
    const ir = {
      ...compiled.ir,
      diagnostics: [null],
    } as unknown as WorkflowIR;
    ir.diagnostics.push(...validateWorkflowIR(ir));

    const result = parseIr(ir);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected protocol failure");
    expect(result.failure.type).toBe("worker-result-invalid");
  });

  it("accepts a warning-only IR when the Core warning is reported", () => {
    const ir: WorkflowIR = {
      ...compiled.ir,
      name: "not identifier like",
      diagnostics: [],
    };
    ir.diagnostics = validateWorkflowIR(ir);

    const result = parseIr(ir);

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success.ok && result.success.result.ir.diagnostics).toEqual(ir.diagnostics);
  });

  it("rejects an exit/envelope mismatch", () => {
    const result = interpretCompileWorkerOutput({
      ok: true,
      exitCode: 1,
      signal: null,
      stdoutTail: "stdout",
      stderrTail: "stderr",
    }, JSON.stringify({ schemaVersion: 1, ok: true, result: compiled }), compiled.sourceDigest);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected protocol failure");
    expect(result.failure).toEqual({
      type: "worker-result-invalid",
      message: "Workflow compile worker exited unsuccessfully with a success result.",
      stdoutTail: "stdout",
      stderrTail: "stderr",
    });
  });

  it("returns a serialized module failure only with an unsuccessful exit", () => {
    const failure = {
      type: "invalid-default-export" as const,
      entry: "/workspace/workflow.ts",
      message: "invalid export",
    };
    const result = interpretCompileWorkerOutput({
      ok: true,
      exitCode: 1,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
    }, JSON.stringify({ schemaVersion: 1, ok: false, error: failure }), compiled.sourceDigest);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected module failure");
    expect(result.failure).toEqual(failure);
  });

  it("rejects a worker source digest that differs from the checked source", () => {
    const result = interpretCompileWorkerOutput({
      ok: true,
      exitCode: 0,
      signal: null,
      stdoutTail: "stdout",
      stderrTail: "stderr",
    }, JSON.stringify({ schemaVersion: 1, ok: true, result: compiled }), `sha256:${"b".repeat(64)}`);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("expected digest mismatch");
    expect(result.failure).toEqual({
      type: "worker-result-invalid",
      message: "Workflow compile worker source digest did not match the checked source digest.",
      stdoutTail: "stdout",
      stderrTail: "stderr",
    });
  });

  it("accepts the closed source-generation failure shape", () => {
    const failure = {
      type: "workflow-source-changed",
      entry: "/workspace/workflow.ts",
      message: "changed",
    };

    const result = parseCompileWorkerEnvelope(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: failure,
    }));

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    expect(result.success).toEqual({ schemaVersion: 1, ok: false, error: failure });
  });
});

function completedProcess(exitCode: number) {
  return {
    ok: true as const,
    exitCode,
    signal: null,
    stdoutTail: "stdout",
    stderrTail: "stderr",
  };
}

function invalidNestedIr(): WorkflowIR {
  return {
    ...compiled.ir,
    root: {
      ...compiled.ir.root,
      nodes: [{
        id: "bad id",
        kind: "task",
        run: null,
      }],
    },
    diagnostics: [],
  } as unknown as WorkflowIR;
}

function parseIr(ir: WorkflowIR) {
  return parseCompileWorkerEnvelope(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    result: { ...compiled, ir },
  }));
}
