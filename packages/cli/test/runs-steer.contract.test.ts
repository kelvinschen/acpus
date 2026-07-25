import { Readable } from "node:stream";
import { okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRunsCommand } from "../src/commands/runs.js";
import { CaptureStream } from "./support/capture-stream.js";

const daemon = vi.hoisted(() => ({
  sendDaemonControl: vi.fn(),
  daemonControlRequestId: vi.fn(),
}));

vi.mock("../src/commands/daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/commands/daemon.js")>(),
  sendDaemonControl: daemon.sendDaemonControl,
  daemonControlRequestId: daemon.daemonControlRequestId,
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
      requestedTarget: "review",
      target: "review~abc",
      fencedAttemptId: "attempt_1",
      continuation: "queued",
    }));
  });

  it("sends the exact correction and emits a redacted JSON receipt", async () => {
    const result = await runCommand(["steer", "run_1", "--target", "review", "--instruction", "SECRET correction", "--json"]);

    expect(daemon.sendDaemonControl).toHaveBeenCalledWith("/workspace", {
      requestId: "cli:steer-1",
      type: "steer",
      runId: "run_1",
      target: "review",
      instruction: "SECRET correction",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
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
    });
    expect(result.stdout).not.toContain("SECRET correction");
    expect(result.stderr).toBe("");
  });

  it("renders the resolved target in the follow command without echoing the instruction", async () => {
    const result = await runCommand(["steer", "run_1", "--target", "review", "--instruction", "SECRET correction"]);

    expect(result.stdout).toContain("Steer: cli:steer-1");
    expect(result.stdout).toContain("Target: review → review~abc");
    expect(result.stdout).toContain("Fenced attempt: attempt_1");
    expect(result.stdout).toContain("Continuation: queued");
    expect(result.stdout).toContain("Next: acpus runs inspect run_1 --target review~abc --follow");
    expect(result.stdout).not.toContain("SECRET correction");
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
