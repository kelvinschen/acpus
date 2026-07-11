import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { summarizeWorkflow, writeResult, type CliResult } from "../src/output.js";
import { CaptureStream } from "./support/capture-stream.js";

describe("CLI result output contracts", () => {
  it("renders an exact follow next step when a command returns a live run", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(writeResult({
      ok: true,
      phase: "control",
      message: "Run forked.",
      forkRunId: "run_child",
      followRunId: "run_child",
    }, "text", { stdout, stderr }, 0)).toBe(0);

    expect(stdout.text).toContain("Next: acpus runs inspect run_child --follow");
    expect(stderr.text).toBe("");
  });

  it("counts nested workflow nodes in summaries", () => {
    const ir: WorkflowIR = {
      irVersion: 4,
      name: "nested",
      agents: {},
      root: {
        nodes: [{
          id: "choose",
          kind: "if",
          condition: { kind: "literal", value: true },
          then: {
            nodes: [{
              id: "then_task",
              kind: "task",
              run: { input: {}, target: { kind: "inline", source: "async function task() {}" } },
            }],
          },
          else: { nodes: [{ id: "otherwise", kind: "assert", condition: { kind: "literal", value: true } }] },
        }, {
          id: "after",
          kind: "assert",
          condition: { kind: "literal", value: true },
        }],
      },
      outputs: {},
      diagnostics: [],
    };

    expect(summarizeWorkflow(ir).nodeCount).toBe(4);
  });

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
        description: "Validate CLI workflow summaries.",
        irVersion: 4,
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

  it("writes workflow summaries with explicit static node wording", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult(checkResult(), "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Workflow check passed.");
    expect(stdout.text).toContain("Description: Validate CLI workflow summaries.");
    expect(stdout.text).toContain("Static nodes: 1");
    expect(stdout.text).not.toContain("Nodes: 1");
    expect(stderr.text).toBe("");
  });

  it("writes text summaries for commands that return a run record", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      run: {
        id: "run_1",
        name: "cli-valid",
        status: "running",
        workflowEntry: "/tmp/workflow.ts",
        sourceGraphDigest: "sha256:graph",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:01.000Z",
        progressVersion: 0,
      },
    }, "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Run admitted in background.");
    expect(stdout.text).toContain("Run: run_1");
    expect(stdout.text).toContain("Status: running");
    expect(stdout.text).toContain("Workflow entry: /tmp/workflow.ts");
    expect(stderr.text).toBe("");
  });

  it("writes text check summaries and failed results to the correct streams", () => {
    const checkStdout = new CaptureStream();
    const checkStderr = new CaptureStream();

    expect(writeResult(checkResult(), "text", { stdout: checkStdout, stderr: checkStderr }, 0)).toBe(0);
    expect(checkStdout.text).toContain("Workflow check passed.");
    expect(checkStdout.text).toContain("Workflow: cli-valid");
    expect(checkStdout.text).not.toContain("Preflight:");
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
      description: "Validate CLI workflow summaries.",
      irVersion: 4,
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
    sourceGraphDigest: "sha256:def",
  };
}
