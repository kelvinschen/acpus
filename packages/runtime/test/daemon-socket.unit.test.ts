import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonEndpoint, DaemonRequestError, requestDaemonControl, requestDaemonShutdown, requestDaemonStatus, startDaemonServer } from "../src/daemon/socket.js";

describe("daemon socket server", () => {
  it("tracks active request handlers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-"));
    let finishShutdown!: () => void;
    const server = await startDaemonServer(workspace, {
      status: () => ({ status: "ok", pid: process.pid, generation: 1, protocolVersion: 1, packageVersion: "test" }),
      admitRun: () => {
        throw new Error("not used");
      },
      control: () => {
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
    const socket = connect(daemonEndpoint(workspace));
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

  it("preserves the status readiness error code", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-readiness-"));
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      status: () => {
        throw new DaemonRequestError("EXECUTION_UNAVAILABLE", "Daemon is still initializing.");
      },
    });
    try {
      await expect(requestDaemonStatus(workspace)).rejects.toMatchObject({ code: "EXECUTION_UNAVAILABLE" });
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a live pre-lease socket bound when another server starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-prelease-live-"));
    const first = await startDaemonServer(workspace, {
      ...testHandlers(),
      status: () => {
        throw new DaemonRequestError("EXECUTION_UNAVAILABLE", "Daemon is still initializing.");
      },
    });
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(requestDaemonStatus(workspace)).rejects.toMatchObject({ code: "EXECUTION_UNAVAILABLE" });
    } finally {
      await first.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only closed current request shapes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-protocol-"));
    const server = await startDaemonServer(workspace, testHandlers());
    try {
      const invalidRequests = [
        { method: "status", extra: true },
        { method: "unsupported" },
        { method: "control", control: { requestId: "pause", type: "pause", runId: "run_1", target: "node" } },
        { method: "control", control: { requestId: "fork", type: "fork", runId: "run_1", target: "" } },
        { method: "admitRun", prepared: preparedRunWorkflow(), input: {}, extra: true },
        { method: "admitRun", prepared: { ...preparedRunWorkflow(), extra: true }, input: {} },
      ];
      for (const request of invalidRequests) {
        await expect(sendRawRequest(daemonEndpoint(workspace), request)).resolves.toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }

      const response = await sendRawRequest(daemonEndpoint(workspace), { method: "status" });
      expect(response).toEqual({
        ok: true,
        result: { status: "ok", pid: process.pid, generation: 1, protocolVersion: 1, packageVersion: "test" },
      });
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a response outside the closed envelope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-response-"));
    const server = await startRawResponseServer(workspace, {
      ok: true,
      result: { status: "shutdown" },
      extra: true,
    });
    try {
      await expect(requestDaemonShutdown(workspace)).rejects.toThrow("Daemon returned an invalid response.");
    } finally {
      await closeRawResponseServer(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only closed result shapes", async () => {
    const shutdownWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-shutdown-result-"));
    const shutdownServer = await startRawResponseServer(shutdownWorkspace, {
      ok: true,
      result: { status: "shutdown", extra: true },
    });
    try {
      await expect(requestDaemonShutdown(shutdownWorkspace)).rejects.toThrow("Daemon returned an invalid shutdown response.");
    } finally {
      await closeRawResponseServer(shutdownServer);
      await rm(shutdownWorkspace, { recursive: true, force: true });
    }

    const controlWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-control-result-"));
    const controlServer = await startRawResponseServer(controlWorkspace, {
      ok: true,
      result: { run: { id: "run_1", status: "running" }, extra: true },
    });
    try {
      await expect(requestDaemonControl(controlWorkspace, { requestId: "pause", type: "pause", runId: "run_1" }))
        .rejects.toThrow("Daemon returned an invalid control response.");
    } finally {
      await closeRawResponseServer(controlServer);
      await rm(controlWorkspace, { recursive: true, force: true });
    }
  });
});

function testHandlers(): Parameters<typeof startDaemonServer>[1] {
  return {
    status: () => ({ status: "ok", pid: process.pid, generation: 1, protocolVersion: 1, packageVersion: "test" }),
    admitRun: () => {
      throw new Error("not used");
    },
    control: () => {
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

function preparedRunWorkflow() {
  return {
    workflowPath: "/tmp/test.workflow.ts",
    ir: { name: "test", root: {} },
    irJson: "{}",
    sourceGraphDigest: "source-digest",
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 1,
      workflow: { entry: "test.workflow.ts", sourceDigest: "source-digest" },
      ir: { path: "workflow.ir.json", digest: "ir-digest" },
      sourceGraphDigest: "source-digest",
    },
  };
}

async function sendRawRequest(endpoint: string, request: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.end(JSON.stringify(request)));
  });
}

async function startRawResponseServer(workspace: string, response: unknown): Promise<ReturnType<typeof createServer>> {
  const endpoint = daemonEndpoint(workspace);
  await mkdir(dirname(endpoint), { recursive: true });
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.resume();
    socket.once("end", () => socket.end(JSON.stringify(response)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeRawResponseServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
