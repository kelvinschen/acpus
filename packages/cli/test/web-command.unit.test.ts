import { beforeEach, describe, expect, it, vi } from "vitest";
import { errAsync, okAsync } from "neverthrow";
import { createWebCommand } from "../src/commands/web.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

type StartWebServer = typeof import("@acpus/web")["startWebServer"];

const mocks = vi.hoisted(() => ({
  startWebServer: vi.fn<StartWebServer>(),
}));

vi.mock("@acpus/web", () => ({ startWebServer: mocks.startWebServer }));

beforeEach(() => {
  mocks.startWebServer.mockReset();
});

describe("web command options", () => {
  it("reports an occupied port as one operational JSON failure", async () => {
    mocks.startWebServer.mockReturnValue(errAsync({
      type: "listen-failed",
      host: "127.0.0.1",
      port: 4517,
      message: "listen EADDRINUSE: address already in use 127.0.0.1:4517",
    }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runCli(["web", "--host", "127.0.0.1", "--port", "4517", "--json"], {
      cwd: "/workspace",
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text)).toEqual({
      schemaVersion: 1,
      ok: false,
      phase: "run",
      message: "listen EADDRINUSE: address already in use 127.0.0.1:4517",
      errorCode: "LISTEN_FAILED",
    });
    expect(stderr.text).toBe("");
  });

  it("does not request token access for network hosts by default", async () => {
    const close = vi.fn(async () => undefined);
    mocks.startWebServer.mockReturnValue(okAsync({ url: "http://0.0.0.0:4517", close }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync(["--host", "0.0.0.0", "--json"], { from: "user" });
    await waitForSignalListeners(listenerCounts);

    expect(mocks.startWebServer).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      host: "0.0.0.0",
      ensureDaemonRunning: expect.any(Function),
    }));
    expect(mocks.startWebServer.mock.calls[0]![0]).not.toHaveProperty("token");
    expect(JSON.parse(stdout.text)).toEqual({
      schemaVersion: 1,
      ok: true,
      phase: "run",
      message: "WebUI started.",
      web: { url: "http://0.0.0.0:4517" },
    });
    expect(stderr.text).toBe("");

    process.emit("SIGINT");
    await command;
    expect(close).toHaveBeenCalledOnce();
    expect(signalListenerCounts()).toEqual(listenerCounts);
  });

  it("passes token access when --token is set", async () => {
    const close = vi.fn(async () => undefined);
    mocks.startWebServer.mockReturnValue(okAsync({
      url: "http://localhost:4517/?token=generated",
      token: "generated",
      close,
    }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync(["--token", "--json"], { from: "user" });
    await waitForSignalListeners(listenerCounts);

    expect(mocks.startWebServer).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      host: "localhost",
      token: true,
      ensureDaemonRunning: expect.any(Function),
    }));
    expect(JSON.parse(stdout.text)).toEqual({
      schemaVersion: 1,
      ok: true,
      phase: "run",
      message: "WebUI started.",
      web: {
        url: "http://localhost:4517/?token=generated",
        token: "generated",
      },
    });
    expect(stderr.text).toBe("");

    process.emit("SIGTERM");
    await command;
    expect(close).toHaveBeenCalledOnce();
    expect(signalListenerCounts()).toEqual(listenerCounts);
  });

  it("closes once for repeated shutdown signals and resolves naturally", async () => {
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => {
      resolveClose = resolve;
    }));
    mocks.startWebServer.mockReturnValue(okAsync({ url: "http://localhost:4517", close }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const listenerCounts = signalListenerCounts();

    const command = createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
    }).parseAsync([], { from: "user" });
    await waitForSignalListeners(listenerCounts);

    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");

    expect(close).toHaveBeenCalledOnce();
    resolveClose();
    await command;

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
