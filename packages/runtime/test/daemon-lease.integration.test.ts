import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow, z } from "@acpus/core";
import type { Result } from "neverthrow";
import {
  daemonEndpoint,
  getRun,
  getRuntimeHealth,
  requestDaemonAdmitRun as requestDaemonAdmitRunResult,
  requestDaemonControl as requestDaemonControlResult,
  requestDaemonShutdown as requestDaemonShutdownResult,
  requestDaemonStatus as requestDaemonStatusResult,
  startDaemonLoop,
  type DaemonClientFailure,
} from "../src/index.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { admitSyntheticWorkflow, prepareSyntheticWorkflow, runtimeRows, signalWorkflow, validWorkflow } from "./support/runtime-fixtures.js";

let dir: string;
let store: RuntimeStore;

type StoreWithDb = RuntimeStore & {
  db: {
    prepare(sql: string): {
      all(): Array<{ name: string }>;
      run(...params: unknown[]): unknown;
    };
  };
};

async function requestDaemonAdmitRun(...args: Parameters<typeof requestDaemonAdmitRunResult>) {
  return unwrapDaemon(await requestDaemonAdmitRunResult(...args));
}

async function requestDaemonControl(...args: Parameters<typeof requestDaemonControlResult>) {
  return unwrapDaemon(await requestDaemonControlResult(...args));
}

async function requestDaemonShutdown(...args: Parameters<typeof requestDaemonShutdownResult>) {
  return unwrapDaemon(await requestDaemonShutdownResult(...args));
}

async function requestDaemonStatus(...args: Parameters<typeof requestDaemonStatusResult>) {
  return unwrapDaemon(await requestDaemonStatusResult(...args));
}

function unwrapDaemon<T>(result: Result<T, DaemonClientFailure>): T {
  if (result.isOk()) return result.value;
  throw Object.assign(new Error(result.error.message), result.error.type === "rejected" ? { code: result.error.code } : {});
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-daemon-"));
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("daemon lease", () => {
  it("records daemon generations while heartbeat and release stay generation-fenced", () => {
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

    expect(store.heartbeatDaemon({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.heartbeatDaemon({ workspaceRealpath: dir, generation: second.generation })).toBe(true);
    expect(store.releaseDaemon({ workspaceRealpath: dir, generation: first.generation })).toBe(false);
    expect(store.releaseDaemon({ workspaceRealpath: dir, generation: second.generation })).toBe(true);

    const third = store.claimDaemon({ ...base, pid: 103 });
    expect(third).toMatchObject({ generation: 1, pid: 103 });
  });

  it("stores daemon liveness without endpoint or auth metadata", () => {
    store.claimDaemon({
      workspaceRealpath: dir,
      pid: 100,
      protocolVersion: 1,
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    });

    const columns = storeDbColumns("daemon_lease");
    expect(columns).not.toContain("endpoint");
    expect(columns).not.toContain("auth_token_hash");
  });

  it("maps process liveness through the run-execution evidence priority", async () => {
    const prepared = await prepareSyntheticWorkflow(dir, signalWorkflow());
    const admitted = (await store.admitRun({ prepared, cwd: dir, input: {} }))._unsafeUnwrap();
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
      db.prepare("UPDATE daemon_lease SET heartbeat_at = ?").run(new Date(nowMs - 5_001).toISOString());
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "stale", reason: "daemon_heartbeat_expired" });

      db.prepare("UPDATE daemon_lease SET heartbeat_at = ?").run(daemon.heartbeatAt);
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "stale", reason: "daemon_pid_dead" });

      kill.mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "active", reason: "run_lease_active" });
      store.scheduler.releaseRun(active);

      const expired = store.scheduler.claimRun(admitted.id, "expired-owner", -60_000)!;
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "stale", reason: "run_lease_expired" });
      store.scheduler.releaseRun(expired);

      db.prepare("UPDATE daemon_lease SET heartbeat_at = ?").run(daemon.heartbeatAt);
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "inactive", reason: "daemon_alive" });

      db.prepare("UPDATE daemon_lease SET heartbeat_at = NULL").run();
      expect(store.getRun(admitted.id)?.execution).toEqual({ state: "unknown", lastStatus: "pending" });

      kill.mockImplementation(() => true);
      expect(store.getRun(admitted.id)?.execution).toMatchObject({ state: "inactive", reason: "daemon_alive" });
    } finally {
      kill.mockRestore();
      now.mockRestore();
    }
  });

  it("maps process liveness explicitly in doctor output", async () => {
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
    const daemonCheck = async () => (await getRuntimeHealth(dir)).checks.find(check => check.area === "daemon")!;
    try {
      kill.mockImplementation(() => true);
      await expect(daemonCheck()).resolves.toMatchObject({ status: "ok", details: { processAlive: true } });

      kill.mockImplementation(() => {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      });
      await expect(daemonCheck()).resolves.toMatchObject({ status: "warn", details: { processAlive: false } });

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

  it("serves daemon status on the workspace-derived endpoint", async () => {
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
        protocolVersion: 1,
        packageVersion: "0.0.0-test",
      });
    } finally {
      await loop.shutdown();
    }
  });

  it("shuts down through the service lifecycle endpoint when idle", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    await expect(requestDaemonShutdown(dir)).resolves.toEqual({ status: "shutdown" });
    await waitUntil(() => store.getRuntimeDiagnostics().daemon === undefined);
    await loop.shutdown();
  });

  it("applies controls through the workspace-derived endpoint", async () => {
    const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-cancel", type: "cancel", runId: awaiting.run.id })).resolves.toMatchObject({
        type: "cancel",
        state: "applied",
        run: { id: awaiting.run.id, status: "canceled" },
      });
    } finally {
      await loop.shutdown();
    }
  });

  it("applies cancel to daemon-owned active execution without lease conflict", async () => {
    const markerPath = join(dir, "active-cancel.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "started");

      await expect(requestDaemonControl(dir, { requestId: "test-active-cancel", type: "cancel", runId: admitted.id })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
        status: "canceled",
        run: { id: admitted.id, status: "canceled" },
      });
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("aborts only the targeted active Task while a parallel sibling completes", async () => {
    const leftMarker = join(dir, "targeted-parallel-left.marker");
    const rightMarker = join(dir, "targeted-parallel-right.marker");
    const rightRelease = join(dir, "targeted-parallel-right.release");
    const prepared = await prepareSyntheticWorkflow(dir, targetedParallelTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { leftMarker, rightMarker, rightRelease } });
      await waitUntil(async () =>
        await readFile(leftMarker, "utf8").catch(() => undefined) === "started"
        && await readFile(rightMarker, "utf8").catch(() => undefined) === "started");
      const attempts = runtimeRows(dir, "SELECT attempt_id, node_key, node_id FROM node_attempts WHERE run_id = ? AND status = 'started' ORDER BY node_id", admitted.id) as Array<{ attempt_id: string; node_key: string; node_id: string }>;
      expect(attempts.map(attempt => attempt.node_id)).toEqual(["left_task", "right_task"]);
      const left = attempts.find(attempt => attempt.node_id === "left_task")!;

      await expect(requestDaemonControl(dir, {
        requestId: "test-targeted-active-cancel",
        type: "cancel",
        runId: admitted.id,
        target: left.node_key,
      })).resolves.toMatchObject({ type: "cancel", state: "applied", target: left.node_key, run: { id: admitted.id, status: "running" } });
      await writeFile(rightRelease, "release");
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
        status: "completed",
        run: { status: "completed", output: { winner: "right", value: "right" } },
      });
      await waitUntil(async () => await readFile(leftMarker, "utf8").catch(() => undefined) === "aborted");
      await expect(readFile(rightMarker, "utf8")).resolves.toBe("completed");
      expect(runtimeRows(dir, "SELECT node_id, status, cancel_reason FROM node_attempts WHERE run_id = ? ORDER BY node_id", admitted.id)).toEqual([
        { node_id: "left_task", status: "cancelled", cancel_reason: "operator_cancelled" },
        { node_id: "right_task", status: "completed", cancel_reason: null },
      ]);
      expect(runtimeRows(dir, "SELECT branch_id, status, terminal_reason FROM group_members WHERE run_id = ? ORDER BY branch_id", admitted.id)).toEqual([
        { branch_id: "left", status: "cancelled", terminal_reason: "operator_cancelled" },
        { branch_id: "right", status: "completed", terminal_reason: null },
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 10_000);

  it("runs hooks for daemon-owned active controls", async () => {
    const sideEffectPath = join(dir, "active-cancel-hook-side-effect.marker");
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.canceled": [{
        id: "active-canceled",
        command: `${process.execPath} -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{require("node:fs").appendFileSync(${JSON.stringify(sideEffectPath)},"fired\\n");process.stdout.write(JSON.parse(s).run.status)})'`,
      }],
    }));
    const markerPath = join(dir, "active-cancel-hook.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await waitUntil(() => runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'", admitted.id).length > 0);
      await expect(requestDaemonControl(dir, { requestId: "test-active-cancel-hook", type: "cancel", runId: admitted.id })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({ status: "canceled" });
      await loop.shutdown();
      await expect(readFile(sideEffectPath, "utf8")).resolves.toBe("fired\n");
      expect(store.getHookJournal(admitted.id)).toEqual([
        expect.objectContaining({
          handlerId: "active-canceled",
          event: "run.canceled",
          status: "completed",
          stdout: "canceled",
        }),
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("does not expose inactive scheduler ownership details through daemon control", async () => {
    const markerPath = join(dir, "inactive-owner-control.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await waitUntil(() => runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ? AND status = 'started'", admitted.id).length > 0);
      const row = runtimeRows(dir, "SELECT owner_id, owner_epoch, lease_expires_at FROM run_leases WHERE run_id = ? AND released_at IS NULL", admitted.id)[0] as { owner_id: string; owner_epoch: number; lease_expires_at: string };
      expect(store.scheduler.releaseRun({ runId: admitted.id, ownerId: row.owner_id, ownerEpoch: row.owner_epoch, leaseExpiresAt: row.lease_expires_at })).toBe(true);

      const error = await requestDaemonControl(dir, { requestId: "test-inactive-owner", type: "cancel", runId: admitted.id }).catch(cause => cause as Error & { code?: string });
      expect(error).toMatchObject({
        code: "RUN_NOT_CONTROLLABLE",
        message: `Control 'cancel' could not be applied to run '${admitted.id}'.`,
      });
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("applies immediate control after admission without falling back to a second owner", async () => {
    const markerPath = join(dir, "immediate-cancel.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await expect(requestDaemonControl(dir, { requestId: "test-immediate-cancel", type: "cancel", runId: admitted.id })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({
        status: "canceled",
        run: { id: admitted.id, status: "canceled" },
      });
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("runs configured project hooks from daemon-owned execution", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{
        id: "print-run",
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
      }],
    }));
    const prepared = await prepareSyntheticWorkflow(dir, validWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { ready: true } });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({ status: "completed" });
      await waitUntil(() => store.getHookJournal(admitted.id).length > 0);
      expect(store.getHookJournal(admitted.id)).toEqual([
        expect.objectContaining({
          handlerId: "print-run",
          event: "run.completed",
          status: "completed",
          stdout: admitted.id,
        }),
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("runs hooks for short-session signal controls", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "node.completed": [{
        id: "signal-completed",
        match: { nodeId: "^approve$" },
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).node.key))"`,
      }],
    }));
    const awaiting = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-signal-hook", type: "signal", runId: awaiting.run.id, nodeId: "approve", payload: { ok: true } }))
        .resolves.toMatchObject({
          type: "signal",
          state: "consumed",
          requestedTarget: "approve",
          target: expect.stringMatching(/^approve~[0-9a-f]{12}$/),
          validation: { kind: "schema", schemaSummary: "{ ok: boolean }" },
          run: { id: awaiting.run.id },
        });
      await waitUntil(() => store.getHookJournal(awaiting.run.id).length > 0);
      expect(store.getHookJournal(awaiting.run.id)).toEqual([
        expect.objectContaining({
          handlerId: "signal-completed",
          event: "node.completed",
          status: "completed",
          stdout: expect.stringMatching(/^approve/),
        }),
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("runs hooks for daemon-created fork runs", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{
        id: "fork-completed",
        command: `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).run.id))"`,
      }],
    }));
    const source = await admitSyntheticWorkflow(dir, validWorkflow(), { ready: true });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const fork = await requestDaemonControl(dir, { requestId: "test-fork-hook", type: "fork", runId: source.run.id });
      expect(fork).toMatchObject({ type: "fork", state: "applied", sourceRunId: source.run.id });
      expect(fork.run.id).not.toBe(source.run.id);
      await waitUntil(() => store.getHookJournal(fork.run.id).length > 0);
      expect(store.getHookJournal(fork.run.id)).toEqual([
        expect.objectContaining({
          handlerId: "fork-completed",
          event: "run.completed",
          status: "completed",
          stdout: fork.run.id,
        }),
      ]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("fails daemon startup for invalid hooks config", async () => {
    await mkdir(join(dir, ".acpus"), { recursive: true });
    await writeFile(join(dir, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{ command: "" }],
    }));

    await expect(startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    })).rejects.toThrow("Invalid hooks config");
  });

  it("rejects shutdown while a run execution session is active", async () => {
    const markerPath = join(dir, "shutdown-active.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "started");
      await expect(requestDaemonShutdown(dir)).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
      await expect(requestDaemonControl(dir, { requestId: "test-shutdown-active-cancel", type: "cancel", runId: admitted.id })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({ status: "canceled" });
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("fences and stops active executors during host teardown without mutating the run", async () => {
    const markerPath = join(dir, "host-teardown.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "started");

      await loop.shutdown();

      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "aborted");
      expect(runtimeRows(dir, "SELECT status FROM runs WHERE id = ?", admitted.id)).toEqual([{ status: "running" }]);
      expect(runtimeRows(dir, "SELECT status FROM node_attempts WHERE run_id = ?", admitted.id)).toEqual([{ status: "started" }]);
      expect(runtimeRows(dir, "SELECT released_at IS NOT NULL AS released FROM run_leases WHERE run_id = ?", admitted.id)).toEqual([{ released: 1 }]);
    } finally {
      await loop.shutdown();
    }
  }, 5_000);

  it("does not idle-stop while a run execution session is active", async () => {
    const markerPath = join(dir, "idle-active.marker");
    const prepared = await prepareSyntheticWorkflow(dir, activeTaskWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 10,
      idleStopMs: 20,
      packageVersion: "0.0.0-test",
    });
    try {
      const admitted = await requestDaemonAdmitRun(dir, { prepared, input: { markerPath } });
      const idleCheckAt = Date.now() + 50;
      await waitUntil(async () => await readFile(markerPath, "utf8").catch(() => undefined) === "started");
      await new Promise(resolve => setTimeout(resolve, Math.max(0, idleCheckAt - Date.now())));
      await expect(requestDaemonStatus(dir)).resolves.toMatchObject({ status: "ok" });
      await expect(requestDaemonControl(dir, { requestId: "test-idle-active-cancel", type: "cancel", runId: admitted.id })).resolves.toMatchObject({
        run: { id: admitted.id, status: "canceled" },
      });
      await expect(waitForTerminalRun(dir, admitted.id)).resolves.toMatchObject({ status: "canceled" });
    } finally {
      await loop.shutdown();
    }
  });

  it("returns stable daemon control error codes", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "test-missing", type: "cancel", runId: "run_missing" }))
        .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    } finally {
      await loop.shutdown();
    }
  });

  it("returns control conflict for reused fork request ids with different input", async () => {
    const source = await admitSyntheticWorkflow(dir, signalWorkflow());
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    try {
      await expect(requestDaemonControl(dir, { requestId: "fork-conflict", type: "fork", runId: source.run.id, target: "approve" }))
        .resolves.toMatchObject({ type: "fork", state: "applied", sourceRunId: source.run.id, run: { id: expect.any(String) } });
      await expect(requestDaemonControl(dir, { requestId: "fork-conflict", type: "fork", runId: source.run.id }))
        .rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
    } finally {
      await loop.shutdown();
    }
  });

  it("uses socket binding as the single-instance authority", async () => {
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

  it("removes a stale filesystem socket before binding", async () => {
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

  it("does not remove an unresponsive socket path while daemon diagnostics are fresh", async () => {
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

  it("destroys half-open sockets during shutdown", async () => {
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      packageVersion: "0.0.0-test",
    });
    const socket = connect(daemonEndpoint(dir));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await expect(loop.shutdown()).resolves.toBeUndefined();
    socket.destroy();
  });
});

function activeTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-active-cancel",
    inputSchema: z.object({ markerPath: z.string().optional() }),
  }).build(({ input, step }) => {
    const task = step("slow_task").task({
      input: { markerPath: input.markerPath },
      exec: async ({ input, abortSignal }) => await new Promise<{ ok: boolean }>(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (input.markerPath) process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "aborted");
          resolve({ ok: false });
        };
        abortSignal.addEventListener("abort", finish, { once: true });
        if (abortSignal.aborted) finish();
        else if (input.markerPath) process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "started");
      }),
    });
    return { ok: task.output.ok };
  });
}

function targetedParallelTaskWorkflow() {
  return defineWorkflow({
    name: "daemon-targeted-active-cancel",
    inputSchema: z.object({ leftMarker: z.string(), rightMarker: z.string(), rightRelease: z.string() }),
  }).build(({ input, step }) => {
    const race = step("race").parallel({
      strategy: "race",
      branches: {
        left() {
          const task = step("left_task").task({
            input: { markerPath: input.leftMarker, value: "left" }, exec: cancellableMarkerTask,
          });
          return { value: task.output.value };
        },
        right() {
          const task = step("right_task").task({
            input: { markerPath: input.rightMarker, releasePath: input.rightRelease, value: "right" }, exec: cancellableMarkerTask,
          });
          return { value: task.output.value };
        },
      },
    });
    return { winner: race.output.winner, value: race.output.result.value };
  });
}

async function cancellableMarkerTask({ input, abortSignal }: { input: { markerPath: string; value: string; releasePath?: string }; abortSignal: AbortSignal }): Promise<{ value: string }> {
  return await new Promise(resolve => {
    let settled = false;
    let releasePoll: ReturnType<typeof setInterval> | undefined;
    const finish = (marker: string) => {
      if (settled) return;
      settled = true;
      if (releasePoll) clearInterval(releasePoll);
      process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, marker);
      resolve({ value: input.value });
    };
    const releasePath = input.releasePath;
    if (releasePath) {
      releasePoll = setInterval(() => {
        if (process.getBuiltinModule("node:fs").existsSync(releasePath)) finish("completed");
      }, 10);
    }
    abortSignal.addEventListener("abort", () => finish("aborted"), { once: true });
    if (abortSignal.aborted) finish("aborted");
    else process.getBuiltinModule("node:fs").writeFileSync(input.markerPath, "started");
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

async function waitForTerminalRun(cwd: string, runId: string): Promise<{ status: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = await getRun(cwd, runId);
    if (run && ["completed", "failed", "canceled"].includes(run.status)) return { status: run.status, run };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run '${runId}' did not become terminal.`);
}

function storeDbColumns(table: string): string[] {
  return (store as StoreWithDb)
    .db.prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => row.name);
}
