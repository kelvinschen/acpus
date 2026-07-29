import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, errAsync, ok, okAsync } from "neverthrow";

const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  unref: vi.fn(),
  getRun: vi.fn(),
  prepareRuntimeForNewRun: vi.fn(),
  requestDaemonAdmitRun: vi.fn(),
  requestDaemonControl: vi.fn(),
  requestDaemonStatus: vi.fn(),
  tryLoadRuntimeConfiguration: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("@acpus/runtime", () => ({
  DAEMON_PROTOCOL_VERSION: 3,
  getRun: mock.getRun,
  prepareRuntimeForNewRun: mock.prepareRuntimeForNewRun,
  requestDaemonAdmitRun: mock.requestDaemonAdmitRun,
  requestDaemonControl: mock.requestDaemonControl,
  requestDaemonStatus: mock.requestDaemonStatus,
  tryLoadRuntimeConfiguration: mock.tryLoadRuntimeConfiguration,
}));

import { ensureDaemonRunning, sendDaemonAdmitRun, sendDaemonControl } from "../src/commands/daemon.js";

describe("CLI daemon client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const child = Object.assign(new EventEmitter(), { unref: mock.unref });
    mock.spawn.mockReturnValue(child);
    mock.tryLoadRuntimeConfiguration.mockReturnValue(ok({}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not spawn when an existing daemon is ready", async () => {
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 3 }));

    const ready = await ensureDaemonRunning("/workspace");

    expect(ready.isOk()).toBe(true);
    expect(mock.requestDaemonStatus).toHaveBeenCalledOnce();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("spawns once and waits until the daemon reports ready", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatus
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")))
      .mockReturnValueOnce(errAsync(transportFailure("refused", "socket not ready")))
      .mockReturnValueOnce(okAsync({ status: "ok", generation: 8, protocolVersion: 3 }));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(200);
    expect((await ready).isOk()).toBe(true);

    expect(mock.spawn).toHaveBeenCalledOnce();
    expect(mock.unref).toHaveBeenCalledOnce();
    expect(mock.requestDaemonStatus).toHaveBeenCalledTimes(3);
  });

  it("reports invalid runtime configuration before spawning", async () => {
    mock.requestDaemonStatus.mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")));
    mock.tryLoadRuntimeConfiguration.mockReturnValue(err({ message: "ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY is invalid." }));

    const ready = await ensureDaemonRunning("/workspace");

    expect(ready.isErr()).toBe(true);
    if (ready.isErr()) expect(ready.error).toEqual({ type: "runtime-configuration-invalid", message: "ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY is invalid." });
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("waits without spawning while a bound daemon initializes", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatus
      .mockReturnValueOnce(errAsync(rejectedFailure("EXECUTION_UNAVAILABLE", "Daemon lease is not ready.")))
      .mockReturnValueOnce(okAsync({ status: "ok", generation: 9, protocolVersion: 3 }));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(100);
    expect((await ready).isOk()).toBe(true);

    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("reports the child error event instead of waiting for timeout", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { unref: mock.unref });
    mock.spawn.mockReturnValue(child);
    mock.requestDaemonStatus.mockReturnValue(errAsync(transportFailure("not-found", "missing")));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.spawn).toHaveBeenCalledOnce();
    child.emit("error", Object.assign(new Error("spawn denied"), { code: "EACCES" }));
    await vi.advanceTimersByTimeAsync(100);
    const result = await ready;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toMatchObject({ type: "daemon-spawn-failed", errno: "EACCES", message: "spawn denied" });
  });

  it("reports an early daemon exit", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { unref: mock.unref });
    mock.spawn.mockReturnValue(child);
    mock.requestDaemonStatus.mockReturnValue(errAsync(transportFailure("not-found", "missing")));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.spawn).toHaveBeenCalledOnce();
    child.emit("exit", 17, null);
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await ready;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toMatchObject({ type: "daemon-exited-before-ready", exitCode: 17, signal: null });
  });

  it("accepts a competing daemon that becomes ready after the spawned child exits", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { unref: mock.unref });
    mock.spawn.mockReturnValue(child);
    mock.requestDaemonStatus
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "missing")))
      .mockReturnValueOnce(okAsync({ status: "ok", generation: 10, protocolVersion: 3 }));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(0);
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect((await ready).isOk()).toBe(true);
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it("returns a tagged timeout when a spawned daemon never becomes ready", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatus.mockReturnValue(errAsync(transportFailure("not-found", "missing")));

    const ready = ensureDaemonRunning("/workspace");
    await vi.advanceTimersByTimeAsync(30_100);
    const result = await ready;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("daemon-start-timeout");
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it("does not retry a non-startup daemon status failure", async () => {
    mock.requestDaemonStatus.mockReturnValue(errAsync({
      type: "protocol",
      stage: "envelope",
      method: "status",
      message: "invalid daemon response",
    }));

    const result = await ensureDaemonRunning("/workspace");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toMatchObject({ type: "daemon-status-failed", message: "invalid daemon response" });
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("rejects a live daemon with a different protocol without spawning", async () => {
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 1 }));

    const result = await ensureDaemonRunning("/workspace");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        type: "daemon-protocol-mismatch",
        expectedProtocolVersion: 3,
        actualProtocolVersion: 1,
      });
      expect(result.error.message).toContain("restart");
    }
    expect(mock.requestDaemonStatus).toHaveBeenCalledOnce();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("dispatches one control request after readiness", async () => {
    const intent = { requestId: "cli:1", type: "pause", runId: "run_1" } as const;
    const value = { type: "pause", run: { id: "run_1", status: "paused" } };
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 3 }));
    mock.requestDaemonControl.mockReturnValue(okAsync(value));

    const result = await sendDaemonControl("/workspace", intent);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(value);
  });

  it("dispatches admission directly through an already-compatible daemon", async () => {
    const input = { prepared: {}, input: {} } as Parameters<typeof sendDaemonAdmitRun>[1];
    const run = { id: "run_1", status: "pending" };
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 3 }));
    mock.requestDaemonAdmitRun.mockReturnValue(okAsync(run));

    const result = await sendDaemonAdmitRun("/workspace", input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(run);
    expect(mock.prepareRuntimeForNewRun).not.toHaveBeenCalled();
    expect(mock.requestDaemonAdmitRun).toHaveBeenCalledOnce();
    expect(mock.requestDaemonAdmitRun).toHaveBeenCalledWith("/workspace", input);
  });

  it("prepares storage before spawning a missing daemon for admission", async () => {
    const input = { prepared: {}, input: {} } as Parameters<typeof sendDaemonAdmitRun>[1];
    mock.requestDaemonStatus
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")))
      .mockReturnValueOnce(okAsync({ status: "ok", generation: 8, protocolVersion: 3 }));
    mock.requestDaemonAdmitRun.mockReturnValue(okAsync({ id: "run_1", status: "pending" }));

    const result = await sendDaemonAdmitRun("/workspace", input);

    expect(result.isOk()).toBe(true);
    expect(mock.prepareRuntimeForNewRun).toHaveBeenCalledOnce();
    expect(mock.prepareRuntimeForNewRun).toHaveBeenCalledWith("/workspace");
    expect(mock.requestDaemonAdmitRun).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible live daemon before storage preparation or admission", async () => {
    const input = { prepared: {}, input: {} } as Parameters<typeof sendDaemonAdmitRun>[1];
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 1 }));

    const result = await sendDaemonAdmitRun("/workspace", input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("daemon-protocol-mismatch");
    expect(mock.prepareRuntimeForNewRun).not.toHaveBeenCalled();
    expect(mock.requestDaemonAdmitRun).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("enriches a daemon control failure with current run state", async () => {
    const run = { id: "run_1", name: "review", status: "completed", updatedAt: "2026-07-01T00:00:00.000Z" };
    mock.requestDaemonStatus.mockReturnValue(okAsync({ status: "ok", generation: 7, protocolVersion: 3 }));
    mock.requestDaemonControl.mockReturnValue(errAsync(rejectedFailure("RUN_NOT_CONTROLLABLE", "Run is terminal.")));
    mock.getRun.mockResolvedValue(run);

    const result = await sendDaemonControl("/workspace", { requestId: "cli:2", type: "cancel", runId: "run_1" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toMatchObject({
      type: "control-failed",
      code: "RUN_NOT_CONTROLLABLE",
      controlType: "cancel",
      runId: "run_1",
      run,
    });
  });
});

function transportFailure(reason: "not-found" | "refused", message: string) {
  return { type: "transport" as const, reason, method: "status" as const, message };
}

function rejectedFailure(code: string, message: string) {
  return { type: "rejected" as const, code, message };
}
