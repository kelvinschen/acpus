import { describe, expect, it } from "vitest";
import { writeResult, type CliResult } from "../src/output.js";
import { CaptureStream } from "./support/capture-stream.js";

describe("CLI result output contracts", () => {
  it("writes stable JSON results to stdout", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult(checkResult(), "json", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: true,
      phase: "check",
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
        hooks: [],
        eventCount: 2,
        nodeCount: 1,
      },
    }, "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Run inspected.");
    expect(stdout.text).toContain("Run: run_1");
    expect(stdout.text).toContain("Status: completed");
    expect(stdout.text).toContain("Output: {\"ready\":true}");
    expect(stderr.text).toBe("");
  });

  it("renders compact agent metadata omission in run inspection text", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult({
      ok: true,
      phase: "inspect",
      message: "Run inspected.",
      run: {
        id: "run_1",
        name: "agent-run",
        status: "completed",
        workflowEntry: "/tmp/workflow.ts",
        irDigest: "sha256:ir",
        sourceGraphDigest: "sha256:graph",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:01.000Z",
        input: {},
        output: { ok: true },
        hooks: [],
        eventCount: 4,
        nodeCount: 1,
        dynamic: {
          version: 1,
          frames: [],
          nodeInstances: [],
          attempts: [],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [{
            id: 1,
            attemptId: "attempt_1",
            kind: "agent_attempt",
            createdAt: "2026-06-29T00:00:01.000Z",
            metadata: {
              nodeKey: "review.dynamic",
              promptArtifact: { relativePath: "artifacts/review.dynamic/attempt-1/agent/turn-001.prompt.md" },
            },
          }],
        },
      },
    }, "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Agent attempt details omitted: 1. Use --json for full metadata.");
    expect(stdout.text).not.toContain("artifacts/review.dynamic/attempt-1/agent/turn-001.prompt.md");
    expect(stderr.text).toBe("");
  });

  it("preserves agent metadata unchanged in JSON output", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const metadata = {
      nodeKey: "review.dynamic",
      turns: [{
        turn: 1,
        rawAcpDebugArtifact: {
          artifactId: "artifact_raw",
          relativePath: "artifacts/review.dynamic/attempt-1/agent/turn-001.raw-acp.jsonl",
          mediaType: "application/x-ndjson",
        },
      }],
    };
    const exitCode = writeResult({
      ok: true,
      phase: "inspect",
      message: "Run inspected.",
      run: {
        id: "run_1",
        name: "agent-run",
        status: "completed",
        workflowEntry: "/tmp/workflow.ts",
        irDigest: "sha256:ir",
        sourceGraphDigest: "sha256:graph",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:01.000Z",
        input: {},
        hooks: [],
        eventCount: 1,
        nodeCount: 1,
        dynamic: {
          version: 1,
          frames: [],
          nodeInstances: [],
          attempts: [],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [{
            id: 1,
            kind: "agent_attempt",
            metadata,
            createdAt: "2026-06-29T00:00:01.000Z",
          }],
        },
      },
    }, "json", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      run: {
        dynamic: {
          executionMetadata: [{
            kind: "agent_attempt",
            metadata,
          }],
        },
      },
    });
    expect(stderr.text).toBe("");
  });

  it("writes text check summaries and failed results to the correct streams", () => {
    const checkStdout = new CaptureStream();
    const checkStderr = new CaptureStream();

    expect(writeResult(checkResult(), "text", { stdout: checkStdout, stderr: checkStderr }, 0)).toBe(0);
    expect(checkStdout.text).toContain("Workflow check passed.");
    expect(checkStdout.text).toContain("Workflow: cli-valid");
    expect(checkStdout.text).not.toContain("Preflight:");
    expect(checkStdout.text).toContain("IR digest: sha256:");
    expect(checkStderr.text).toBe("");

    const failedStdout = new CaptureStream();
    const failedStderr = new CaptureStream();
    expect(writeResult({ ok: false, phase: "usage", message: "Bad input." }, "text", { stdout: failedStdout, stderr: failedStderr }, 2)).toBe(2);
    expect(failedStdout.text).toBe("");
    expect(failedStderr.text).toBe("Bad input.\n");
  });

  it("renders diagnostic hints in text output and preserves them in JSON", () => {
    const result: CliResult = {
      ok: false,
      phase: "validate",
      message: "Workflow validation failed.",
      diagnostics: [{
        code: "ID001",
        severity: "error",
        message: "Invalid node id.",
        path: "root.nodes.bad id",
        source: {
          file: "/tmp/workflow.ts",
          line: 7,
          column: 11,
        },
        hint: "Use a compile-time stable node id.",
      }],
    };
    const textStdout = new CaptureStream();
    const textStderr = new CaptureStream();

    expect(writeResult(result, "text", { stdout: textStdout, stderr: textStderr }, 1)).toBe(1);

    expect(textStdout.text).toBe("");
    expect(textStderr.text).toContain("[error] ID001 root.nodes.bad id: Invalid node id.");
    expect(textStderr.text).toContain("source: /tmp/workflow.ts:7:11");
    expect(textStderr.text).toContain("hint: Use a compile-time stable node id.");

    const jsonStdout = new CaptureStream();
    const jsonStderr = new CaptureStream();

    expect(writeResult(result, "json", { stdout: jsonStdout, stderr: jsonStderr }, 1)).toBe(1);
    expect(JSON.parse(jsonStdout.text)).toMatchObject({
      diagnostics: [expect.objectContaining({
        hint: "Use a compile-time stable node id.",
        source: {
          file: "/tmp/workflow.ts",
          line: 7,
          column: 11,
        },
      })],
    });
    expect(jsonStderr.text).toBe("");
  });
});

function checkResult(): CliResult {
  return {
    ok: true,
    phase: "check",
    message: "Workflow check passed.",
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
    irDigest: "sha256:abc",
    sourceGraphDigest: "sha256:def",
  };
}
