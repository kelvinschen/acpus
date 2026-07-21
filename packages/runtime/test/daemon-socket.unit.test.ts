import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { daemonEndpoint, requestDaemonAdmitRun, requestDaemonControl, requestDaemonShutdown, requestDaemonStatus, startDaemonServer } from "../src/daemon/socket.js";
import { openRuntimeStore } from "../src/store/store.js";
import { err, ok, ResultAsync } from "neverthrow";

describe("daemon socket server", () => {
  it("tracks a connection while its request handler is active", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-"));
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    const server = await startDaemonServer(workspace, {
      status: () => ok({ status: "ok", pid: process.pid, generation: 1, protocolVersion: 1, packageVersion: "test" }),
      admitRun: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
      control: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
      shutdown: () => new ResultAsync((async () => {
        shutdownStarted.resolve();
        await releaseShutdown.promise;
        return ok({ status: "shutdown" as const });
      })()),
    });
    let request: ReturnType<typeof requestDaemonShutdown> | undefined;
    try {
      request = requestDaemonShutdown(workspace);
      await shutdownStarted.promise;
      expect(server.activeConnections()).toBe(1);
      releaseShutdown.resolve();
      expect(await request).toEqual(ok({ status: "shutdown" }));
      await waitUntil(() => server.activeConnections() === 0);
      expect(server.activeConnections()).toBe(0);
    } finally {
      releaseShutdown.resolve();
      if (request) await request;
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
      status: () => err({ code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }),
    });
    try {
      expect(await requestDaemonStatus(workspace)).toEqual(err({ type: "rejected", code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }));
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sanitizes unknown handler failures as internal errors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-internal-"));
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      control: () => {
        throw new Error("private scheduler invariant");
      },
    });
    try {
      expect(await requestDaemonControl(workspace, { requestId: "cancel", type: "cancel", runId: "run_1" })).toEqual(err({
        type: "rejected",
        code: "INTERNAL_ERROR",
        message: "Control 'cancel' could not be applied to run 'run_1'.",
      }));
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("classifies an ENOTDIR socket path as not found", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-enotdir-"));
    try {
      await writeFile(join(workspace, ".acpus"), "not a directory");
      expect(await requestDaemonStatus(workspace)).toEqual(err({
        type: "transport",
        reason: "not-found",
        method: "status",
        errno: "ENOTDIR",
        message: expect.any(String),
      }));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a live pre-lease socket bound when another server starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-prelease-live-"));
    const first = await startDaemonServer(workspace, {
      ...testHandlers(),
      status: () => err({ code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }),
    });
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(await requestDaemonStatus(workspace)).toEqual(err({ type: "rejected", code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }));
    } finally {
      await first.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps an occupied socket when pid liveness is unknown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-unknown-pid-"));
    const endpoint = daemonEndpoint(workspace);
    const store = await openRuntimeStore(workspace);
    const daemon = store.claimDaemon({
      workspaceRealpath: workspace,
      pid: 123,
      protocolVersion: 1,
      packageVersion: "test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    });
    store.close();
    await writeFile(endpoint, "occupied");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(daemon.heartbeatAt));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(readFile(endpoint, "utf8")).resolves.toBe("occupied");
    } finally {
      kill.mockRestore();
      now.mockRestore();
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
      expect(await requestDaemonShutdown(workspace)).toEqual(err({ type: "protocol", stage: "envelope", method: "shutdown", message: "Daemon returned an invalid response." }));
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
      expect(await requestDaemonShutdown(shutdownWorkspace)).toEqual(err({ type: "protocol", stage: "result", method: "shutdown", message: "Daemon returned an invalid shutdown result." }));
    } finally {
      await closeRawResponseServer(shutdownServer);
      await rm(shutdownWorkspace, { recursive: true, force: true });
    }

    const run = runDetails();
    const invalidControlResults = [
      { type: "pause", state: "applied", run: { id: "run_1", status: "running" } },
      { type: "pause", state: "applied", run: { ...run, status: "unknown" } },
      { type: "pause", state: "applied", run: { ...run, execution: { state: "active", lastStatus: "unknown" } } },
      { type: "pause", state: "applied", run, extra: true },
      { type: "fork", state: "applied", sourceRunId: "run_source", run, unexpected: true },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "raw-string", extra: true },
        run,
      },
    ];
    for (const result of invalidControlResults) {
      const controlWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-control-result-"));
      const controlServer = await startRawResponseServer(controlWorkspace, { ok: true, result });
      try {
        expect((await requestDaemonControl(controlWorkspace, controlIntent(result.type))).isErr()).toBe(true);
      } finally {
        await closeRawResponseServer(controlServer);
        await rm(controlWorkspace, { recursive: true, force: true });
      }
    }

    const mismatchedWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-control-mismatch-"));
    const mismatchedServer = await startRawResponseServer(mismatchedWorkspace, {
      ok: true,
      result: { type: "resume", state: "applied", run },
    });
    try {
      expect(await requestDaemonControl(mismatchedWorkspace, { requestId: "pause", type: "pause", runId: "run_1" })).toEqual(err({
        type: "protocol",
        stage: "result",
        method: "control",
        message: "Daemon returned an invalid pause control for run 'run_1' result.",
      }));
    } finally {
      await closeRawResponseServer(mismatchedServer);
      await rm(mismatchedWorkspace, { recursive: true, force: true });
    }

    const validControlResults = [
      { type: "pause", state: "applied", run },
      { type: "resume", state: "applied", run },
      { type: "retry", state: "applied", run },
      { type: "retry", state: "applied", target: "root", run },
      { type: "cancel", state: "applied", target: "root", run },
      { type: "fork", state: "applied", sourceRunId: "run_source", run },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "schema", schemaSummary: "{ ok: boolean }" },
        run,
      },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "raw-string" },
        run,
      },
    ];
    for (const result of validControlResults) {
      const controlWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-valid-control-result-"));
      const controlServer = await startRawResponseServer(controlWorkspace, { ok: true, result });
      try {
        expect(await requestDaemonControl(controlWorkspace, controlIntent(result.type))).toEqual(ok(result));
      } finally {
        await closeRawResponseServer(controlServer);
        await rm(controlWorkspace, { recursive: true, force: true });
      }
    }

    const admissionWorkspace = await mkdtemp(join(tmpdir(), "acpus-daemon-socket-admission-result-"));
    const admissionServer = await startRawResponseServer(admissionWorkspace, {
      ok: true,
      result: { id: "run_1", status: "running" },
    });
    try {
      expect(await requestDaemonAdmitRun(admissionWorkspace, {
        prepared: preparedRunWorkflow() as never,
        input: {},
      })).toEqual(err({
        type: "protocol",
        stage: "result",
        method: "admitRun",
        message: "Daemon returned an invalid run admission result.",
      }));
    } finally {
      await closeRawResponseServer(admissionServer);
      await rm(admissionWorkspace, { recursive: true, force: true });
    }
  });
});

function testHandlers(): Parameters<typeof startDaemonServer>[1] {
  return {
    status: () => ok({ status: "ok", pid: process.pid, generation: 1, protocolVersion: 1, packageVersion: "test" }),
    admitRun: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
    control: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
    shutdown: () => ok({ status: "shutdown" }),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
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

function runDetails() {
  return {
    id: "run_1",
    name: "test",
    status: "running",
    workflowEntry: "test.workflow.ts",
    sourceGraphDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:01.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 1,
    execution: { state: "active", lastStatus: "running" },
  } as const;
}

function controlIntent(type: string): Parameters<typeof requestDaemonControl>[1] {
  const base = { requestId: type, runId: "run_1" };
  if (type === "signal") return { ...base, type, nodeId: "approve", payload: "ok" };
  if (type === "fork") return { ...base, type };
  if (type === "retry" || type === "cancel") return { ...base, type };
  if (type === "pause" || type === "resume") return { ...base, type };
  throw new Error(`Unsupported control type '${type}'.`);
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
