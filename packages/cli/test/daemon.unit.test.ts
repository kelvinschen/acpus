import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  class DaemonRequestError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    DaemonRequestError,
    spawn: vi.fn(),
    unref: vi.fn(),
    getRun: vi.fn(),
    requestDaemonAdmitRun: vi.fn(),
    requestDaemonControl: vi.fn(),
    requestDaemonStatus: vi.fn(),
    tryLoadRuntimeConfiguration: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("@acpus/runtime", () => ({
  DaemonRequestError: mock.DaemonRequestError,
  getRun: mock.getRun,
  requestDaemonAdmitRun: mock.requestDaemonAdmitRun,
  requestDaemonControl: mock.requestDaemonControl,
  requestDaemonStatus: mock.requestDaemonStatus,
  tryLoadRuntimeConfiguration: mock.tryLoadRuntimeConfiguration,
}));

import { ensureDaemonRunning, sendDaemonAdmitRun, sendDaemonControl } from "../src/commands/daemon.js";

describe("CLI daemon client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.spawn.mockReturnValue({ unref: mock.unref });
    mock.tryLoadRuntimeConfiguration.mockReturnValue({ isErr: () => false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not spawn when an existing daemon is ready", async () => {
    mock.requestDaemonStatus.mockResolvedValue({ status: "ok", generation: 7 });

    await ensureDaemonRunning("/workspace");

    expect(mock.requestDaemonStatus).toHaveBeenCalledOnce();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("spawns once and waits until the daemon reports ready", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatus
      .mockRejectedValueOnce(Object.assign(new Error("socket missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("socket not ready"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce({ status: "ok", generation: 8 });

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(200);
    await ready;

    expect(mock.spawn).toHaveBeenCalledOnce();
    expect(mock.unref).toHaveBeenCalledOnce();
    expect(mock.requestDaemonStatus).toHaveBeenCalledTimes(3);
  });

  it("reports invalid runtime configuration before spawning a detached daemon", async () => {
    mock.requestDaemonStatus.mockRejectedValueOnce(Object.assign(new Error("socket missing"), { code: "ENOENT" }));
    mock.tryLoadRuntimeConfiguration.mockReturnValue({
      isErr: () => true,
      error: { message: "Environment variable ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY is invalid." },
    });

    await expect(ensureDaemonRunning("/workspace")).rejects.toThrow(
      "Environment variable ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY is invalid.",
    );
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("waits without another spawn while a bound daemon claims its generation", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatus
      .mockRejectedValueOnce(new mock.DaemonRequestError("EXECUTION_UNAVAILABLE", "Daemon lease is not ready."))
      .mockResolvedValueOnce({ status: "ok", generation: 9 });

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(100);
    await ready;

    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.requestDaemonStatus).toHaveBeenCalledTimes(2);
  });

  it("dispatches one control request after readiness", async () => {
    const intent = { requestId: "cli:1", type: "pause", runId: "run_1" } as const;
    const result = { run: { id: "run_1", status: "paused" } };
    mock.requestDaemonStatus.mockResolvedValue({ status: "ok", generation: 7 });
    mock.requestDaemonControl.mockResolvedValue(result);

    await expect(sendDaemonControl("/workspace", intent)).resolves.toBe(result);

    expect(mock.requestDaemonControl).toHaveBeenCalledOnce();
    expect(mock.requestDaemonControl).toHaveBeenCalledWith("/workspace", intent);
  });

  it("dispatches the current admission input once after readiness", async () => {
    const input = { prepared: {}, input: {} } as Parameters<typeof sendDaemonAdmitRun>[1];
    const run = { id: "run_1", status: "pending" };
    mock.requestDaemonStatus.mockResolvedValue({ status: "ok", generation: 7 });
    mock.requestDaemonAdmitRun.mockResolvedValue(run);

    await expect(sendDaemonAdmitRun("/workspace", input)).resolves.toBe(run);

    expect(mock.requestDaemonAdmitRun).toHaveBeenCalledOnce();
    expect(mock.requestDaemonAdmitRun).toHaveBeenCalledWith("/workspace", input);
  });

  it("enriches a daemon control failure with current run state", async () => {
    const run = { id: "run_1", name: "review", status: "completed", updatedAt: "2026-07-01T00:00:00.000Z" };
    mock.requestDaemonStatus.mockResolvedValue({ status: "ok", generation: 7 });
    mock.requestDaemonControl.mockRejectedValue(new mock.DaemonRequestError("RUN_NOT_CONTROLLABLE", "Run is terminal."));
    mock.getRun.mockResolvedValue(run);

    await expect(sendDaemonControl("/workspace", { requestId: "cli:2", type: "cancel", runId: "run_1" })).rejects.toMatchObject({
      code: "RUN_NOT_CONTROLLABLE",
      controlType: "cancel",
      runId: "run_1",
      run,
    });
    expect(mock.requestDaemonControl).toHaveBeenCalledOnce();
  });
});
