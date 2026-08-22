import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { createWebCommand } from "../src/web/command.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

type StartWebServer = typeof import("@acpus/web")["startWebServer"];

const mocks = vi.hoisted(() => ({
  ensureRuntimeAuthority: vi.fn(),
  startWebServer: vi.fn<StartWebServer>(),
}));

vi.mock("@acpus/web", () => ({ startWebServer: mocks.startWebServer }));
vi.mock("../src/daemon/client.js", () => ({
  ensureRuntimeAuthority: mocks.ensureRuntimeAuthority,
}));

beforeEach(() => {
  mocks.startWebServer.mockReset();
  mocks.ensureRuntimeAuthority.mockReset().mockReturnValue(Effect.succeed(runtimeAuthority()));
});

describe("web command options", () => {
  it("reports an occupied port as an operational text failure", async () => {
    mocks.startWebServer.mockReturnValue(Effect.fail({
      type: "listen-failed",
      host: "127.0.0.1",
      port: 4517,
      message: "listen EADDRINUSE: address already in use 127.0.0.1:4517",
    }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--host", "127.0.0.1", "--port", "4517"], {
      cwd: "/workspace",
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe([
      "listen EADDRINUSE: address already in use 127.0.0.1:4517",
      "Error code: LISTEN_FAILED",
      "",
    ].join("\n"));
  });

  it("does not request token access for network hosts by default", async () => {
    const close = vi.fn(async () => undefined);
    mocks.startWebServer.mockReturnValue(server("http://0.0.0.0:4517", close));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync(["--host", "0.0.0.0"], { from: "user" });
    let finished = false;
    try {
      await waitForSignalListeners(listenerCounts);
      expect(mocks.startWebServer).toHaveBeenCalledWith(expect.objectContaining({
        cwd: "/workspace",
        host: "0.0.0.0",
        ensureDaemonRunning: expect.any(Function),
      }));
      expect(mocks.startWebServer.mock.calls[0]![0]).not.toHaveProperty("token");
      await expect(mocks.startWebServer.mock.calls[0]![0].ensureDaemonRunning("/workspace")).resolves.toEqual({ ok: true });
      expect(mocks.ensureRuntimeAuthority).toHaveBeenCalledWith("/workspace", "control");
      expect(stdout.text).toBe("");
      expect(stderr.text).toBe("Acpus WebUI starting at http://0.0.0.0:4517\nPress Ctrl+C to stop.\n");
      process.emit("SIGINT");
      await command;
      finished = true;
    } finally {
      if (!finished) {
        process.emit("SIGINT");
        await command.catch(() => undefined);
      }
    }
    expect(close).toHaveBeenCalledOnce();
    expect(signalListenerCounts()).toEqual(listenerCounts);
  });

  it("passes token access when --token is set", async () => {
    const close = vi.fn(async () => undefined);
    mocks.startWebServer.mockReturnValue(server("http://localhost:4517/?token=generated", close, "generated"));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync(["--token"], { from: "user" });
    let finished = false;
    try {
      await waitForSignalListeners(listenerCounts);
      expect(mocks.startWebServer).toHaveBeenCalledWith(expect.objectContaining({
        cwd: "/workspace",
        host: "localhost",
        token: true,
        ensureDaemonRunning: expect.any(Function),
      }));
      expect(stdout.text).toBe("");
      expect(stderr.text).toBe([
        "Acpus WebUI starting at http://localhost:4517/?token=generated",
        "Access token: generated",
        "Press Ctrl+C to stop.",
        "",
      ].join("\n"));
      process.emit("SIGTERM");
      await command;
      finished = true;
    } finally {
      if (!finished) {
        process.emit("SIGTERM");
        await command.catch(() => undefined);
      }
    }
    expect(close).toHaveBeenCalledOnce();
    expect(signalListenerCounts()).toEqual(listenerCounts);
  });

  it("maps authority update blocking into the Web callback result", async () => {
    const close = vi.fn(async () => undefined);
    mocks.ensureRuntimeAuthority.mockReturnValue(Effect.fail({
      type: "runtime-update-blocked",
      message: "The previous daemon still has active work.",
    }));
    mocks.startWebServer.mockReturnValue(server("http://localhost:4517", close));
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
    }).parseAsync([], { from: "user" });
    let finished = false;
    try {
      await waitForSignalListeners(listenerCounts);
      await expect(mocks.startWebServer.mock.calls[0]![0].ensureDaemonRunning("/workspace")).resolves.toEqual({
        ok: false,
        code: "RUNTIME_UPDATE_BLOCKED",
        message: "The previous daemon still has active work.",
      });
      process.emit("SIGINT");
      await command;
      finished = true;
    } finally {
      if (!finished) {
        process.emit("SIGINT");
        await command.catch(() => undefined);
      }
    }
    expect(signalListenerCounts()).toEqual(listenerCounts);
  });

  it("closes once for repeated shutdown signals and resolves naturally", async () => {
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => {
      resolveClose = resolve;
    }));
    mocks.startWebServer.mockReturnValue(server("http://localhost:4517", close));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync([], { from: "user" });
    let finished = false;
    try {
      await waitForSignalListeners(listenerCounts);
      process.emit("SIGINT");
      process.emit("SIGINT");
      process.emit("SIGTERM");
      expect(close).toHaveBeenCalledOnce();
      resolveClose();
      await command;
      finished = true;
    } finally {
      if (!finished) {
        process.emit("SIGINT");
        resolveClose?.();
        await command.catch(() => undefined);
      }
    }

    expect(signalListenerCounts()).toEqual(listenerCounts);
  });
});

function signalListenerCounts(): { sigint: number; sigterm: number } {
  return {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
}

async function waitForSignalListeners(baseline: ReturnType<typeof signalListenerCounts>): Promise<void> {
  await vi.waitFor(() => {
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm + 1);
  });
}

function runtimeAuthority() {
  return {
    workspaceKey: "workspace-key",
    runtimeAbi: 5,
    layoutVersion: 2,
    storageVersion: 19,
    authorityId: "authority-a",
    leaseGeneration: 1,
  };
}

function server(url: string, close: () => Promise<void>, token?: string) {
  return Effect.acquireRelease(
    Effect.succeed({ url, ...(token === undefined ? {} : { token }) }),
    () => Effect.promise(close),
  );
}
