import { describe, expect, it, vi } from "vitest";
import { createWebCommand } from "../src/commands/web.js";
import { CaptureStream } from "./support/capture-stream.js";

type StartedWebServerOptions = Parameters<NonNullable<Parameters<typeof createWebCommand>[0]["startWebServer"]>>[0];

describe("web command options", () => {
  it("does not request token access for network hosts by default", async () => {
    const startWebServer = vi.fn(async (_options: StartedWebServerOptions) => ({
      url: "http://0.0.0.0:4517",
      close: async () => undefined,
    }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
      wantsJson: true,
      startWebServer,
      waitForSignals: false,
    }).parseAsync(["--host", "0.0.0.0"], { from: "user" });

    expect(startWebServer).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      host: "0.0.0.0",
    }));
    expect(startWebServer.mock.calls[0]![0]).not.toHaveProperty("token");
    expect(JSON.parse(stdout.text)).toEqual({ url: "http://0.0.0.0:4517" });
    expect(stderr.text).toBe("");
  });

  it("passes token access when --token is set", async () => {
    const startWebServer = vi.fn(async (_options: StartedWebServerOptions) => ({
      url: "http://localhost:4517/?token=generated",
      token: "generated",
      close: async () => undefined,
    }));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await createWebCommand({
      cwd: "/workspace",
      stdout,
      stderr,
      wantsJson: true,
      startWebServer,
      waitForSignals: false,
    }).parseAsync(["--token"], { from: "user" });

    expect(startWebServer).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      host: "localhost",
      token: true,
    }));
    expect(JSON.parse(stdout.text)).toEqual({
      url: "http://localhost:4517/?token=generated",
      token: "generated",
    });
    expect(stderr.text).toBe("");
  });
});
