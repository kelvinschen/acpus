import { isRuntimeStoreBusyError, openRuntimeStore } from "../store/store.js";
import { formatHookLoadError, loadHooksConfig } from "../hooks/loader.js";
import { createHookRunner } from "../hooks/runner.js";
import { tryLoadRuntimeConfiguration } from "../configuration.js";
import { RunExecutionSessions, type RunIncident, type RunSessionControlFailure } from "./sessions.js";
import { RuntimeMutationQueue } from "./mutation-queue.js";
import { DAEMON_PROTOCOL_VERSION, startDaemonServer, type DaemonControlIntent, type DaemonErrorCode, type DaemonHandlerFailure, type DaemonServerHandle } from "./socket.js";
import { runDaemonTick } from "./tick.js";
import { err, ok, ResultAsync } from "neverthrow";
import { createManagedAcpExecutor, recoverAcpOwnership, type ManagedAcpExecutor } from "@acpus/agent-executor";
import { resolveRuntimeLayout, runAcpStateRoot } from "../runtime-layout.js";

const EXECUTOR_SHUTDOWN_GRACE_MS = 10_000;

export type DaemonLoopOptions = {
  heartbeatMs?: number;
  packageVersion: string;
  idleStopMs?: number;
  onShutdown?: () => void;
  onRunIncident?: (incident: RunIncident) => void;
};

export type DaemonLoopHandle = {
  shutdown(): Promise<void>;
};

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions): Promise<DaemonLoopHandle> {
  const runtimeConfiguration = tryLoadRuntimeConfiguration(process.env);
  if (runtimeConfiguration.isErr()) throw new Error(runtimeConfiguration.error.message);
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const idleStopMs = options.idleStopMs ?? 30_000;
  let leaseGeneration: number | undefined;
  const store = await openRuntimeStore(cwd);
  const hooksConfig = await loadHooksConfig(cwd);
  if (hooksConfig.isErr()) {
    store.close();
    throw new Error(formatHookLoadError(hooksConfig.error));
  }
  const hookRunner = createHookRunner(hooksConfig.value, store);
  let sessions: RunExecutionSessions | undefined;
  let managedAcpExecutor: ManagedAcpExecutor | undefined;
  const mutations = new RuntimeMutationQueue();
  let server: DaemonServerHandle;
  try {
    server = await startDaemonServer(cwd, {
      status: () => {
        if (leaseGeneration === undefined) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
        return ok({
          status: "ok",
          pid: process.pid,
          generation: leaseGeneration,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          packageVersion: options.packageVersion,
        });
      },
      admitRun: request => new ResultAsync(mutations.enqueue(async () => {
        if (leaseGeneration === undefined) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
        try {
          const admitted = await store.admitRun({
            prepared: request.prepared,
            cwd,
            input: request.input,
            ...(request.agentOverrides === undefined ? {} : { agentOverrides: request.agentOverrides }),
          });
          if (admitted.isErr()) return err(handlerFailure("INVALID_REQUEST", admitted.error.message));
          return ok(sessions!.start(admitted.value.id).run);
        } catch (error) {
          if (isRuntimeStoreBusyError(error)) return err(handlerFailure("STORE_BUSY", "Runtime store is busy. Retry the request."));
          throw error;
        }
      })),
      control: intent => new ResultAsync(mutations.enqueue(async () => {
        if (leaseGeneration === undefined) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
        if (!store.getRun(intent.runId)) return err(handlerFailure("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`));
        try {
          const result = await sessions!.control(intent);
          if (result.isErr()) return err(daemonControlFailure(intent, result.error));
          return ok(result.value);
        } catch (error) {
          if (isRuntimeStoreBusyError(error)) return err(handlerFailure("STORE_BUSY", "Runtime store is busy. Retry the request."));
          throw error;
        }
      })),
      shutdown: () => {
        if (leaseGeneration === undefined) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
        if (server.activeConnections() > 1) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active client requests."));
        if (!mutations.isIdle()) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active runtime mutations."));
        if ((sessions?.activeCount() ?? 0) > 0) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active run sessions."));
        setImmediate(() => {
          requestShutdown("external");
        });
        return ok({ status: "shutdown" as const });
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let lease: ReturnType<typeof store.claimDaemon>;
  try {
    lease = store.claimDaemon({
      workspaceRealpath: cwd,
      pid: process.pid,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      packageVersion: options.packageVersion,
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs,
    });
  } catch (error) {
    await closeDaemonServer(server);
    store.close();
    throw error;
  }
  try {
    const layout = resolveRuntimeLayout(cwd);
    const executorOptions = {
      workersRoot: layout.acpWorkersRoot,
      sessionStateDirectoryForRun: (runId: string) => runAcpStateRoot(layout, runId),
      daemon: { generation: lease.generation, pid: process.pid },
    };
    await recoverAcpOwnership(executorOptions);
    managedAcpExecutor = await createManagedAcpExecutor(executorOptions);
    sessions = new RunExecutionSessions(cwd, store, hookRunner, runtimeConfiguration.value, options.onRunIncident, managedAcpExecutor);
    await store.observationLog.reconcileTerminalTurns();
    await store.cleanupStagedRunDirectories();
  } catch (error) {
    await closeDaemonServer(server);
    try {
      await managedAcpExecutor?.shutdown();
      store.releaseDaemon({
        workspaceRealpath: cwd,
        generation: lease.generation,
      });
    } finally {
      store.close();
    }
    throw error;
  }
  leaseGeneration = lease.generation;

  let ticking = false;
  let heartbeating = false;
  let activeTick: Promise<void> | undefined;
  let activeHeartbeat: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let stopped = false;
  let idleSince: number | undefined;
  const heartbeatTimer = setInterval(() => {
    activeHeartbeat = heartbeat();
  }, heartbeatMs);
  const tickTimer = setInterval(() => {
    startTick();
  }, heartbeatMs);

  function startTick(): void {
    if (ticking || stopped) return;
    activeTick = tick();
  }

  async function shutdown(source: "external" | "tick" | "heartbeat" = "external"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(tickTimer);
    shutdownPromise = (async () => {
      try {
        if (source !== "tick") await activeTick;
        if (source !== "heartbeat") await activeHeartbeat;
        await closeDaemonServer(server);
        await sessions?.stopExecutors(EXECUTOR_SHUTDOWN_GRACE_MS);
        await managedAcpExecutor?.shutdown();
        await sessions?.drainHooks();
      } finally {
        try {
          store.releaseDaemon({
            workspaceRealpath: cwd,
            generation: lease.generation,
          });
        } finally {
          store.close();
        }
      }
    })();
    return shutdownPromise;
  }

  function requestShutdown(source: "external" | "tick" | "heartbeat"): void {
    const notify = () => {
      try {
        options.onShutdown?.();
      } catch {}
    };
    void shutdown(source).then(notify, notify);
  }

  async function heartbeat(): Promise<void> {
    if (heartbeating || stopped) return;
    heartbeating = true;
    try {
      if (!store.heartbeatDaemon({ workspaceRealpath: cwd, generation: lease.generation })) {
        requestShutdown("heartbeat");
      }
    } catch (error) {
      if (!stopped && !isRuntimeStoreBusyError(error)) {
        requestShutdown("heartbeat");
      }
    } finally {
      heartbeating = false;
    }
  }

  async function tick(): Promise<void> {
    ticking = true;
    try {
      const result = await runDaemonTick(store, {
        startSession: runId => sessions!.start(runId).disposition,
        dispatchHooks: runId => sessions!.dispatchHooks(runId),
      });
      if (stopped) return;
      if (result.runs > 0 || result.idleBlockers > 0 || sessions!.activeCount() > 0 || sessions!.hookActiveCount() > 0 || server.activeConnections() > 0) {
        idleSince = undefined;
        store.setDaemonIdleState({ workspaceRealpath: cwd, generation: lease.generation, idleStopMs });
        return;
      }
      idleSince ??= Date.now();
      store.setDaemonIdleState({
        workspaceRealpath: cwd,
        generation: lease.generation,
        idleSinceAt: new Date(idleSince).toISOString(),
        idleStopMs,
      });
      if (Date.now() - idleSince >= idleStopMs) {
        requestShutdown("tick");
      }
    } catch (error) {
      if (!stopped && !isRuntimeStoreBusyError(error)) {
        requestShutdown("tick");
      }
    } finally {
      ticking = false;
    }
  }

  startTick();
  return { shutdown };
}

async function closeDaemonServer(server: DaemonServerHandle): Promise<void> {
  try {
    await server.close();
  } catch {
    // Shutdown should still release the daemon lease and close the store.
  }
}

function daemonControlFailure(intent: DaemonControlIntent, failure: RunSessionControlFailure): DaemonHandlerFailure {
  const code: DaemonErrorCode = failure.type === "run-not-found"
    ? "RUN_NOT_FOUND"
    : failure.type === "prepared-workflow-invalid"
      || failure.type === "schema-mismatch"
      || failure.type === "agent-overrides-invalid"
      || failure.type === "invalid-steer-instruction"
      ? "INVALID_REQUEST"
    : failure.type === "idempotency-conflict"
      || failure.type === "fork-request-conflict"
      || failure.type === "ambiguous-steer-target"
      || failure.type === "steer-session-conflict"
      ? "CONTROL_CONFLICT"
      : "RUN_NOT_CONTROLLABLE";
  const message = failure.type === "idempotency-conflict"
    ? `Control request '${intent.requestId}' conflicts with a different request.`
    : failure.type === "version-mismatch"
      || failure.type === "owner-epoch-inactive"
      || failure.type === "owner-epoch-still-active"
      || failure.type === "owner-epoch-stale"
      || failure.type === "instance-not-ready"
      || failure.type === "terminal-attempt"
      || failure.type === "attempt-not-found"
      ? `Control '${intent.type}' could not be applied to run '${intent.runId}'.`
      : failure.message;
  return handlerFailure(code, message, controlTargetAmbiguity(failure));
}

function controlTargetAmbiguity(failure: RunSessionControlFailure): true | undefined {
  return failure.type === "ambiguous-retry-target"
    || failure.type === "ambiguous-cancel-target"
    || failure.type === "ambiguous-steer-target"
    || failure.type === "signal-target-ambiguous"
    || failure.type === "dynamic-target-ambiguity"
    ? true
    : undefined;
}

function handlerFailure(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonHandlerFailure {
  return { code, message, ...(ambiguity ? { ambiguity } : {}) };
}
