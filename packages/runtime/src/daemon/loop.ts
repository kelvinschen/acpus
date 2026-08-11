import {
  openRuntimeStoreAtLayout,
  type RuntimeStore,
} from "../store/store.js";
import { isRuntimeStoreBusyError } from "../storage/database.js";
import { formatHookLoadError, loadHooksConfig } from "../hooks/loader.js";
import { createHookRunner } from "../hooks/runner.js";
import { tryLoadRuntimeConfiguration } from "../configuration.js";
import { RunExecutionSessions, type RunIncident, type RunSessionControlFailure } from "./sessions.js";
import { RuntimeMutationQueue } from "./mutation-queue.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonControlIntent, type DaemonErrorCode, type DaemonHandlerFailure } from "./protocol.js";
import { startDaemonServer, type DaemonServerHandle } from "./server.js";
import { runDaemonTick } from "./tick.js";
import { err, ok, ResultAsync } from "neverthrow";
import { createManagedAcpExecutor, recoverAcpOwnership, type ManagedAcpExecutor } from "@acpus/agent-executor";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runAcpStateRoot,
  runtimeLayoutForGeneration,
} from "../runtime-layout.js";
import {
  initializeRuntimeStoreIfAbsent,
  inspectRuntimeStoreInternal,
  type RuntimeStoreAssessment,
} from "../runtime-store-lifecycle.js";
import { acquireRuntimeSharedLock } from "../runtime-lock.js";

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

type DaemonRuntimeStoreReadinessFailure =
  | { type: "repair-required"; command: "acpus doctor --fix"; message: string }
  | { type: "unsupported" | "failed"; message: string };

class DaemonRuntimeStoreReadinessError extends Error {
  constructor(readonly failure: DaemonRuntimeStoreReadinessFailure) {
    super(failure.message);
    this.name = "DaemonRuntimeStoreReadinessError";
  }
}

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions): Promise<DaemonLoopHandle> {
  const runtimeConfiguration = tryLoadRuntimeConfiguration(process.env);
  if (runtimeConfiguration.isErr()) throw new Error(runtimeConfiguration.error.message);
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const idleStopMs = options.idleStopMs ?? 30_000;
  let readyRuntime: {
    store: RuntimeStore;
    sessions: RunExecutionSessions;
    leaseGeneration: number;
  } | undefined;
  const mutations = new RuntimeMutationQueue();
  let server: DaemonServerHandle;
  server = await startDaemonServer(cwd, {
    status: () => {
      const runtime = readyRuntime;
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return ok({
        status: "ok",
        pid: process.pid,
        generation: runtime.leaseGeneration,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        packageVersion: options.packageVersion,
      });
    },
    admitRun: request => {
      const runtime = readyRuntime;
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return new ResultAsync(mutations.enqueue(async () => {
        try {
          const admitted = await runtime.store.admitRun({
            prepared: request.prepared,
            cwd,
            input: request.input,
            ...(request.agentOverrides === undefined ? {} : { agentOverrides: request.agentOverrides }),
          });
          if (admitted.isErr()) return err(handlerFailure("INVALID_REQUEST", admitted.error.message));
          return ok(runtime.sessions.start(admitted.value.id).run);
        } catch (error) {
          if (isRuntimeStoreBusyError(error)) return err(handlerFailure("STORE_BUSY", "Runtime store is busy. Retry the request."));
          throw error;
        }
      }));
    },
    control: intent => {
      const runtime = readyRuntime;
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return new ResultAsync(mutations.enqueue(async () => {
        if (!runtime.store.getRun(intent.runId)) return err(handlerFailure("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`));
        try {
          const result = await runtime.sessions.control(intent);
          if (result.isErr()) return err(daemonControlFailure(intent, result.error));
          return ok(result.value);
        } catch (error) {
          if (isRuntimeStoreBusyError(error)) return err(handlerFailure("STORE_BUSY", "Runtime store is busy. Retry the request."));
          throw error;
        }
      }));
    },
    shutdown: () => {
      const runtime = readyRuntime;
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      if (server.activeConnections() > 1) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active client requests."));
      if (!mutations.isIdle()) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active runtime mutations."));
      if (runtime.sessions.activeCount() > 0) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active run sessions."));
      readyRuntime = undefined;
      setImmediate(() => {
        requestShutdown("external");
      });
      return ok({ status: "shutdown" as const });
    },
  });

  const initialized = await (async (): Promise<{
    store: RuntimeStore;
    lease: ReturnType<RuntimeStore["claimDaemon"]>;
    sessions: RunExecutionSessions;
    managedAcpExecutor: ManagedAcpExecutor;
  }> => {
    let store: RuntimeStore | undefined;
    let lease: ReturnType<RuntimeStore["claimDaemon"]> | undefined;
    let managedAcpExecutor: ManagedAcpExecutor | undefined;
    try {
      store = await openReadyDaemonRuntimeStore(cwd);
      const hooksConfig = await loadHooksConfig(cwd);
      if (hooksConfig.isErr()) throw new Error(formatHookLoadError(hooksConfig.error));
      const hookRunner = createHookRunner(hooksConfig.value, store);
      lease = store.claimDaemon({
        workspaceRealpath: cwd,
        pid: process.pid,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        packageVersion: options.packageVersion,
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs,
      });
      const layout = resolveRuntimeLayout(cwd);
      const executorOptions = {
        workersRoot: layout.acpWorkersRoot,
        sessionStateDirectoryForRun: (runId: string) => runAcpStateRoot(layout, runId),
        daemon: { generation: lease.generation, pid: process.pid },
      };
      await recoverAcpOwnership(executorOptions);
      managedAcpExecutor = await createManagedAcpExecutor(executorOptions);
      const sessions = new RunExecutionSessions(cwd, store, hookRunner, runtimeConfiguration.value, options.onRunIncident, managedAcpExecutor);
      await store.observationLog.reconcileTerminalTurns();
      await store.cleanupStagedRunDirectories();
      return { store, lease, sessions, managedAcpExecutor };
    } catch (error) {
      await settleDaemonResources(
        "Daemon startup failed and its resources could not be fully released.",
        [error],
        [
          () => server.close(),
          () => managedAcpExecutor?.shutdown(),
          () => {
            if (store && lease) store.releaseDaemon({ workspaceRealpath: cwd, generation: lease.generation });
          },
          () => store?.close(),
        ],
      );
      throw error;
    }
  })();
  const { store, lease, sessions, managedAcpExecutor } = initialized;
  readyRuntime = { store, sessions, leaseGeneration: lease.generation };

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
    readyRuntime = undefined;
    clearInterval(heartbeatTimer);
    clearInterval(tickTimer);
    shutdownPromise = (async () => {
      await settleDaemonResources(
        "Daemon shutdown failed and its resources could not be fully released.",
        [],
        [
          async () => {
            if (source !== "tick") await activeTick;
          },
          async () => {
            if (source !== "heartbeat") await activeHeartbeat;
          },
          () => server.close(),
          () => mutations.drain(),
          () => sessions.stopExecutors(EXECUTOR_SHUTDOWN_GRACE_MS),
          () => managedAcpExecutor.shutdown(),
          () => sessions.drainHooks(),
          () => store.releaseDaemon({
            workspaceRealpath: cwd,
            generation: lease.generation,
          }),
          () => store.close(),
        ],
      );
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

async function openReadyDaemonRuntimeStore(cwd: string): Promise<RuntimeStore> {
  const first = await inspectRuntimeStoreInternal(cwd);
  if (first.isErr()) throw readinessError(first.error);
  if (first.value.current.state === "absent") await initializeRuntimeStoreIfAbsent(cwd);
  else if (first.value.current.state !== "ready") throw assessmentReadinessError(first.value);

  const workspace = resolveRuntimeWorkspaceLayout(cwd);
  let lock;
  try {
    lock = await acquireRuntimeSharedLock(workspace);
  } catch (error) {
    throw readinessError(error);
  }

  let adopted = false;
  try {
    const checked = await inspectRuntimeStoreInternal(cwd);
    if (checked.isErr()) throw readinessError(checked.error);
    if (checked.value.current.state !== "ready") throw assessmentReadinessError(checked.value);
    const layout = runtimeLayoutForGeneration(workspace, checked.value.current.generationId);
    adopted = true;
    return await openRuntimeStoreAtLayout(layout, {
      lock,
      prevalidated: true,
    });
  } catch (error) {
    if (!adopted) lock.release();
    if (error instanceof DaemonRuntimeStoreReadinessError) throw error;
    throw readinessError(error);
  }
}

function assessmentReadinessError(source: RuntimeStoreAssessment): DaemonRuntimeStoreReadinessError {
  if (source.current.state === "unsupported") {
    return new DaemonRuntimeStoreReadinessError({
      type: "unsupported",
      message: source.current.detail,
    });
  }
  return new DaemonRuntimeStoreReadinessError({
    type: "repair-required",
    command: "acpus doctor --fix",
    message: "Runtime store repair is required before daemon startup. Run 'acpus doctor --fix'.",
  });
}

function readinessError(source: { type: "inspect-failed"; message: string } | unknown): DaemonRuntimeStoreReadinessError {
  const message = isInspectFailure(source)
    ? source.message
    : source instanceof Error ? source.message : String(source);
  return new DaemonRuntimeStoreReadinessError({
    type: "failed",
    message: `Runtime store readiness could not be established: ${message}`,
  });
}

function isInspectFailure(value: unknown): value is { type: "inspect-failed"; message: string } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && (value as { type?: unknown }).type === "inspect-failed"
    && "message" in value
    && typeof (value as { message?: unknown }).message === "string";
}

async function settleDaemonResources(
  message: string,
  failures: unknown[],
  steps: Array<() => void | Promise<void> | undefined>,
): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
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
