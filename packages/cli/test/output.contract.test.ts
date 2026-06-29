import { describe, expect, it } from "vitest";
import { writeResult, type CliResult } from "../src/output.js";
import { CaptureStream } from "./support/capture-stream.js";

describe("CLI result output contracts", () => {
  it("writes stable JSON results to stdout", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult(dryRunResult(), "json", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: true,
      phase: "dry-run",
      workflow: {
        name: "cli-valid",
        irVersion: 2,
        nodeCount: 1,
        outputKeys: ["ready"],
        diagnostics: {
          errors: 0,
          warnings: 0,
        },
      },
      taskBundleCount: 0,
    });
    expect(stderr.text).toBe("");
  });

  it("writes text summaries for run inspection", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult({
      ok: true,
      phase: "inspect",
      message: "Run inspected.",
      run: {
        id: "run_1",
        name: "cli-valid",
        status: "completed",
        workflowEntry: "/tmp/workflow.ts",
        irDigest: "sha256:ir",
        sourceGraphDigest: "sha256:graph",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:01.000Z",
        input: { ready: true },
        output: { ready: true },
        eventCount: 2,
        nodeCount: 1,
        taskBundleCount: 0,
      },
    }, "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Run inspected.");
    expect(stdout.text).toContain("Run: run_1");
    expect(stdout.text).toContain("Status: completed");
    expect(stdout.text).toContain("Output: {\"ready\":true}");
    expect(stderr.text).toBe("");
  });

  it("writes text dry-run summaries and failed results to the correct streams", () => {
    const dryRunStdout = new CaptureStream();
    const dryRunStderr = new CaptureStream();

    expect(writeResult(dryRunResult(), "text", { stdout: dryRunStdout, stderr: dryRunStderr }, 0)).toBe(0);
    expect(dryRunStdout.text).toContain("Workflow dry-run passed.");
    expect(dryRunStdout.text).toContain("Workflow: cli-valid");
    expect(dryRunStdout.text).toContain("Preflight:");
    expect(dryRunStdout.text).toContain("IR digest: sha256:");
    expect(dryRunStderr.text).toBe("");

    const failedStdout = new CaptureStream();
    const failedStderr = new CaptureStream();
    expect(writeResult({ ok: false, phase: "usage", message: "Bad input." }, "text", { stdout: failedStdout, stderr: failedStderr }, 2)).toBe(2);
    expect(failedStdout.text).toBe("");
    expect(failedStderr.text).toBe("Bad input.\n");
  });
});

function dryRunResult(): CliResult {
  return {
    ok: true,
    phase: "dry-run",
    message: "Workflow dry-run passed.",
    workflow: {
      name: "cli-valid",
      irVersion: 2,
      nodeCount: 1,
      outputKeys: ["ready"],
      diagnostics: {
        total: 0,
        errors: 0,
        warnings: 0,
        infos: 0,
      },
    },
    diagnostics: [],
    preflightDir: "/tmp/preflight",
    irDigest: "sha256:abc",
    taskBundleCount: 0,
    sourceGraphDigest: "sha256:def",
  };
}
