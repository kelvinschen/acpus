import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestDaemonShutdown, startDaemonServer } from "../src/daemon/socket.js";

describe("daemon socket server", () => {
  it("tracks active request handlers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-"));
    let finishShutdown!: () => void;
    const server = await startDaemonServer(workspace, {
      status: () => ({ status: "ok", pid: process.pid, protocolVersion: 1, packageVersion: "test" }),
      admitRun: () => {
        throw new Error("not used");
      },
      control: () => {
        throw new Error("not used");
      },
      startRun: () => {
        throw new Error("not used");
      },
      shutdown: async () => {
        await new Promise<void>(resolve => {
          finishShutdown = resolve;
        });
        return { status: "shutdown" };
      },
    });
    try {
      const request = requestDaemonShutdown(workspace);
      await waitUntil(() => server.activeConnections() === 1);
      finishShutdown();
      await expect(request).resolves.toEqual({ status: "shutdown" });
      await waitUntil(() => server.activeConnections() === 0);
      expect(server.activeConnections()).toBe(0);
    } finally {
      finishShutdown?.();
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("tracks sockets while a request is still uploading", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-upload-"));
    const server = await startDaemonServer(workspace, testHandlers());
    const socket = connect(server.endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      await waitUntil(() => server.activeConnections() === 1);
      socket.resume();
      socket.end(JSON.stringify({ method: "status" }));
      await new Promise<void>((resolve, reject) => {
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
      expect(server.activeConnections()).toBe(0);
    } finally {
      socket.destroy();
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function testHandlers(): Parameters<typeof startDaemonServer>[1] {
  return {
    status: () => ({ status: "ok", pid: process.pid, protocolVersion: 1, packageVersion: "test" }),
    admitRun: () => {
      throw new Error("not used");
    },
    control: () => {
      throw new Error("not used");
    },
    startRun: () => {
      throw new Error("not used");
    },
    shutdown: () => ({ status: "shutdown" }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
