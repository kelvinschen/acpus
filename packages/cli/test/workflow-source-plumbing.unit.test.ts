import { Readable } from "node:stream";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStream } from "./support/capture-stream.js";

const mock = vi.hoisted(() => ({
  observeInspection: vi.fn(),
  prepareWorkflowForCli: vi.fn(),
  sendDaemonSubmitAndObserve: vi.fn(),
  sendDaemonControl: vi.fn(),
  tryNormalizeForkInput: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  observeInspection: mock.observeInspection,
  tryNormalizeForkInput: mock.tryNormalizeForkInput,
}));
vi.mock("../src/workflow/preparation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/workflow/preparation.js")>(),
  prepareWorkflowForCli: mock.prepareWorkflowForCli,
}));
vi.mock("../src/daemon/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/daemon/client.js")>(),
  sendDaemonSubmitAndObserve: mock.sendDaemonSubmitAndObserve,
  sendDaemonControl: mock.sendDaemonControl,
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
    mock.sendDaemonSubmitAndObserve.mockImplementation(() => daemonFrames(admittedFrame()));
    mock.sendDaemonControl.mockReturnValue(okAsync({
      type: "fork",
      sourceRunId: "run_source",
      run: runDetails("run_child"),
    }));
    mock.tryNormalizeForkInput.mockReturnValue(okAsync({}));
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
      expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledWith(
        "/workspace",
        {
          requestId: expect.stringMatching(/^cli:/),
          prepared: snapshotPrepared,
          input: {},
          until: "admitted",
        },
        { signal: expect.any(AbortSignal) },
      );
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
    expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledOnce();
    expect(mock.observeInspection).not.toHaveBeenCalled();
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

  it("preserves the Runtime repair code when fork input normalization cannot bind the store", async () => {
    mock.tryNormalizeForkInput.mockReturnValueOnce(errAsync({
      type: "runtime-store-repair-required",
      command: "acpus doctor --fix",
      message: "Runtime store repair is required.",
    }));
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
      "--input",
      "{}",
    ], { from: "user" })).rejects.toMatchObject({
      exitCode: 1,
      result: {
        phase: "control",
        errorCode: "RUNTIME_STORE_REPAIR_REQUIRED",
        message: expect.stringContaining("acpus doctor --fix"),
        control: { type: "fork", runId: "run_source" },
      },
    });
    expect(mock.sendDaemonControl).not.toHaveBeenCalled();
  });

  it("uses one daemon stream for admission and terminal observation", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    mock.sendDaemonSubmitAndObserve.mockReturnValueOnce(daemonFrames(
      admittedFrame(),
      closedFrame("completed", "subject-terminal"),
    ));
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

    expect(stdout.text.match(/\[warning SC001\]/gu)).toHaveLength(1);
    expect(stdout.text).toContain("Run run_admitted  dynamic-source  completed");
    expect(stdout.text).not.toContain("Inspect: acpus runs inspect run_admitted");
    expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledOnce();
    expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledWith(
      "/workspace",
      expect.objectContaining({ until: "subject-terminal" }),
      { signal: expect.any(AbortSignal) },
    );
    expect(mock.observeInspection).not.toHaveBeenCalled();
  });

  it("uses the decision-boundary policy for a blocking workflow run", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const setExitCode = vi.fn();
    mock.sendDaemonSubmitAndObserve.mockReturnValueOnce(daemonFrames(
      admittedFrame(),
      closedFrame("running", "awaiting-input"),
    ));
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode,
    });

    await command.parseAsync(["run", "workflow.ts", "--await-decision"], { from: "user" });

    expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledWith(
      "/workspace",
      expect.objectContaining({ until: "decision-boundary" }),
      { signal: expect.any(AbortSignal) },
    );
    expect(stdout.text).toContain("Run run_admitted  dynamic-source  running");
    expect(stdout.text).not.toContain("pending");
    expect(mock.observeInspection).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenLastCalledWith(0);
  });

  it("preserves a post-admission daemon error and its durable run recovery", async () => {
    mock.sendDaemonSubmitAndObserve.mockReturnValueOnce((async function* () {
      yield ok(admittedFrame());
      yield err({
        type: "request-failed",
        method: "submitAndObserve",
        code: "STORE_ERROR",
        runId: "run_admitted",
        message: "Observation connection failed.",
      });
    })());
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    await expect(command.parseAsync(["run", "workflow.ts", "--follow"], { from: "user" })).rejects.toMatchObject({
      exitCode: 1,
      result: {
        phase: "run",
        errorCode: "STORE_ERROR",
        message: expect.stringMatching(/Observation connection failed.*acpus runs inspect run_admitted --follow/u),
      },
    });
  });

  it("records a pre-admission Ctrl-C and detaches after admission is confirmed", async () => {
    const releaseAdmission = deferred<void>();
    mock.sendDaemonSubmitAndObserve.mockImplementationOnce(() => (async function* () {
      await releaseAdmission.promise;
      yield ok(admittedFrame());
    })());
    const stdout = new CaptureStream();
    const setExitCode = vi.fn();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr: new CaptureStream(),
      setExitCode,
    });

    const running = command.parseAsync(["run", "workflow.ts", "--follow"], { from: "user" });
    await vi.waitFor(() => expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    releaseAdmission.resolve();

    await running;
    expect(setExitCode).toHaveBeenLastCalledWith(0);
    expect(stdout.text).toContain("Detached from run run_admitted.");
    expect(stdout.text).toContain("acpus runs inspect run_admitted --follow");
    expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });

  it("reports an unknown admission outcome after a second pre-admission Ctrl-C", async () => {
    mock.sendDaemonSubmitAndObserve.mockImplementationOnce((
      _cwd: string,
      _input: unknown,
      options: { signal: AbortSignal },
    ) => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(resolveNext => {
          options.signal.addEventListener("abort", () => resolveNext({ done: true, value: undefined }), { once: true });
        }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }));
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      setExitCode: vi.fn(),
    });

    const running = command.parseAsync(["run", "workflow.ts", "--follow"], { from: "user" });
    await vi.waitFor(() => expect(mock.sendDaemonSubmitAndObserve).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    process.emit("SIGINT");

    await expect(running).rejects.toMatchObject({
      exitCode: 1,
      result: {
        phase: "run",
        errorCode: "ADMISSION_OUTCOME_UNKNOWN",
      },
    });
  });

  it("prefers an admitted Ctrl-C detach over a racing stream error", async () => {
    let resolveNext!: (result: IteratorResult<unknown>) => void;
    let nextCount = 0;
    mock.sendDaemonSubmitAndObserve.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCount += 1;
          return nextCount === 1
            ? Promise.resolve({ done: false as const, value: ok(admittedFrame()) })
            : new Promise<IteratorResult<unknown>>(resolve => { resolveNext = resolve; });
        },
        return: async () => ({ done: true as const, value: undefined }),
      }),
    }));
    const stdout = new CaptureStream();
    const setExitCode = vi.fn();
    const command = createWorkflowCommand({
      cwd: "/workspace",
      stdin: Readable.from([]),
      stdout,
      stderr: new CaptureStream(),
      setExitCode,
    });

    const running = command.parseAsync(["run", "workflow.ts", "--follow"], { from: "user" });
    await vi.waitFor(() => expect(resolveNext).toBeTypeOf("function"));
    process.emit("SIGINT");
    resolveNext({
      done: false,
      value: err({
        type: "request-failed",
        method: "submitAndObserve",
        code: "STORE_ERROR",
        message: "late observer failure",
      }),
    });

    await running;
    expect(setExitCode).toHaveBeenLastCalledWith(0);
    expect(stdout.text).toContain("Detached from run run_admitted.");
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
      reason: "runtime_authority_alive",
      runtimeAuthorityHeartbeatAt: "2026-07-24T00:00:00.000Z",
    },
  };
}

function admittedFrame() {
  return {
    kind: "admitted" as const,
    authority: {} as never,
    run: runDetails(),
  };
}

function closedFrame(
  status: "running" | "completed",
  reason: "subject-terminal" | "awaiting-input",
) {
  return {
    kind: "observation" as const,
    observation: {
      kind: "closed" as const,
      reason,
      view: {
        kind: "run" as const,
        run: { id: "run_admitted", name: "dynamic-source", status },
        counts: { total: 0 },
        tree: [],
      },
    },
  };
}

function daemonFrames(...frames: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const frame of frames) yield ok(frame);
  })();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}
