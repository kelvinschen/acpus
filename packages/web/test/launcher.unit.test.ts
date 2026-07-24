import { describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerStartFailure } from "../src/index.js";

const daemonReady = () => {};

describe("startWebServer access policy", () => {
  it("does not generate a token for network hosts by default", async () => {
    const server = await startedServer({ cwd: process.cwd(), host: "0.0.0.0", ensureDaemonRunning: daemonReady });
    try {
      expect(server.token).toBeUndefined();
      expect(server.url).not.toContain("token=");
    } finally {
      await server.close();
    }
  });

  it("generates a token only when requested", async () => {
    const server = await startedServer({ cwd: process.cwd(), token: true, ensureDaemonRunning: daemonReady });
    try {
      expect(server.token).toBeDefined();
      expect(server.url).toContain(`token=${encodeURIComponent(server.token!)}`);
    } finally {
      await server.close();
    }
  });

  it("allows repeated close calls", async () => {
    const server = await startedServer({ cwd: process.cwd(), ensureDaemonRunning: daemonReady });

    await Promise.all([server.close(), server.close(), server.close()]);
    await server.close();
  });

  it("forwards asynchronous daemon readiness failures through the server error boundary", async () => {
    const cause = new Error("daemon readiness failed");
    const ensureDaemonRunning = vi.fn(async () => {
      throw cause;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const server = await startedServer({ cwd: process.cwd(), ensureDaemonRunning });
      try {
        const response = await fetch(`${server.url}/api/runs/run_1/controls`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "pause" }),
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          ok: false,
          error: { code: "internal_error", message: "Internal server error." },
        });
      } finally {
        await server.close();
      }
      expect(ensureDaemonRunning).toHaveBeenCalledWith(process.cwd());
      expect(logged).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith("Acpus WebUI request failed:", cause);
    } finally {
      logged.mockRestore();
    }
  });

  it("returns a tagged failure when the requested port is occupied", async () => {
    const first = await startedServer({ cwd: process.cwd(), host: "127.0.0.1", ensureDaemonRunning: daemonReady });
    try {
      const port = Number(new URL(first.url).port);
      const second = await startWebServer({ cwd: process.cwd(), host: "127.0.0.1", port, ensureDaemonRunning: daemonReady });
      expect(second.isErr()).toBe(true);
      if (second.isErr()) {
        const failure: WebServerStartFailure = second.error;
        expect(failure).toMatchObject({ type: "listen-failed", host: "127.0.0.1", port });
      }
    } finally {
      await first.close();
    }
  });
});

async function startedServer(options: Parameters<typeof startWebServer>[0]) {
  const result = await startWebServer(options);
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}
