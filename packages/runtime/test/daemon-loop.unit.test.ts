import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonEndpoint } from "../src/daemon/socket.js";
import type { DaemonTickResult } from "../src/daemon/tick.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";

const runDaemonTick = vi.fn<() => Promise<DaemonTickResult>>();
const startupCleanup = vi.hoisted(() => ({ failure: undefined as Error | undefined }));
const startupRecovery = vi.hoisted(() => ({
  claimed: false,
  claimedAtRecovery: false,
  calls: 0,
  failure: undefined as Error | undefined,
}));

vi.mock("../src/daemon/tick.js", () => ({ runDaemonTick }));
vi.mock("../src/store/store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/store/store.js")>();
  return {
    ...actual,
    openRuntimeStore: async (cwd: string) => {
      const store = await actual.openRuntimeStore(cwd);
      const claimDaemon = store.claimDaemon.bind(store);
      store.claimDaemon = input => {
        const lease = claimDaemon(input);
        startupRecovery.claimed = true;
        return lease;
      };
      const recover = store.observationLog.recoverTerminalPartialTurns.bind(store.observationLog);
      store.observationLog.recoverTerminalPartialTurns = async () => {
        startupRecovery.calls += 1;
        startupRecovery.claimedAtRecovery = startupRecovery.claimed;
        if (startupRecovery.failure !== undefined) throw startupRecovery.failure;
        await recover();
      };
      const cleanup = store.cleanupStagedRunDirectories.bind(store);
      store.cleanupStagedRunDirectories = () => startupCleanup.failure === undefined
        ? cleanup()
        : Promise.reject(startupCleanup.failure);
      return store;
    },
  };
});

const { startDaemonLoop } = await import("../src/daemon/loop.js");

let dir: string;
let runtimeHome: string;
let restoreRuntimeHome: () => void;
const runMaxLeafConcurrency = process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY;

beforeEach(async () => {
  delete process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY;
  [dir, runtimeHome] = await Promise.all([
    mkdtemp(join(tmpdir(), "acpus-daemon-loop-")),
    mkdtemp(join(tmpdir(), "ah-")),
  ]);
  restoreRuntimeHome = setRuntimeHomeForTest(dir, runtimeHome);
  startupCleanup.failure = undefined;
  startupRecovery.claimed = false;
  startupRecovery.claimedAtRecovery = false;
  startupRecovery.calls = 0;
  startupRecovery.failure = undefined;
  runDaemonTick.mockReset();
});

afterEach(async () => {
  if (runMaxLeafConcurrency === undefined) delete process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY;
  else process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY = runMaxLeafConcurrency;
  restoreRuntimeHome();
  await Promise.all([
    rm(dir, { recursive: true, force: true }),
    rm(runtimeHome, { recursive: true, force: true }),
  ]);
});

describe("daemon loop", () => {
  it("rejects invalid run leaf concurrency before creating runtime state", async () => {
    process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY = "0";

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "Environment variable ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY must be a canonical positive decimal safe integer",
    );
    await expect(access(join(runtimeHome, "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases its lease and closes the server when startup cleanup fails", async () => {
    const layout = resolveRuntimeLayout(dir);
    startupCleanup.failure = new Error("startup cleanup failed");

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "startup cleanup failed",
    );

    const db = new DatabaseSync(layout.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers terminal observations only after claiming daemon ownership", async () => {
    runDaemonTick.mockResolvedValue({ runs: 0, idleBlockers: 0 });

    const loop = await startDaemonLoop(dir, {
      idleStopMs: 1_000,
      packageVersion: "test",
    });
    try {
      expect(startupRecovery).toMatchObject({
        calls: 1,
        claimedAtRecovery: true,
      });
    } finally {
      await loop.shutdown();
    }
  });

  it("releases its lease and closes the server when terminal observation recovery fails", async () => {
    const layout = resolveRuntimeLayout(dir);
    startupRecovery.failure = new Error("startup observation recovery failed");

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "startup observation recovery failed",
    );

    const db = new DatabaseSync(layout.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

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
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath);
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
  const db = new DatabaseSync(resolveRuntimeLayout(workspace).databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT heartbeat_at FROM daemon_lease").get() as { heartbeat_at: string | null } | undefined;
    return row?.heartbeat_at ?? undefined;
  } finally {
    db.close();
  }
}
