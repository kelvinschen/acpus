import { describe, expect, it } from "vitest";
import {
  classifyCompileWorkerResultReadFailure,
  interpretCompileWorkerOutput,
  parseCompileWorkerEnvelope,
} from "../src/compiler/worker.js";

const compiled = {
  sourceDigest: `sha256:${"a".repeat(64)}`,
  ir: {
    irVersion: 5 as const,
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

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error(result.error.message);
    expect(result.value).toEqual({ schemaVersion: 1, ok: true, result: compiled });
  });

  it.each([
    ["invalid JSON", "{", "worker-result-invalid-json"],
    ["unknown version", JSON.stringify({ schemaVersion: 2, ok: true, result: compiled }), "worker-result-invalid"],
    ["extra envelope field", JSON.stringify({ schemaVersion: 1, ok: true, result: compiled, extra: true }), "worker-result-invalid"],
    ["invalid digest", JSON.stringify({ schemaVersion: 1, ok: true, result: { ...compiled, sourceDigest: "sha256:no" } }), "worker-result-invalid"],
    ["unknown error tag", JSON.stringify({ schemaVersion: 1, ok: false, error: { type: "mystery", message: "no" } }), "worker-result-invalid"],
  ])("rejects %s", (_name, raw, type) => {
    const result = parseCompileWorkerEnvelope(raw);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected protocol failure");
    expect(result.error.type).toBe(type);
  });

  it("rejects an exit/envelope mismatch", () => {
    const result = interpretCompileWorkerOutput({
      ok: true,
      exitCode: 1,
      signal: null,
      stdoutTail: "stdout",
      stderrTail: "stderr",
    }, JSON.stringify({ schemaVersion: 1, ok: true, result: compiled }));

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected protocol failure");
    expect(result.error).toEqual({
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
    }, JSON.stringify({ schemaVersion: 1, ok: false, error: failure }));

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected module failure");
    expect(result.error).toEqual(failure);
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
