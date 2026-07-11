import { describe, expect, it, vi } from "vitest";
import { startWebServer } from "../src/server/launcher.js";

const daemonReady = () => {};

describe("startWebServer access policy", () => {
  it("does not generate a token for network hosts by default", async () => {
    const server = await startWebServer({ cwd: process.cwd(), host: "0.0.0.0", ensureDaemonRunning: daemonReady });
    try {
      expect(server.token).toBeUndefined();
      expect(server.url).not.toContain("token=");
    } finally {
      await server.close();
    }
  });

  it("generates a token only when requested", async () => {
    const server = await startWebServer({ cwd: process.cwd(), token: true, ensureDaemonRunning: daemonReady });
    try {
      expect(server.token).toBeDefined();
      expect(server.url).toContain(`token=${encodeURIComponent(server.token!)}`);
    } finally {
      await server.close();
    }
  });

  it("allows repeated close calls", async () => {
    const server = await startWebServer({ cwd: process.cwd(), ensureDaemonRunning: daemonReady });

    await Promise.all([server.close(), server.close(), server.close()]);
    await server.close();
  });

  it("forwards the asynchronous daemon readiness barrier to control requests", async () => {
    const ensureDaemonRunning = vi.fn(async () => {
      throw new Error("daemon readiness failed");
    });
    const server = await startWebServer({ cwd: process.cwd(), ensureDaemonRunning });
    try {
      const response = await fetch(`${server.url}/api/runs/run_1/controls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });

      expect(response.status).toBe(500);
      expect(ensureDaemonRunning).toHaveBeenCalledWith(process.cwd());
    } finally {
      await server.close();
    }
  });
});
