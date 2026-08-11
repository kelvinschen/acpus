import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedAcpExecutor } from "@acpus/agent-executor";
import { daemonEndpoint } from "../src/daemon/client.js";
import type { DaemonHandlers } from "../src/daemon/server.js";
import { RunExecutionSessions } from "../src/daemon/sessions.js";
import type { DaemonTickResult } from "../src/daemon/tick.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";

const runDaemonTick = vi.fn<() => Promise<DaemonTickResult>>();
const startupCleanup = vi.hoisted(() => ({ failure: undefined as Error | undefined }));
const daemonServer = vi.hoisted(() => ({ handlers: undefined as DaemonHandlers | undefined }));
const cleanupTrace = vi.hoisted(() => ({
  calls: [] as string[],
  executorFailure: undefined as Error | undefined,
  releaseFailure: undefined as Error | undefined,
}));
const startupRecovery = vi.hoisted(() => ({
  claimed: false,
  claimedAtRecovery: false,
  calls: 0,
  openedGenerationIds: [] as string[],
  failure: undefined as Error | undefined,
}));

vi.mock("../src/daemon/tick.js", () => ({ runDaemonTick }));
vi.mock("../src/daemon/server.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/daemon/server.js")>();
  return {
    ...actual,
    startDaemonServer: async (...args: Parameters<typeof actual.startDaemonServer>) => {
      daemonServer.handlers = args[1];
      const server = await actual.startDaemonServer(...args);
      return {
        ...server,
        close: async () => {
          cleanupTrace.calls.push("server:close");
          await server.close();
        },
      };
    },
  };
});
vi.mock("@acpus/agent-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@acpus/agent-executor")>();
  return {
    ...actual,
    createManagedAcpExecutor: async (...args: Parameters<typeof actual.createManagedAcpExecutor>): Promise<ManagedAcpExecutor> => {
      const executor = await actual.createManagedAcpExecutor(...args);
      const shutdown = executor.shutdown.bind(executor);
      return {
        ...executor,
        shutdown: async () => {
          cleanupTrace.calls.push("executor:shutdown");
          await shutdown();
          if (cleanupTrace.executorFailure) throw cleanupTrace.executorFailure;
        },
      };
    },
  };
});
vi.mock("../src/store/store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/store/store.js")>();
  const instrument = (store: Awaited<ReturnType<typeof actual.openRuntimeStoreAtLayout>>) => {
    const claimDaemon = store.claimDaemon.bind(store);
    store.claimDaemon = input => {
      const lease = claimDaemon(input);
      startupRecovery.claimed = true;
      return lease;
    };
    const recover = store.observationLog.reconcileTerminalTurns.bind(store.observationLog);
    store.observationLog.reconcileTerminalTurns = async () => {
      startupRecovery.calls += 1;
      startupRecovery.claimedAtRecovery = startupRecovery.claimed;
      if (startupRecovery.failure !== undefined) throw startupRecovery.failure;
      await recover();
    };
    const cleanup = store.cleanupStagedRunDirectories.bind(store);
    store.cleanupStagedRunDirectories = () => startupCleanup.failure === undefined
      ? cleanup()
      : Promise.reject(startupCleanup.failure);
    const releaseDaemon = store.releaseDaemon.bind(store);
    store.releaseDaemon = input => {
      cleanupTrace.calls.push("store:release");
      const released = releaseDaemon(input);
      if (cleanupTrace.releaseFailure) throw cleanupTrace.releaseFailure;
      return released;
    };
    const close = store.close.bind(store);
    store.close = () => {
      cleanupTrace.calls.push("store:close");
      close();
    };
    return store;
  };
  return {
    ...actual,
    openRuntimeStoreAtLayout: async (...args: Parameters<typeof actual.openRuntimeStoreAtLayout>) => {
      if (args[0].generationId) startupRecovery.openedGenerationIds.push(args[0].generationId);
      return instrument(await actual.openRuntimeStoreAtLayout(...args));
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
  daemonServer.handlers = undefined;
  cleanupTrace.calls = [];
  cleanupTrace.executorFailure = undefined;
  cleanupTrace.releaseFailure = undefined;
  startupRecovery.claimed = false;
  startupRecovery.claimedAtRecovery = false;
  startupRecovery.calls = 0;
  startupRecovery.openedGenerationIds = [];
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
  it("initializes a fresh store and leaves an outdated store unchanged", async () => {
    const absent = await treeFingerprint(runtimeHome);
    runDaemonTick.mockResolvedValue({ runs: 0, idleBlockers: 0 });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      idleStopMs: 1_000,
      packageVersion: "test",
    });
    await loop.shutdown();
    expect(await treeFingerprint(runtimeHome)).not.toBe(absent);

    await convertReadyStoreToLegacyV8();
    const outdated = await treeFingerprint(runtimeHome);
    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toMatchObject({
      name: "DaemonRuntimeStoreReadinessError",
      failure: {
        type: "repair-required",
        command: "acpus doctor --fix",
      },
    });
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await treeFingerprint(runtimeHome)).toBe(outdated);
  });

  it("adopts one active generation when fresh daemon starts race", async () => {
    runDaemonTick.mockResolvedValue({ runs: 0, idleBlockers: 0 });

    const starts = await Promise.allSettled([
      startDaemonLoop(dir, { heartbeatMs: 50, idleStopMs: 1_000, packageVersion: "test" }),
      startDaemonLoop(dir, { heartbeatMs: 50, idleStopMs: 1_000, packageVersion: "test" }),
    ]);
    const loops = starts.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    try {
      expect(loops.length).toBeGreaterThan(0);
      const active = resolveRuntimeLayout(dir).generationId;
      expect(new Set(startupRecovery.openedGenerationIds)).toEqual(new Set([active]));
    } finally {
      await Promise.allSettled(loops.map(loop => loop.shutdown()));
    }
  });

  it("rejects invalid run leaf concurrency before creating runtime state", async () => {
    process.env.ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY = "0";

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "Environment variable ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY must be a canonical positive decimal safe integer",
    );
    await expect(access(join(runtimeHome, "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases its lease and closes the server when startup cleanup fails", async () => {
    await initializeReadyStore();
    startupCleanup.failure = new Error("startup cleanup failed");

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "startup cleanup failed",
    );

    const layout = resolveRuntimeLayout(dir);
    const db = new DatabaseSync(layout.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("attempts every startup cleanup stage and reports all failures", async () => {
    await initializeReadyStore();
    const startupFailure = new Error("startup cleanup failed");
    const executorFailure = new Error("executor shutdown failed");
    const releaseFailure = new Error("lease release failed");
    startupCleanup.failure = startupFailure;
    cleanupTrace.executorFailure = executorFailure;
    cleanupTrace.releaseFailure = releaseFailure;

    const rejected = await startDaemonLoop(dir, { packageVersion: "test" }).catch(error => error);

    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).errors).toEqual([
      startupFailure,
      executorFailure,
      releaseFailure,
    ]);
    expect(cleanupTrace.calls).toEqual([
      "server:close",
      "executor:shutdown",
      "store:release",
      "store:close",
    ]);
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers terminal observations only after claiming daemon ownership", async () => {
    await initializeReadyStore();
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
    await initializeReadyStore();
    startupRecovery.failure = new Error("startup observation recovery failed");

    await expect(startDaemonLoop(dir, { packageVersion: "test" })).rejects.toThrow(
      "startup observation recovery failed",
    );

    const layout = resolveRuntimeLayout(dir);
    const db = new DatabaseSync(layout.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues heartbeating while a work tick is still running", async () => {
    await initializeReadyStore();
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
    await initializeReadyStore();
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

  it("withdraws request authority as soon as protocol shutdown is accepted", async () => {
    await initializeReadyStore();
    runDaemonTick.mockResolvedValue({ runs: 0, idleBlockers: 0 });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      idleStopMs: 1_000,
      packageVersion: "test",
    });

    const handlers = daemonServer.handlers!;
    const accepted = handlers.shutdown();
    const admissionAfterAcceptance = handlers.admitRun({
      prepared: undefined as never,
      input: null,
    });
    const controlAfterAcceptance = handlers.control({
      requestId: "after-shutdown",
      type: "cancel",
      runId: "run_missing",
    });

    expect(accepted).not.toBeInstanceOf(ResultAsync);
    expect(admissionAfterAcceptance).not.toBeInstanceOf(ResultAsync);
    expect(controlAfterAcceptance).not.toBeInstanceOf(ResultAsync);
    expect((accepted as { isOk(): boolean }).isOk()).toBe(true);
    expect((admissionAfterAcceptance as { error: { code: string } }).error.code).toBe("EXECUTION_UNAVAILABLE");
    expect((controlAfterAcceptance as { error: { code: string } }).error.code).toBe("EXECUTION_UNAVAILABLE");
    await loop.shutdown();
  });

  it("continues normal shutdown cleanup after independent stage failures", async () => {
    await initializeReadyStore();
    runDaemonTick.mockResolvedValue({ runs: 0, idleBlockers: 0 });
    const stopFailure = new Error("session stop failed");
    const executorFailure = new Error("executor shutdown failed");
    const hooksFailure = new Error("hook drain failed");
    cleanupTrace.executorFailure = executorFailure;
    const stopExecutorsImplementation = RunExecutionSessions.prototype.stopExecutors;
    const drainHooksImplementation = RunExecutionSessions.prototype.drainHooks;
    const stopExecutors = vi.spyOn(RunExecutionSessions.prototype, "stopExecutors")
      .mockImplementation(async function(this: RunExecutionSessions, timeoutMs) {
        cleanupTrace.calls.push("sessions:stop");
        await stopExecutorsImplementation.call(this, timeoutMs);
        throw stopFailure;
      });
    const drainHooks = vi.spyOn(RunExecutionSessions.prototype, "drainHooks")
      .mockImplementation(async function(this: RunExecutionSessions) {
        cleanupTrace.calls.push("sessions:drain-hooks");
        await drainHooksImplementation.call(this);
        throw hooksFailure;
      });
    const loop = await startDaemonLoop(dir, {
      heartbeatMs: 50,
      idleStopMs: 1_000,
      packageVersion: "test",
    });
    cleanupTrace.calls = [];

    try {
      const rejected = await loop.shutdown().catch(error => error);
      expect(rejected).toBeInstanceOf(AggregateError);
      expect((rejected as AggregateError).errors).toEqual([stopFailure, executorFailure, hooksFailure]);
      expect(cleanupTrace.calls).toEqual([
        "server:close",
        "sessions:stop",
        "executor:shutdown",
        "sessions:drain-hooks",
        "store:release",
        "store:close",
      ]);
      await expect(access(daemonEndpoint(dir))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stopExecutors.mockRestore();
      drainHooks.mockRestore();
    }
  });

  it("retries transient store-busy tick failures", async () => {
    await initializeReadyStore();
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
    await initializeReadyStore();
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

async function initializeReadyStore(): Promise<void> {
  const store = await openRuntimeStore(dir);
  store.close();
}

async function convertReadyStoreToLegacyV8(): Promise<void> {
  const current = resolveRuntimeLayout(dir);
  const workspace = resolveRuntimeWorkspaceLayout(dir);
  const manifest = JSON.parse(await readFile(current.manifestPath, "utf8")) as Record<string, unknown>;
  await rm(current.generationMetadataPath);
  await rename(current.runtimeRoot, workspace.legacyRuntimeRoot);
  await rm(workspace.generationsRoot, { recursive: true, force: true });
  await writeFile(workspace.manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    workspaceKey: manifest.workspaceKey,
    canonicalPath: manifest.canonicalPath,
    platform: manifest.platform,
    createdAt: manifest.createdAt,
  }, null, 2)}\n`);
  const db = new DatabaseSync(workspace.databasePath);
  try {
    db.exec("PRAGMA user_version = 8");
  } finally {
    db.close();
  }
}

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
