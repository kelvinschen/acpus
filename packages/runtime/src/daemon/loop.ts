import { normalizeWorkflowInput } from "../admission/input.js";
import { ForkRequestConflictError, isRuntimeStoreBusyError, openRuntimeStore, PreparedRunWorkflowValidationError, validateAgentOverrides } from "../store/store.js";
import { formatHookLoadError, loadHooksConfig } from "../hooks/loader.js";
import { createHookRunner } from "../hooks/runner.js";
import { SchedulerControlInputError, schedulerStoreError } from "../scheduler/store-port.js";
import { ForkSeedPlanError } from "../scheduler/fork-seed.js";
import { RunExecutionSessions } from "./sessions.js";
import { RuntimeMutationQueue } from "./mutation-queue.js";
import { DaemonRequestError, startDaemonServer, type DaemonControlIntent, type DaemonErrorCode, type DaemonServerHandle } from "./socket.js";
import { runDaemonTick } from "./tick.js";

const EXECUTOR_SHUTDOWN_GRACE_MS = 10_000;

export type DaemonLoopOptions = {
  heartbeatMs?: number;
  packageVersion: string;
  idleStopMs?: number;
  onShutdown?: () => void;
};

export type DaemonLoopHandle = {
  shutdown(): Promise<void>;
};

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions): Promise<DaemonLoopHandle> {
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
  const sessions = new RunExecutionSessions(cwd, store, hookRunner);
  const mutations = new RuntimeMutationQueue();
  let server: DaemonServerHandle;
  try {
    server = await startDaemonServer(cwd, {
      status: () => {
        const generation = requireLeaseGeneration();
        return {
          status: "ok",
          pid: process.pid,
          generation,
          protocolVersion: 1,
          packageVersion: options.packageVersion,
        };
      },
      admitRun: request => mutations.enqueue(async () => {
        requireLeaseGeneration();
        let input;
        let agentOverrides;
        try {
          input = normalizeWorkflowInput(request.prepared.ir, request.input);
          agentOverrides = validateAgentOverrides(request.prepared.ir, request.agentOverrides);
        } catch (error) {
          throw new DaemonRequestError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
        }
        try {
          const run = await store.admitRun({ prepared: request.prepared, cwd, input, agentOverrides });
          return sessions.start(run.id);
        } catch (error) {
          const code = daemonAdmissionCode(error);
          throw new DaemonRequestError(code, daemonAdmissionMessage(code, error));
        }
      }),
      control: intent => mutations.enqueue(async () => {
        requireLeaseGeneration();
        try {
          const result = await sessions.control(intent);
          if (!result) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
          if (intent.type === "resume" || intent.type === "retry" || intent.type === "signal") sessions.start(intent.runId);
          return result;
        } catch (error) {
          const code = daemonControlCode(error);
          throw new DaemonRequestError(code, daemonControlMessage(intent, code, error));
        }
      }),
      shutdown: () => {
        requireLeaseGeneration();
        if (server.activeConnections() > 1) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active client requests.");
        if (!mutations.isIdle()) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active runtime mutations.");
        if (sessions.activeCount() > 0) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active run sessions.");
        setImmediate(() => {
          requestShutdown("external");
        });
        return { status: "shutdown" };
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
      protocolVersion: 1,
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
  leaseGeneration = lease.generation;

  function requireLeaseGeneration(): number {
    if (leaseGeneration === undefined) throw new DaemonRequestError("EXECUTION_UNAVAILABLE", "Daemon is still initializing.");
    return leaseGeneration;
  }

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
        await sessions.stopExecutors(EXECUTOR_SHUTDOWN_GRACE_MS);
        await sessions.drainHooks();
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
      const result = await runDaemonTick(store, { startSession: runId => sessions.start(runId) });
      if (stopped) return;
      if (result.runs > 0 || result.idleBlockers > 0 || sessions.activeCount() > 0 || sessions.hookActiveCount() > 0 || server.activeConnections() > 0) {
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

function daemonControlCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (error instanceof PreparedRunWorkflowValidationError) return "INVALID_REQUEST";
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  const storeError = schedulerStoreError(error);
  if (storeError?.type === "run-not-found") return "RUN_NOT_FOUND";
  if (storeError?.type === "idempotency-conflict") return "CONTROL_CONFLICT";
  if (error instanceof ForkRequestConflictError) return "CONTROL_CONFLICT";
  return "RUN_NOT_CONTROLLABLE";
}

function daemonControlMessage(intent: DaemonControlIntent, code: DaemonErrorCode, error: unknown): string {
  if (error instanceof DaemonRequestError
    || error instanceof PreparedRunWorkflowValidationError
    || error instanceof SchedulerControlInputError
    || error instanceof ForkSeedPlanError
    || error instanceof ForkRequestConflictError) return error.message;
  const storeError = schedulerStoreError(error);
  if (storeError?.type === "run-not-found") return `Run '${intent.runId}' was not found.`;
  if (storeError?.type === "missing-retry-target"
    || storeError?.type === "invalid-retry-target"
    || storeError?.type === "missing-cancel-target"
    || storeError?.type === "invalid-cancel-target"
    || storeError?.type === "signal-wait-not-found"
    || storeError?.type === "signal-wait-terminal") return storeError.message;
  if (storeError?.type === "idempotency-conflict") return `Control request '${intent.requestId}' conflicts with a different request.`;
  if (storeError?.type === "run-paused") return `Run '${intent.runId}' is paused.`;
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  if (code === "CONTROL_CONFLICT") return `Control '${intent.type}' for run '${intent.runId}' conflicts with another request.`;
  if (code === "RUN_NOT_FOUND") return `Run '${intent.runId}' was not found.`;
  return `Control '${intent.type}' could not be applied to run '${intent.runId}'.`;
}

function daemonAdmissionCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (error instanceof PreparedRunWorkflowValidationError) return "INVALID_REQUEST";
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  return "STORE_ERROR";
}

function daemonAdmissionMessage(code: DaemonErrorCode, error: unknown): string {
  if (error instanceof DaemonRequestError || error instanceof PreparedRunWorkflowValidationError) return error.message;
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  return "Run admission could not be persisted.";
}
