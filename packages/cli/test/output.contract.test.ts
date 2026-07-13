import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { summarizeWorkflow, writeResult, type CliResult } from "../src/output.js";
import { CaptureStream } from "./support/capture-stream.js";

describe("CLI result output contracts", () => {
  it("renders fork output around the child run identity", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(writeResult({
      ok: true,
      phase: "control",
      message: "Fork run created.",
      control: { type: "fork", state: "applied", sourceRunId: "run_source" },
      run: {
        id: "run_child",
        name: "forked",
        status: "pending",
        workflowEntry: "fixed.workflow.ts",
        sourceGraphDigest: "sha256:fork",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
        progressVersion: 0,
      },
      followRunId: "run_child",
    }, "text", { stdout, stderr }, 0)).toBe(0);

    expect(stdout.text).toBe([
      "Fork run created.",
      "Source run: run_source",
      "Fork run: run_child",
      "Fork status: pending",
      "Workflow entry: fixed.workflow.ts",
      "Next: acpus runs inspect run_child --follow",
      "",
    ].join("\n"));
    expect(stderr.text).toBe("");
  });

  it("renders consumed Signal validation without echoing payload", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(writeResult({
      ok: true,
      phase: "control",
      message: "Signal consumed.",
      control: {
        type: "signal",
        state: "consumed",
        runId: "run_1",
        requestedTarget: "approve",
        target: "approve~abc",
        validation: { kind: "schema", schemaSummary: "{ approved: boolean }" },
      },
      run: {
        id: "run_1",
        name: "approval",
        status: "running",
        workflowEntry: "approval.workflow.ts",
        sourceGraphDigest: "sha256:signal",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:01.000Z",
        progressVersion: 1,
      },
      followRunId: "run_1",
    }, "text", { stdout, stderr }, 0)).toBe(0);

    expect(stdout.text).toBe([
      "Signal consumed.",
      "Run: run_1",
      "Target: approve → approve~abc",
      "Payload: validated against { approved: boolean }",
      "Status: running",
      "Workflow entry: approval.workflow.ts",
      "Next: acpus runs inspect run_1 --follow",
      "",
    ].join("\n"));
    expect(stdout.text).not.toContain("secret-payload");
    expect(stderr.text).toBe("");
  });

  it("renders targeted and run-level retry without inventing a root target", () => {
    const run = {
      id: "run_1",
      name: "retry",
      status: "pending" as const,
      workflowEntry: "retry.workflow.ts",
      sourceGraphDigest: "sha256:retry",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:01.000Z",
      progressVersion: 2,
    };
    for (const [control, targetLine] of [
      [{ type: "retry", state: "applied", runId: "run_1", target: "review~abc" } as const, "Target: review~abc\n"],
      [{ type: "retry", state: "applied", runId: "run_1" } as const, ""],
    ] as const) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(writeResult({ ok: true, phase: "control", message: "Retry applied.", control, run, followRunId: run.id }, "text", { stdout, stderr }, 0)).toBe(0);
      expect(stdout.text).toBe(`Retry applied.\nRun: run_1\n${targetLine}Status: pending\nWorkflow entry: retry.workflow.ts\nNext: acpus runs inspect run_1 --follow\n`);
      expect(stdout.text).not.toContain("retryd");
      expect(stdout.text).not.toContain("retried");
      if (targetLine === "") expect(stdout.text).not.toContain("Target:");
      expect(stderr.text).toBe("");
    }
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

  it("renders relative sourced diagnostics with indented path, continuation, and hint", () => {
    const result: CliResult = {
      ok: false,
      phase: "validate",
      message: "Workflow validation failed.",
      diagnostics: [{
        code: "ID001",
        severity: "error",
        message: "Invalid node id.\nUse a stable graph identity.",
        path: "root.nodes.bad id",
        source: {
          file: "/workspace/src/workflow.ts",
          line: 7,
          column: 11,
        },
        hint: "Use a compile-time stable node id.\nFor example: step(\"review\").",
      }],
    };
    const textStdout = new CaptureStream();
    const textStderr = new CaptureStream();

    expect(writeResult(result, "text", { stdout: textStdout, stderr: textStderr, cwd: "/workspace" }, 1)).toBe(1);
    expect(textStdout.text).toBe("");
    expect(textStderr.text).toBe([
      "Workflow validation failed.",
      "src/workflow.ts:7:11 [error ID001] Invalid node id.",
      "  Use a stable graph identity.",
      "  path: root.nodes.bad id",
      "  hint: Use a compile-time stable node id.",
      "  For example: step(\"review\").",
      "",
    ].join("\n"));

    const jsonStdout = new CaptureStream();
    const jsonStderr = new CaptureStream();

    expect(writeResult(result, "json", { stdout: jsonStdout, stderr: jsonStderr, cwd: "/workspace" }, 1)).toBe(1);
    expect(JSON.parse(jsonStdout.text)).toEqual(result);
    expect(JSON.parse(jsonStdout.text).diagnostics[0].source.file).toBe("/workspace/src/workflow.ts");
    expect(jsonStderr.text).toBe("");
  });

  it("keeps outside absolute paths and renders source-less diagnostics without a prefix", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const result: CliResult = {
      ok: false,
      phase: "validate",
      message: "Workflow validation failed.",
      diagnostics: [{
        code: "TS2322",
        severity: "error",
        message: "Outside source.",
        source: { file: "/outside/helper.ts", line: 2, column: 4 },
      }, {
        code: "ID001",
        severity: "error",
        message: "No source.",
      }, {
        code: "AL001",
        severity: "error",
        message: "Already relative.",
        source: { file: "workflow.ts", line: 1, column: 2 },
      }],
    };

    writeResult(result, "text", { stdout, stderr, cwd: "/workspace" }, 1);

    expect(stderr.text).toContain("/outside/helper.ts:2:4 [error TS2322] Outside source.");
    expect(stderr.text).toContain("[error ID001] No source.");
    expect(stderr.text).toContain("workflow.ts:1:2 [error AL001] Already relative.");
  });

  it("prints failed-check counts once and does not duplicate workflow summary counts", () => {
    const failedStdout = new CaptureStream();
    const failedStderr = new CaptureStream();
    writeResult({
      ok: false,
      phase: "check",
      message: "Workflow check failed.",
      diagnostics: [
        { code: "AL001", severity: "error", message: "error" },
        { code: "W", severity: "warning", message: "warning" },
        { code: "I", severity: "info", message: "info" },
      ],
    }, "text", { stdout: failedStdout, stderr: failedStderr }, 1);
    expect(failedStderr.text.match(/Diagnostics:/g)).toHaveLength(1);
    expect(failedStderr.text).toContain("Diagnostics: 1 errors, 1 warnings, 1 infos.");

    const summaryStdout = new CaptureStream();
    const summaryStderr = new CaptureStream();
    const summary = checkResult();
    summary.diagnostics = [{ code: "I", severity: "info", message: "info" }];
    writeResult(summary, "text", { stdout: summaryStdout, stderr: summaryStderr }, 0);
    expect(summaryStdout.text.match(/Diagnostics:/g)).toHaveLength(1);
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
