import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeHealth } from "../src/index.js";
import { captureProcessIdentity } from "../src/process-liveness.js";
import type { RuntimeStoreAdapter } from "../src/store/store.js";
import { prepareSyntheticWorkflow, signalWorkflow } from "./support/runtime-fixtures.js";
import { withDaemonLeaseWorkspace } from "./support/daemon-lease-fixture.js";

type StoreWithDb = RuntimeStoreAdapter & {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  };
};

describe("Runtime authority health", () => {
  it("rejects a live owner and keeps heartbeat and release epoch-fenced", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const identity = captureProcessIdentity();
      const base = {
        workspaceRealpath: dir,
        pid: identity.pid,
        ...(identity.startToken === undefined ? {} : { processStartToken: identity.startToken }),
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      };

      const first = Result.getOrThrow(store.claimRuntimeAuthority({
        ...base,
        ownerId: "owner-1",
      }));
      expect(first).toMatchObject({ workspaceRealpath: dir, epoch: 1, pid: process.pid });
      expect(Result.getOrThrow(Result.flip(store.claimRuntimeAuthority({
        ...base,
        ownerId: "owner-2",
      })))).toMatchObject({
        type: "runtime-authority-busy",
        pid: process.pid,
      });
      expect(store.heartbeatRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: first.ownerId,
        epoch: first.epoch,
      })).toBe(true);
      expect(store.heartbeatRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: "owner-2",
        epoch: first.epoch,
      })).toBe(false);
      expect(store.releaseRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: "owner-2",
        epoch: first.epoch,
      })).toBe(false);
      expect(store.releaseRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: first.ownerId,
        epoch: first.epoch,
      })).toBe(true);
      const second = Result.getOrThrow(store.claimRuntimeAuthority({
        ...base,
        ownerId: "owner-2",
        pid: process.pid,
      }));
      expect(second).toMatchObject({ epoch: 2, ownerId: "owner-2" });
    });
  });

  it.skipIf(process.platform !== "linux")("reclaims authority after PID reuse", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const identity = captureProcessIdentity();
      if (identity.startToken === undefined) throw new Error("Expected a Linux process start token.");
      const base = {
        workspaceRealpath: dir,
        pid: identity.pid,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      };
      Result.getOrThrow(store.claimRuntimeAuthority({
        ...base,
        ownerId: "stale-owner",
        processStartToken: `${identity.startToken}:reused`,
      }));

      const claimed = Result.getOrThrow(store.claimRuntimeAuthority({
        ...base,
        ownerId: "current-owner",
        processStartToken: identity.startToken,
      }));

      expect(claimed).toMatchObject({ epoch: 2, ownerId: "current-owner" });
    });
  });

  it("does not replace authority when its process token cannot be verified", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const base = {
          workspaceRealpath: dir,
          pid: Number.MAX_SAFE_INTEGER,
          processStartToken: "unreadable",
          protocolVersion: 1,
          packageVersion: "0.0.0-test",
          nodeVersion: process.version,
          execPath: process.execPath,
          idleStopMs: 30_000,
        };
        Result.getOrThrow(store.claimRuntimeAuthority({ ...base, ownerId: "unknown-owner" }));

        expect(Result.isFailure(store.claimRuntimeAuthority({ ...base, ownerId: "replacement-owner" })))
          .toBe(true);
      } finally {
        kill.mockRestore();
      }
    });
  });

  it("maps process liveness through the run-execution evidence priority", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const prepared = await prepareSyntheticWorkflow(dir, signalWorkflow());
      const admitted = await Effect.runPromise(store.admitRun({ prepared, cwd: dir, input: {} }));
      const authority = Result.getOrThrow(store.claimRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: "execution-owner",
        pid: 123,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      }));
      const nowMs = Date.parse(authority.heartbeatAt);
      const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
      const kill = vi.spyOn(process, "kill");
      const db = (store as StoreWithDb).db;
      try {
        const active = store.scheduler.claimRun(admitted.id, "active-owner", 60_000)!;
        kill.mockImplementation(() => {
          throw Object.assign(new Error("missing"), { code: "ESRCH" });
        });
        db.prepare("UPDATE runtime_authority SET heartbeat_at = ?")
          .run(new Date(nowMs - 5_001).toISOString());
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "stale",
          reason: "runtime_authority_heartbeat_expired",
        });

        db.prepare("UPDATE runtime_authority SET heartbeat_at = ?").run(authority.heartbeatAt);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "stale",
          reason: "runtime_authority_pid_dead",
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

        db.prepare("UPDATE runtime_authority SET heartbeat_at = ?").run(authority.heartbeatAt);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "inactive",
          reason: "runtime_authority_alive",
        });

        db.prepare("UPDATE runtime_authority SET heartbeat_at = NULL").run();
        expect(store.getRun(admitted.id)?.execution)
          .toEqual({ state: "unknown", lastStatus: "pending" });

        kill.mockImplementation(() => true);
        expect(store.getRun(admitted.id)?.execution).toMatchObject({
          state: "inactive",
          reason: "runtime_authority_alive",
        });
      } finally {
        kill.mockRestore();
        now.mockRestore();
      }
    });
  });

  it("maps process liveness explicitly in doctor output", async () => {
    await withDaemonLeaseWorkspace(async ({ dir, store }) => {
      const authority = Result.getOrThrow(store.claimRuntimeAuthority({
        workspaceRealpath: dir,
        ownerId: "doctor-owner",
        pid: 123,
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      }));
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(authority.heartbeatAt));
      const kill = vi.spyOn(process, "kill");
      const daemonCheck = async () =>
        (await Effect.runPromise(getRuntimeHealth(dir))).checks.find(check => check.area === "daemon")!;
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
