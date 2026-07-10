import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonTickResult } from "../src/daemon/tick.js";

const runDaemonTick = vi.fn<() => Promise<DaemonTickResult>>();

vi.mock("../src/daemon/tick.js", () => ({ runDaemonTick }));

const { startDaemonLoop } = await import("../src/daemon/loop.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-daemon-loop-"));
  runDaemonTick.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daemon loop", () => {
  it("continues heartbeating while a work tick is still running", async () => {
    let finishTick!: () => void;
    runDaemonTick.mockImplementationOnce(() => new Promise(resolve => {
      finishTick = () => resolve({ runs: 1, idleBlockers: 1 });
    }));

    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 20,
      idleStopMs: 1_000,
      packageVersion: "test",
    });
    try {
      await waitUntil(() => runDaemonTick.mock.calls.length > 0);
      const firstHeartbeat = await waitUntilValue(() => daemonHeartbeat(dir));
      await waitUntil(() => daemonHeartbeat(dir) !== firstHeartbeat);
      finishTick();
    } finally {
      finishTick?.();
      await loop.shutdown();
    }
  });

  it("waits for an active work tick before closing the store", async () => {
    let finishTick!: () => void;
    runDaemonTick.mockImplementationOnce(() => new Promise(resolve => {
      finishTick = () => resolve({ runs: 1, idleBlockers: 1 });
    }));

    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 20,
      idleStopMs: 1_000,
      packageVersion: "test",
    });
    await waitUntil(() => runDaemonTick.mock.calls.length > 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(runDaemonTick).toHaveBeenCalledOnce();
    let shutdownResolved = false;
    const shutdown = loop.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(shutdownResolved).toBe(false);
    finishTick();
    await shutdown;
    expect(shutdownResolved).toBe(true);
  });

  it("retries transient store-busy tick failures", async () => {
    runDaemonTick
      .mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))
      .mockResolvedValue({ runs: 1, idleBlockers: 0 });
    const onShutdown = vi.fn();
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 5,
      idleStopMs: 1_000,
      packageVersion: "test",
      onShutdown,
    });
    try {
      await waitUntil(() => runDaemonTick.mock.calls.length >= 2);
      expect(onShutdown).not.toHaveBeenCalled();
    } finally {
      await loop.shutdown();
    }
  });

  it("notifies automatic shutdown even when lease release fails", async () => {
    runDaemonTick.mockResolvedValue({ runs: 1, idleBlockers: 0 });
    let notify!: () => void;
    const notified = new Promise<void>(resolve => { notify = resolve; });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 5,
      idleStopMs: 1_000,
      packageVersion: "test",
      onShutdown: notify,
    });
    await waitUntil(() => runDaemonTick.mock.calls.length > 0);
    const db = new DatabaseSync(join(dir, ".acpus", ".local", "state", "runtime.db"));
    db.exec("DROP TABLE daemon_lease");
    db.close();

    await notified;

    await expect(loop.shutdown()).rejects.toThrow("no such table: daemon_lease");
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

async function waitUntilValue<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("value was not set");
}

function daemonHeartbeat(workspace: string): string | undefined {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT heartbeat_at FROM daemon_lease").get() as { heartbeat_at: string | null } | undefined;
    return row?.heartbeat_at ?? undefined;
  } finally {
    db.close();
  }
}
