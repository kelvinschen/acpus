import { Readable } from "node:stream";
import { errAsync, ok, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectionCandidates } from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

const daemon = vi.hoisted(() => ({
  sendDaemonControl: vi.fn(),
  daemonControlRequestId: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ readInspection: vi.fn() }));

vi.mock("../src/commands/daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/commands/daemon.js")>(),
  sendDaemonControl: daemon.sendDaemonControl,
  daemonControlRequestId: daemon.daemonControlRequestId,
}));
vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  readInspection: runtime.readInspection,
}));

const run = {
  id: "run_1",
  name: "review",
  status: "running" as const,
  workflowEntry: "review.workflow.ts",
  sourceGraphDigest: "sha256:review",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:01.000Z",
  progressVersion: 2,
  input: {},
  hooks: [],
  eventCount: 8,
  nodeCount: 1,
  execution: { state: "active" as const, lastStatus: "running" as const, reason: "run_lease_active" as const },
};

describe("runs steer", () => {
  beforeEach(() => {
    daemon.daemonControlRequestId.mockReset().mockReturnValue("cli:steer-1");
    daemon.sendDaemonControl.mockReset().mockReturnValue(okAsync({
      type: "steer",
      state: "applied",
      run,
      steerId: "cli:steer-1",
      requestedTarget: "@1a2b3c4d5e6f",
      target: "review~abc",
      fencedAttemptId: "attempt_1",
      continuation: "queued",
    }));
    runtime.readInspection.mockReset();
  });

  it("sends the exact correction and emits a redacted text receipt", async () => {
    const result = await runCommand(["steer", "run_1", "--target", "@1a2b3c4d5e6f", "--instruction", "SECRET correction"]);

    expect(daemon.sendDaemonControl).toHaveBeenCalledWith("/workspace", {
      requestId: "cli:steer-1",
      type: "steer",
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      instruction: "SECRET correction",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Steer: cli:steer-1");
    expect(result.stdout).toContain("Target: @1a2b3c4d5e6f");
    expect(result.stdout).toContain("Continuation: queued");
    expect(result.stdout).toContain("Next: acpus runs inspect run_1 --target @1a2b3c4d5e6f --await-decision");
    expect(result.stdout).not.toContain("SECRET correction");
    expect(result.stdout).not.toContain("review~abc");
    expect(result.stdout).not.toContain("attempt_1");
    expect(result.stderr).toBe("");
  });

  it("rejects blank targets and instructions before contacting the daemon", async () => {
    await expect(runCommand(["steer", "run_1", "--target", " ", "--instruction", "correct it"])).rejects.toMatchObject({
      exitCode: 2,
      result: { ok: false, phase: "usage" },
    });
    await expect(runCommand(["steer", "run_1", "--target", "review", "--instruction", " \n"])).rejects.toMatchObject({
      exitCode: 2,
      result: { ok: false, phase: "usage" },
    });
    expect(daemon.sendDaemonControl).not.toHaveBeenCalled();
  });

  it("renders a short-ref candidate view instead of daemon candidate keys for an ambiguous control", async () => {
    daemon.sendDaemonControl.mockReturnValue(errAsync({
      type: "control-failed",
      code: "RUN_NOT_CONTROLLABLE",
      controlType: "retry",
      runId: "run_1",
      run: undefined,
      cause: {
        type: "rejected",
        code: "RUN_NOT_CONTROLLABLE",
        ambiguity: true,
        message: "Scheduler retry target 'review' is ambiguous. Candidate target keys: review~one, review~two.",
      },
      message: "Control 'retry' for run 'run_1' failed with RUN_NOT_CONTROLLABLE: Scheduler retry target 'review' is ambiguous. Candidate target keys: review~one, review~two.",
    }));
    runtime.readInspection.mockResolvedValue(ok(candidates()));

    const text = await runCliCommand(["runs", "retry", "run_1", "--target", "review"]);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("@1a2b3c4d5e6f");
    expect(text.stderr).toContain("Select: acpus runs inspect run_1 --target @1a2b3c4d5e6f");
    expect(text.stderr).toContain("Select one @ref from the candidate view.");
    expect(text.stderr).not.toContain("review~one");
    expect(text.stderr).not.toContain("review~two");

  });

  it("preserves a non-ambiguous daemon failure without querying candidates", async () => {
    daemon.sendDaemonControl.mockReturnValue(errAsync({
      type: "control-failed",
      code: "EXECUTION_UNAVAILABLE",
      controlType: "retry",
      runId: "run_1",
      run: undefined,
      cause: {
        type: "rejected",
        code: "EXECUTION_UNAVAILABLE",
        message: "Daemon is restarting.",
      },
      message: "Control 'retry' for run 'run_1' failed with EXECUTION_UNAVAILABLE: Daemon is restarting.",
    }));

    const result = await runCliCommand(["runs", "retry", "run_1", "--target", "review"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Daemon is restarting.");
    expect(result.stderr).not.toContain("Select: acpus runs inspect");
    expect(runtime.readInspection).not.toHaveBeenCalled();
  });
});

async function runCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let exitCode = -1;
  const command = createRunsCommand({
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout,
    stderr,
    setExitCode: code => { exitCode = code; },
  });
  await command.parseAsync(argv, { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function runCliCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(argv, {
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function candidates(): InspectionCandidates {
  return {
    kind: "candidates",
    run: { id: "run_1", status: "running" },
    target: "review",
    entries: [{
      selector: "@1a2b3c4d5e6f",
      status: "running",
      breadcrumb: "batch[0] › review",
    }, {
      selector: "@6f5e4d3c2b1a",
      status: "completed",
      breadcrumb: "batch[1] › review",
    }],
    page: 1,
    total: 2,
  };
}
