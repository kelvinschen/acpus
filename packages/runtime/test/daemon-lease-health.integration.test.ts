import { describe, expect, it, vi } from "vitest";
import { getRuntimeHealth } from "../src/index.js";
import type { RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, signalWorkflow } from "./support/runtime-fixtures.js";
import { withDaemonLeaseWorkspace } from "./support/daemon-lease-fixture.js";

type StoreWithDb = RuntimeStore & {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  };
};

describe("daemon lease health", () => {
  it("records daemon generations while heartbeat and release stay generation-fenced", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const base = {
        workspaceRealpath: dir,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      };

      const first = store.claimDaemon({ ...base, pid: 100 });
      expect(first).toMatchObject({ workspaceRealpath: dir, generation: 1, pid: 100 });
      const second = store.claimDaemon({ ...base, pid: 102 });
      expect(second).toMatchObject({ generation: 2, pid: 102 });
      expect(store.heartbeatDaemon({
        workspaceRealpath: dir,
        generation: first.generation,
      })).toBe(false);
      expect(store.heartbeatDaemon({
        workspaceRealpath: dir,
        generation: second.generation,
      })).toBe(true);
      expect(store.releaseDaemon({
        workspaceRealpath: dir,
        generation: first.generation,
      })).toBe(false);
      expect(store.releaseDaemon({
        workspaceRealpath: dir,
        generation: second.generation,
      })).toBe(true);
      const third = store.claimDaemon({ ...base, pid: 103 });
      expect(third).toMatchObject({ generation: 1, pid: 103 });
    });
  });

  it("maps process liveness through the run-execution evidence priority", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const prepared = await prepareSyntheticWorkflow(dir, signalWorkflow());
      const admitted = (await store.admitRun({ prepared, cwd: dir, input: {} }))
        ._unsafeUnwrap();
      const daemon = store.claimDaemon({
        workspaceRealpath: dir,
        pid: 123,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      });
      const nowMs = Date.parse(daemon.heartbeatAt);
      const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
      const kill = vi.spyOn(process, "kill");
      const db = (store as StoreWithDb).db;
      try {
        const active = store.scheduler.claimRun(admitted.id, "active-owner", 60_000)!;
        kill.mockImplementation(() => {
          throw Object.assign(new Error("missing"), { code: "ESRCH" });
        });
        db.prepare("UPDATE daemon_lease SET heartbeat_at = ?")
          .run(new Date(nowMs - 5_001).toISOString());
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "stale",
          reason: "daemon_heartbeat_expired",
        });

        db.prepare("UPDATE daemon_lease SET heartbeat_at = ?").run(daemon.heartbeatAt);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "stale",
          reason: "daemon_pid_dead",
        });

        kill.mockImplementation(() => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        });
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "active",
          reason: "run_lease_active",
        });
        store.scheduler.releaseRun(active);

        const expired = store.scheduler.claimRun(admitted.id, "expired-owner", -60_000)!;
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "stale",
          reason: "run_lease_expired",
        });
        store.scheduler.releaseRun(expired);

        db.prepare("UPDATE daemon_lease SET heartbeat_at = ?").run(daemon.heartbeatAt);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "inactive",
          reason: "daemon_alive",
        });

        db.prepare("UPDATE daemon_lease SET heartbeat_at = NULL").run();
        expect(store.getRun(admitted.id)?.execution)
          .toEqual({ state: "unknown", lastStatus: "pending" });

        kill.mockImplementation(() => true);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "inactive",
          reason: "daemon_alive",
        });
      } finally {
        kill.mockRestore();
        now.mockRestore();
      }
    });
  });

  it("maps process liveness explicitly in doctor output", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const daemon = store.claimDaemon({
        workspaceRealpath: dir,
        pid: 123,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      });
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(daemon.heartbeatAt));
      const kill = vi.spyOn(process, "kill");
      const daemonCheck = async () =>
        (await getRuntimeHealth(dir)).checks.find(check => check.area === "daemon")!;
      try {
        kill.mockImplementation(() => true);
        await expect(daemonCheck()).resolves.toMatchObject({
          status: "ok",
          details: { processAlive: true },
        });

        kill.mockImplementation(() => {
          throw Object.assign(new Error("missing"), { code: "ESRCH" });
        });
        await expect(daemonCheck()).resolves.toMatchObject({
          status: "warn",
          details: { processAlive: false },
        });

        kill.mockImplementation(() => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        });
        const unknown = await daemonCheck();
        expect(unknown).toMatchObject({ status: "ok" });
        expect(unknown.details).not.toHaveProperty("processAlive");
      } finally {
        kill.mockRestore();
        now.mockRestore();
      }
    });
  });
});
