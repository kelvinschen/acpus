import { Readable } from "node:stream";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStream } from "./support/capture-stream.js";

const mock = vi.hoisted(() => ({
  prepareWorkflowForCli: vi.fn(),
  sendDaemonAdmitRun: vi.fn(),
  sendDaemonControl: vi.fn(),
  followRun: vi.fn(),
  tryNormalizeForkInput: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  tryNormalizeForkInput: mock.tryNormalizeForkInput,
}));
vi.mock("../src/workflow/preparation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/workflow/preparation.js")>(),
  prepareWorkflowForCli: mock.prepareWorkflowForCli,
}));
vi.mock("../src/daemon/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/daemon/client.js")>(),
  sendDaemonAdmitRun: mock.sendDaemonAdmitRun,
  sendDaemonControl: mock.sendDaemonControl,
}));
vi.mock("../src/runs/follow.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runs/follow.js")>(),
  followRun: mock.followRun,
}));

import { createRunsCommand } from "../src/runs/command.js";
import { createWorkflowCommand } from "../src/workflow/command.js";

const preparedSourceGraphDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const preparedEntryDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const preparedIrDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const snapshotPrepared = preparedWorkflow();

describe("workflow source command plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.prepareWorkflowForCli.mockResolvedValue({ prepared: snapshotPrepared });
    mock.sendDaemonAdmitRun.mockReturnValue(okAsync(runDetails()));
    mock.sendDaemonControl.mockReturnValue(okAsync({
      type: "fork",
      sourceRunId: "run_source",
      run: runDetails("run_child"),
    }));
    mock.tryNormalizeForkInput.mockReturnValue(okAsync({}));
    mock.followRun.mockResolvedValue({
      kind: "closed",
      reason: "subject-terminal",
      run: { id: "run_admitted", status: "completed" },
    });
  });

  it.each([
    { action: "check", flags: [] },
    { action: "run", flags: [] },
    { action: "viz", flags: [] },
  ] as const)("passes stdin through the shared source preparer for workflow $action -", async ({ action, flags }) => {
    const stdin = Readable.from(["export default {};\n"]);
    const setExitCode = vi.fn();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode,
    });

    await command.parseAsync([action, "-", ...flags], { from: "user" });

    expect(mock.prepareWorkflowForCli).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      workflow: "-",
      stdin,
    });
    if (action === "run") {
      expect(mock.sendDaemonAdmitRun).toHaveBeenCalledWith("/workspace", {
        prepared: snapshotPrepared,
        input: {},
      });
    }
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });

  it("submits by default with compact inspection guidance and preparation warnings", async () => {
    const stdout = new CaptureStream();
    mock.prepareWorkflowForCli.mockResolvedValue({
      prepared: preparedWorkflow([sourceCaptureWarning()]),
    });
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await command.parseAsync(["run", "workflow.ts"], { from: "user" });

    expect(stdout.text).toBe([
      "Run run_admitted  dynamic-source  pending",
      "Inspect: acpus runs inspect run_admitted",
      "workflow.ts:2:62 [warning SC001] Dynamic import with a non-literal specifier is outside the statically tracked workflow source graph.",
      "",
    ].join("\n"));
    expect(mock.followRun).not.toHaveBeenCalled();
  });

  it("passes stdin through the shared source preparer for a fork replacement", async () => {
    const stdin = Readable.from(["export default {};\n"]);
    const setExitCode = vi.fn();
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode,
    });

    await command.parseAsync([
      "fork",
      "run_source",
      "--workflow",
      "-",
    ], { from: "user" });

    expect(mock.prepareWorkflowForCli).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      workflow: "-",
      stdin,
    });
    expect(mock.sendDaemonControl).toHaveBeenCalledWith("/workspace", {
      requestId: expect.stringMatching(/^cli:/),
      type: "fork",
      runId: "run_source",
      prepared: snapshotPrepared,
      input: {},
    });
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });

  it("routes a fork catalog scope through the shared source preparer", async () => {
    const stdin = Readable.from([]);
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await command.parseAsync([
      "fork",
      "run_source",
      "--workflow",
      "replacement",
      "--global",
    ], { from: "user" });

    expect(mock.prepareWorkflowForCli).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      workflow: "replacement",
      stdin,
      global: true,
    });
  });

  it("prints preparation warnings before following a workflow run in text mode", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    mock.followRun.mockImplementationOnce(async (_cwd, _query, output) => {
      output.stdout.write("FOLLOW\n");
      return { kind: "closed", reason: "subject-terminal", run: { id: "run_admitted", status: "completed" } };
    });
    mock.prepareWorkflowForCli.mockResolvedValue({
      prepared: preparedWorkflow([sourceCaptureWarning()]),
    });
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode: vi.fn(),
    });

    await command.parseAsync(["run", "workflow.ts", "--follow"], { from: "user" });

    expect(stdout.text).toBe([
      "workflow.ts:2:62 [warning SC001] Dynamic import with a non-literal specifier is outside the statically tracked workflow source graph.",
      "FOLLOW",
      "",
    ].join("\n"));
    expect(stdout.text.match(/\[warning SC001\]/gu)).toHaveLength(1);
    expect(mock.followRun).toHaveBeenCalledOnce();
    expect(mock.followRun).toHaveBeenCalledWith(
      "/workspace",
      { kind: "run", runId: "run_admitted" },
      { until: "subject-terminal", stdout, stderr },
    );
  });

  it("uses the decision-boundary policy for a blocking workflow run", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const setExitCode = vi.fn();
    mock.followRun.mockImplementationOnce(async (_cwd, _view, options) => {
      options.stdout.write("ATTACHED\n");
      return { kind: "closed", reason: "awaiting-input", run: { id: "run_admitted", status: "running" } };
    });
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode,
    });

    await command.parseAsync(["run", "workflow.ts", "--await-decision"], { from: "user" });

    expect(mock.followRun).toHaveBeenCalledWith(
      "/workspace",
      { kind: "run", runId: "run_admitted" },
      { until: "decision-boundary", stdout, stderr },
    );
    expect(stdout.text).toBe("ATTACHED\n");
    expect(stdout.text).not.toContain("Run run_admitted");
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });

  it("preserves replacement preparation warnings in fork text", async () => {
    const stdout = new CaptureStream();
    mock.prepareWorkflowForCli.mockResolvedValue({
      prepared: preparedWorkflow([sourceCaptureWarning()]),
      catalog: catalogEntry(),
    });
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await command.parseAsync([
      "fork",
      "run_source",
      "--workflow",
      "dynamic-source",
      "--global",
    ], { from: "user" });

    expect(stdout.text).toBe([
      "Fork run created.",
      "Catalog: global/dynamic-source",
      "Catalog status: available",
      "Catalog package: /home/.acpus/workflows/dynamic-source",
      "Catalog entry: /home/.acpus/workflows/dynamic-source/workflow.ts",
      "Source run: run_source",
      "Fork run: run_child",
      "Fork status: pending",
      "Workflow entry: workflow.ts",
      "Next: acpus runs inspect run_child --await-decision",
      "workflow.ts:2:62 [warning SC001] Dynamic import with a non-literal specifier is outside the statically tracked workflow source graph.",
      "",
    ].join("\n"));
  });

  it("rejects a fork catalog scope without a replacement workflow", async () => {
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await expect(command.parseAsync([
      "fork",
      "run_source",
      "--project",
    ], { from: "user" })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        phase: "usage",
        message: "Catalog scope flags require --workflow.",
      },
    });
    expect(mock.prepareWorkflowForCli).not.toHaveBeenCalled();
    expect(mock.sendDaemonControl).not.toHaveBeenCalled();
  });

  it("sends an empty fork workflow value through scoped preparation instead of treating it as absent", async () => {
    const preparationError = new Error("empty workflow reached source preparation");
    mock.prepareWorkflowForCli.mockRejectedValueOnce(preparationError);
    const stdin = Readable.from([]);
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await expect(command.parseAsync([
      "fork",
      "run_source",
      "--workflow",
      "",
      "--global",
    ], { from: "user" })).rejects.toBe(preparationError);
    expect(mock.prepareWorkflowForCli).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      workflow: "",
      stdin,
      global: true,
    });
    expect(mock.sendDaemonControl).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive fork catalog scopes before preparation or daemon control", async () => {
    const command = createRunsCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await expect(command.parseAsync([
      "fork",
      "run_source",
      "--workflow",
      "replacement",
      "--project",
      "--global",
    ], { from: "user" })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        phase: "usage",
        message: "--project and --global are mutually exclusive.",
      },
    });
    expect(mock.prepareWorkflowForCli).not.toHaveBeenCalled();
    expect(mock.sendDaemonControl).not.toHaveBeenCalled();
  });
});

function preparedWorkflow(
  diagnostics: PreparedWorkflow["ir"]["diagnostics"] = [],
): PreparedWorkflow {
  const ir: PreparedWorkflow["ir"] = {
    irVersion: 7,
    name: "dynamic-source",
    agents: {},
    root: {
      nodes: [],
      output: { kind: "object", fields: {} },
    },
    diagnostics,
  };
  const source: Extract<PreparedWorkflow["source"], { kind: "snapshot" }> = {
    kind: "snapshot",
    entry: "workflow.ts",
    digest: preparedSourceGraphDigest,
  };
  return {
    source,
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files: [{
        path: "workflow.ts",
        content: [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "dynamic-source" }).build(() => ({}));',
          "",
        ].join("\n"),
      }],
    },
    ir,
    irJson: `${JSON.stringify(ir)}\n`,
    sourceGraphDigest: preparedSourceGraphDigest,
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 2,
      workflow: {
        source,
        entryDigest: preparedEntryDigest,
      },
      ir: {
        path: "workflow.ir.json",
        digest: preparedIrDigest,
      },
      sourceGraphDigest: preparedSourceGraphDigest,
    },
  };
}

function sourceCaptureWarning() {
  return {
    code: "SC001",
    severity: "warning" as const,
    message: "Dynamic import with a non-literal specifier is outside the statically tracked workflow source graph.",
    source: {
      file: "workflow.ts",
      line: 2,
      column: 62,
    },
  };
}

function catalogEntry() {
  return {
    scope: "global" as const,
    name: "dynamic-source",
    packagePath: "/home/.acpus/workflows/dynamic-source",
    entryPath: "/home/.acpus/workflows/dynamic-source/workflow.ts",
    status: "available" as const,
    requiresScope: false,
  };
}

function runDetails(id = "run_admitted") {
  return {
    id,
    name: "dynamic-source",
    status: "pending",
    workflowEntry: "workflow.ts",
    sourceGraphDigest: preparedSourceGraphDigest,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 0,
    execution: {
      state: "inactive",
      lastStatus: "pending",
      reason: "daemon_alive",
      daemonHeartbeatAt: "2026-07-24T00:00:00.000Z",
    },
  };
}
