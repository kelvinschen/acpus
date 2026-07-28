import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonEndpoint, startDaemonLoop } from "../src/index.js";
import { admitSyntheticWorkflow, signalWorkflow } from "./support/runtime-fixtures.js";
import {
  requestDaemonControl,
  requestDaemonShutdown,
  requestDaemonStatus,
  waitUntil,
  withDaemonLeaseWorkspace,
} from "./support/daemon-lease-fixture.js";

describe.concurrent("daemon lease socket protocol", () => {
  it("serves daemon status on the workspace-derived endpoint", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        expect(daemonEndpoint(dir)).toContain("daemon");
        await expect(requestDaemonStatus(dir)).resolves.toMatchObject({
          status: "ok",
          pid: process.pid,
          generation: expect.any(Number),
          protocolVersion: 2,
          packageVersion: "0.0.0-test",
        });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("shuts down through the service lifecycle endpoint when idle", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonShutdown(dir)).resolves.toEqual({ status: "shutdown" });
        await waitUntil(() => store.getRuntimeDiagnostics().daemon === undefined);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("applies controls through the workspace-derived endpoint", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonControl(dir, {
          requestId: "test-cancel",
          type: "cancel",
          runId: awaiting.run.id,
        })).resolves.toMatchObject({
          type: "cancel",
          state: "applied",
          run: { id: awaiting.run.id, status: "canceled" },
        });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("returns stable daemon control error codes", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonControl(dir, {
          requestId: "test-missing",
          type: "cancel",
          runId: "run_missing",
        })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("returns control conflict for reused fork request ids with different input", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const source = await admitSyntheticWorkflow(dir, signalWorkflow());
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonControl(dir, {
          requestId: "fork-conflict",
          type: "fork",
          runId: source.run.id,
          target: "approve",
        })).resolves.toMatchObject({
          type: "fork",
          state: "applied",
          sourceRunId: source.run.id,
          run: { id: expect.any(String) },
        });
        await expect(requestDaemonControl(dir, {
          requestId: "fork-conflict",
          type: "fork",
          runId: source.run.id,
        })).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("uses socket binding as the single-instance authority", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(startDaemonLoop(dir, {
          heartbeatMs: 50,
          packageVersion: "0.0.0-test",
        })).rejects.toMatchObject({ code: "EADDRINUSE" });
        await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("removes a stale filesystem socket before binding", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const endpoint = daemonEndpoint(dir);
      if (endpoint.startsWith("\0") || process.platform === "win32") return;
      await mkdir(dirname(endpoint), { recursive: true });
      await writeFile(endpoint, "stale socket");

      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      try {
        await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("does not remove an unresponsive socket path while daemon diagnostics are fresh", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const endpoint = daemonEndpoint(dir);
      if (endpoint.startsWith("\0") || process.platform === "win32") return;
      store.claimDaemon({
        workspaceRealpath: dir,
        pid: process.pid,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      });
      await mkdir(dirname(endpoint), { recursive: true });
      await writeFile(endpoint, "not a socket");

      await expect(startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
    });
  });

  it("destroys half-open sockets during shutdown", async () => {
    await withDaemonLeaseWorkspace(async ({ dir }) => {
      const loop = await startDaemonLoop(dir, {
        heartbeatMs: 50,
        packageVersion: "0.0.0-test",
      });
      const socket = connect(daemonEndpoint(dir));
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        await expect(loop.shutdown()).resolves.toBeUndefined();
      } finally {
        socket.destroy();
        await loop.shutdown();
      }
    });
  });
});
