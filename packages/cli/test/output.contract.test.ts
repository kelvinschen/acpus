import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
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

  it("renders a steer receipt and follows the resolved target without echoing its instruction", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(writeResult({
      ok: true,
      phase: "control",
      message: "Attempt fenced; correction queued.",
      control: {
        type: "steer",
        state: "applied",
        runId: "run_1",
        steerId: "cli:steer-1",
        requestedTarget: "review",
        target: "review~abc",
        fencedAttemptId: "attempt_1",
        continuation: "queued",
      },
      run: {
        id: "run_1",
        name: "review",
        status: "running",
        workflowEntry: "review.workflow.ts",
        sourceGraphDigest: "sha256:review",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
        progressVersion: 2,
      },
      followRunId: "run_1",
    }, "text", { stdout, stderr }, 0)).toBe(0);

    expect(stdout.text).toBe([
      "Attempt fenced; correction queued.",
      "Run: run_1",
      "Steer: cli:steer-1",
      "Target: review → review~abc",
      "Fenced attempt: attempt_1",
      "Continuation: queued",
      "Status: running",
      "Workflow entry: review.workflow.ts",
      "Next: acpus runs inspect run_1 --target review~abc --follow",
      "",
    ].join("\n"));
    expect(stdout.text).not.toContain("SECRET correction");
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
      irVersion: 6,
      name: "nested",
      agents: {},
      root: {
        output: { kind: "object", fields: {} },
        nodes: [{
          id: "choose",
          kind: "if",
          condition: { kind: "literal", value: true },
          then: {
            output: { kind: "object", fields: {} },
            nodes: [{
              id: "then_task",
              kind: "task",
              run: { input: {}, target: { kind: "inline", source: "async function task() {}" } },
            }],
          },
          else: { output: { kind: "object", fields: {} }, nodes: [{ id: "otherwise", kind: "assert", condition: { kind: "literal", value: true } }] },
        }, {
          id: "after",
          kind: "assert",
          condition: { kind: "literal", value: true },
        }],
      },

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
        irVersion: 6,
        nodeCount: 1,
        outputShape: { kind: "object", possibleKeys: ["ready"] },
        diagnostics: {
          errors: 0,
          warnings: 0,
        },
      },
    });
    expect(stderr.text).toBe("");
  });

  it("aligns Doctor status, area, and message columns", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(writeResult({
      ok: true,
      phase: "doctor",
      message: "Doctor checks passed.",
      persistence: { path: "/home/alice/.acpus/workspaces/0123456789abcdef0123456789abcdef" },
      checks: [
        { status: "ok", area: "workspace", message: "Workspace resolved." },
        { status: "warn", area: "store", message: "Runtime store needs attention." },
      ],
    }, "text", { stdout, stderr }, 0)).toBe(0);

    expect(stdout.text).toBe([
      "Doctor checks passed.",
      "Persistence: /home/alice/.acpus/workspaces/0123456789abcdef0123456789abcdef",
      "ok    workspace  Workspace resolved.",
      "warn  store      Runtime store needs attention.",
      "",
    ].join("\n"));
    expect(stderr.text).toBe("");
  });

  it("colors Doctor semantics in a TTY without changing visible column alignment", () => {
    const report = {
      ok: true,
      phase: "doctor",
      message: "Doctor checks passed.",
      persistence: { path: "/home/alice/.acpus/workspaces/0123456789abcdef0123456789abcdef" },
      checks: [
        { status: "ok", area: "workspace", message: "Workspace resolved." },
        { status: "warn", area: "store", message: "Runtime store needs attention." },
      ],
    } satisfies CliResult;
    const plain = [
      "Doctor checks passed.",
      "Persistence: /home/alice/.acpus/workspaces/0123456789abcdef0123456789abcdef",
      "ok    workspace  Workspace resolved.",
      "warn  store      Runtime store needs attention.",
      "",
    ].join("\n");
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const stdout = new TtyCaptureStream();
      const stderr = new TtyCaptureStream();
      expect(writeResult(report, "text", { stdout, stderr }, 0)).toBe(0);
      expect(stdout.text).toBe([
        "\u001b[32mDoctor checks passed.\u001b[0m",
        "\u001b[36mPersistence:\u001b[0m \u001b[1m/home/alice/.acpus/workspaces/0123456789abcdef0123456789abcdef\u001b[0m",
        "\u001b[32mok  \u001b[0m  \u001b[36mworkspace\u001b[0m  Workspace resolved.",
        "\u001b[33mwarn\u001b[0m  \u001b[36mstore    \u001b[0m  Runtime store needs attention.",
        "",
      ].join("\n"));
      expect(stripVTControlCharacters(stdout.text)).toBe(plain);
      expect(stderr.text).toBe("");

      const jsonStdout = new TtyCaptureStream();
      expect(writeResult(report, "json", {
        stdout: jsonStdout,
        stderr: new TtyCaptureStream(),
      }, 0)).toBe(0);
      expect(JSON.parse(jsonStdout.text)).toMatchObject({ ok: true, phase: "doctor" });
      expect(jsonStdout.text).not.toContain("\u001b");

      const failedStderr = new TtyCaptureStream();
      expect(writeResult({
        ok: false,
        phase: "doctor",
        message: "Doctor checks failed.",
        checks: [{ status: "fail", area: "store", message: "Runtime store unreadable." }],
      }, "text", { stdout: new TtyCaptureStream(), stderr: failedStderr }, 1)).toBe(1);
      expect(failedStderr.text).toBe([
        "\u001b[31mDoctor checks failed.\u001b[0m",
        "\u001b[31mfail\u001b[0m  \u001b[36mstore\u001b[0m  Runtime store unreadable.",
        "",
      ].join("\n"));

      process.env.NO_COLOR = "1";
      const noColorStdout = new TtyCaptureStream();
      expect(writeResult(report, "text", {
        stdout: noColorStdout,
        stderr: new TtyCaptureStream(),
      }, 0)).toBe(0);
      expect(noColorStdout.text).toBe(plain);
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("writes concise successful workflow check stages", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult(checkResult(), "text", { stdout, stderr }, 0);

    expect(exitCode).toBe(0);
    expect(stdout.text).toBe([
      "✓ typescript          0 errors",
      "✓ authoring rules     0 errors",
      "✓ WorkflowIR          0 errors · 1 static node",
      "",
    ].join("\n"));
    expect(stdout.text).not.toContain("Workflow: cli-valid");
    expect(stderr.text).toBe("");
  });

  it("writes terminal visualizations without generic summaries and preserves diagnostics", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const checked = checkResult();
    const result: CliResult = {
      ok: true,
      phase: "viz",
      message: "Workflow visualization rendered.",
      visualization: "semantic\ninput {}",
      workflow: checked.workflow!,
      diagnostics: [{ code: "VIZ001", severity: "info", message: "Visualization note." }],
    };

    expect(writeResult(result, "text", { stdout, stderr }, 0)).toBe(0);
    expect(stdout.text).toBe("semantic\ninput {}\n\n[info VIZ001] Visualization note.\n");
    expect(stdout.text).not.toContain("Workflow visualization rendered.");
    expect(stdout.text).not.toContain("Workflow: cli-valid");
    expect(stderr.text).toBe("");
  });

  it("writes text summaries for commands that return a run record", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = writeResult({
      ok: true,
      phase: "run",
      message: "Run admitted in background.",
      workflow: checkResult().workflow!,
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
    expect(checkStdout.text).toContain("✓ WorkflowIR          0 errors · 1 static node");
    expect(checkStdout.text).not.toContain("Workflow check passed.");
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
    expect(JSON.parse(jsonStdout.text)).toEqual({ schemaVersion: 1, ...result });
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

  it("counts mixed TypeScript and authoring errors without reordering diagnostics", () => {
    const failedStdout = new CaptureStream();
    const failedStderr = new CaptureStream();
    writeResult({
      ok: false,
      phase: "check",
      message: "Workflow check failed.",
      diagnostics: [
        { code: "TS2322", severity: "error", message: "first" },
        { code: "AL001", severity: "error", message: "second" },
        { code: "TB003", severity: "error", message: "third" },
        { code: "TS2339", severity: "error", message: "fourth" },
      ],
    }, "text", { stdout: failedStdout, stderr: failedStderr }, 1);
    expect(failedStdout.text).toBe("");
    expect(failedStderr.text).toBe([
      "✗ typescript          2 errors",
      "✗ authoring rules     2 errors",
      "– WorkflowIR          skipped",
      "[error TS2322] first",
      "[error AL001] second",
      "[error TB003] third",
      "[error TS2339] fourth",
      "",
    ].join("\n"));
    expect(failedStderr.text).not.toContain("Diagnostics:");
  });

  it("marks a clean check category passed when the other category fails", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    writeResult({
      ok: false,
      phase: "check",
      message: "Workflow check failed.",
      diagnostics: [{ code: "AL002", severity: "error", message: "Return .output." }],
    }, "text", { stdout, stderr }, 1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe([
      "✓ typescript          0 errors",
      "✗ authoring rules     1 error",
      "– WorkflowIR          skipped",
      "[error AL002] Return .output.",
      "",
    ].join("\n"));
  });

  it("separates check infrastructure failures from skipped analysis", () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    writeResult({
      ok: false,
      phase: "check",
      message: "Workflow check failed.",
      diagnostics: [{ code: "WF002", severity: "error", message: "TypeScript service unavailable." }],
    }, "text", { stdout, stderr }, 1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe([
      "✗ check infrastructure 1 error",
      "– typescript          skipped",
      "– authoring rules     skipped",
      "– WorkflowIR          skipped",
      "[error WF002] TypeScript service unavailable.",
      "",
    ].join("\n"));
  });

  it("renders compile, IR validation, and package-lock preparation failures", () => {
    const cases: Array<{ result: CliResult; expected: string[] }> = [{
      result: { ok: false, phase: "compile", message: "Worker exited before returning a result." },
      expected: [
        "✓ typescript          0 errors",
        "✓ authoring rules     0 errors",
        "✗ WorkflowIR          compile failed",
        "  Worker exited before returning a result.",
      ],
    }, {
      result: {
        ok: false,
        phase: "validate",
        message: "Workflow validation failed.",
        workflow: checkResult().workflow!,
        diagnostics: [
          { code: "IR003", severity: "error", message: "Invisible reference." },
          { code: "SC002", severity: "error", message: "Invalid schema." },
        ],
      },
      expected: [
        "✓ typescript          0 errors",
        "✓ authoring rules     0 errors",
        "✗ WorkflowIR          2 errors",
        "[error IR003] Invisible reference.",
        "[error SC002] Invalid schema.",
      ],
    }, {
      result: { ok: false, phase: "lock", message: "Cannot read pnpm-lock.yaml." },
      expected: [
        "✓ typescript          0 errors",
        "✓ authoring rules     0 errors",
        "✓ WorkflowIR          0 errors",
        "✗ package lock        read failed",
        "  Cannot read pnpm-lock.yaml.",
      ],
    }];
    for (const { result, expected } of cases) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      writeResult(result, "text", { stdout, stderr }, 1);
      expect(stdout.text).toBe("");
      expect(stderr.text).toBe(`${expected.join("\n")}\n`);
    }
  });

  it("keeps successful warnings visible without restoring generic metadata", () => {
    const summaryStdout = new CaptureStream();
    const summaryStderr = new CaptureStream();
    const summary = checkResult();
    summary.diagnostics = [{ code: "I", severity: "info", message: "info" }];
    writeResult(summary, "text", { stdout: summaryStdout, stderr: summaryStderr }, 0);
    expect(summaryStdout.text).toContain("✓ WorkflowIR          0 errors · 1 static node");
    expect(summaryStdout.text).toContain("[info I] info");
    expect(summaryStdout.text).not.toContain("Diagnostics:");
    expect(summaryStderr.text).toBe("");
  });
});

class TtyCaptureStream extends CaptureStream {
  readonly isTTY = true;
}

function checkResult(): CliResult {
  return {
    ok: true,
    phase: "check",
    message: "Workflow check passed.",
    workflow: {
      name: "cli-valid",
      description: "Validate CLI workflow summaries.",
      irVersion: 6,
      nodeCount: 1,
      outputShape: { kind: "object", possibleKeys: ["ready"] },
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
