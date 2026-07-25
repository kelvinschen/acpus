import { Readable } from "node:stream";
import { okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStream } from "./support/capture-stream.js";

const mock = vi.hoisted(() => ({
  cleanup: vi.fn<() => Promise<void>>(),
  prepareWorkflowForCli: vi.fn(),
  resolveWorkflowReference: vi.fn(),
  sendDaemonAdmitRun: vi.fn(),
  followRun: vi.fn(),
}));

vi.mock("../src/catalog.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/catalog.js")>(),
  resolveWorkflowReference: mock.resolveWorkflowReference,
}));
vi.mock("../src/workflow-preparation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/workflow-preparation.js")>(),
  prepareWorkflowForCli: mock.prepareWorkflowForCli,
}));
vi.mock("../src/commands/daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/commands/daemon.js")>(),
  sendDaemonAdmitRun: mock.sendDaemonAdmitRun,
}));
vi.mock("../src/run-follow.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/run-follow.js")>(),
  followRun: mock.followRun,
}));

import { createWorkflowCommand } from "../src/commands/workflow.js";

const globalSource = {
  kind: "global_catalog",
  name: "cleanup-run",
  digest: "a".repeat(64),
} as const;
const preparedGlobalSource = { ...globalSource, entry: "workflow.ts" } as const;

describe("workflow run snapshot cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.cleanup.mockResolvedValue(undefined);
    mock.resolveWorkflowReference.mockResolvedValue({
      workflow: "/private/snapshot/package/workflow.ts",
      sourceRoot: "/private/snapshot/package",
      source: globalSource,
      cleanup: mock.cleanup,
    });
    mock.prepareWorkflowForCli.mockResolvedValue({
      workflowPath: "/private/snapshot/package/workflow.ts",
      source: preparedGlobalSource,
      ir: {
        irVersion: 6,
        name: "cleanup-run",
        agents: {},
        root: {
          nodes: [],
          output: { kind: "object", fields: {} },
        },
        diagnostics: [],
      },
      irJson: "{}",
      sourceGraphDigest: "sha256:graph",
      lock: {},
    });
    mock.sendDaemonAdmitRun.mockReturnValue(okAsync({
      id: "run_admitted",
      name: "cleanup-run",
      status: "pending",
      workflowEntry: "workflow.ts",
      sourceGraphDigest: "sha256:graph",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      progressVersion: 0,
      input: { secret: "must-not-leak" },
      agentOverrides: {
        reviewer: {
          env: { TOKEN: "must-not-leak" },
        },
      },
      hooks: [],
      eventCount: 1,
      nodeCount: 0,
      execution: {
        state: "inactive",
        lastStatus: "pending",
        reason: "daemon_alive",
        daemonHeartbeatAt: "2026-07-24T00:00:00.000Z",
      },
    }));
    mock.followRun.mockResolvedValue({
      kind: "done",
      run: { status: "completed" },
    });
  });

  it.each(["check", "viz"] as const)("cleans the global snapshot after workflow %s", async action => {
    const setExitCode = vi.fn();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode,
    });

    await command.parseAsync([
      action,
      "cleanup-run",
      "--global",
      ...(action === "check" ? ["--json"] : []),
    ], { from: "user" });

    expect(mock.prepareWorkflowForCli).toHaveBeenCalledWith(
      "/private/snapshot/package/workflow.ts",
      "/workspace",
      { ref: globalSource, root: "/private/snapshot/package" },
    );
    expect(mock.cleanup).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });

  it("reports the admitted run id when snapshot cleanup fails", async () => {
    mock.cleanup.mockRejectedValue(new Error("cleanup denied"));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode: vi.fn(),
    });

    await expect(command.parseAsync([
      "run",
      "cleanup-run",
      "--global",
      "--background",
      "--json",
    ], { from: "user" })).rejects.toMatchObject({
      result: {
        ok: false,
        phase: "run",
        errorCode: "TEMPORARY_SOURCE_CLEANUP_FAILED",
        run: { id: "run_admitted" },
      },
    });
  });

  it("projects foreground JSON admission to the public run record", async () => {
    const stdout = new CaptureStream();
    const setExitCode = vi.fn();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr: new CaptureStream(),
      setExitCode,
    });

    await command.parseAsync([
      "run",
      "cleanup-run",
      "--global",
      "--json",
    ], { from: "user" });

    const [admission] = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(admission).toEqual({
      schemaVersion: 1,
      ok: true,
      phase: "run",
      kind: "admitted",
      run: {
        id: "run_admitted",
        name: "cleanup-run",
        status: "pending",
        workflowEntry: "workflow.ts",
        sourceGraphDigest: "sha256:graph",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        progressVersion: 0,
      },
    });
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });
});
