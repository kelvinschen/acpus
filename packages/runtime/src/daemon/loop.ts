import { createHash } from "node:crypto";
import { normalizeWorkflowInput } from "../admission/input.js";
import { isRuntimeStoreBusyError, openRuntimeStore, validateAgentOverrides } from "../store/store.js";
import { formatHookLoadError, loadHooksConfig } from "../hooks/loader.js";
import { createHookRunner } from "../hooks/runner.js";
import { RuntimeUseCaseException } from "../runs/use-cases.js";
import { RunExecutionSessions } from "./sessions.js";
import { RuntimeMutationQueue } from "./mutation-queue.js";
import { DaemonRequestError, startDaemonServer, type DaemonErrorCode, type DaemonServerHandle } from "./socket.js";
import { runDaemonTick } from "./tick.js";

export type DaemonLoopOptions = {
  heartbeatMs?: number;
  workspaceRealpath?: string;
  pid?: number;
  protocolVersion?: number;
  packageVersion: string;
  nodeVersion?: string;
  execPath?: string;
  idleStopMs?: number;
  onShutdown?: () => void;
};

export type DaemonLoopHandle = {
  shutdown(): Promise<void>;
};

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions): Promise<DaemonLoopHandle> {
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const idleStopMs = options.idleStopMs ?? 30_000;
  const workspaceRealpath = options.workspaceRealpath ?? cwd;
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
      status: () => ({
        status: "ok",
        pid: options.pid ?? process.pid,
        ...(leaseGeneration === undefined ? {} : { generation: leaseGeneration }),
        protocolVersion: options.protocolVersion ?? 1,
        packageVersion: options.packageVersion,
      }),
      admitRun: request => mutations.enqueue("admitRun", async () => {
        let input;
        let agentOverrides;
        let prepared;
        try {
          prepared = canonicalPreparedRunWorkflow(request.prepared);
          input = normalizeWorkflowInput(prepared.ir, request.input);
          agentOverrides = validateAgentOverrides(prepared.ir, request.agentOverrides);
        } catch (error) {
          throw new DaemonRequestError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
        }
        try {
          const run = await store.admitRun({ prepared, cwd, input, agentOverrides });
          const details = store.getRun(run.id);
          if (!details) throw new DaemonRequestError("STORE_ERROR", `Admitted run ${run.id} was not persisted.`);
          if (request.start) sessions.start(run.id);
          return details;
        } catch (error) {
          throw new DaemonRequestError(daemonAdmissionCode(error), error instanceof Error ? error.message : String(error));
        }
      }),
      control: intent => mutations.enqueue(`control:${intent.type}`, async () => {
        try {
          const result = await sessions.control(intent);
          if (!result) throw new DaemonRequestError("RUN_NOT_FOUND", `Run '${intent.runId}' was not found.`);
          if (intent.type === "resume" || intent.type === "retry" || intent.type === "signal") sessions.start(intent.runId);
          return result;
        } catch (error) {
          throw new DaemonRequestError(daemonControlCode(error), error instanceof Error ? error.message : String(error));
        }
      }),
      startRun: runId => sessions.start(runId),
      observeRun: runId => sessions.observe(runId),
      shutdown: () => {
        if (server.activeConnections() > 1) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active client requests.");
        if (!mutations.isIdle()) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active runtime mutations.");
        if (sessions.activeCount() > 0) throw new DaemonRequestError("CONTROL_CONFLICT", "Daemon has active run sessions.");
        setImmediate(() => {
          void shutdown("external").then(() => options.onShutdown?.());
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
      workspaceRealpath,
      pid: options.pid ?? process.pid,
      protocolVersion: options.protocolVersion ?? 1,
      packageVersion: options.packageVersion,
      nodeVersion: options.nodeVersion ?? process.version,
      execPath: options.execPath ?? process.execPath,
      idleStopMs,
    });
  } catch (error) {
    await closeDaemonServer(server);
    store.close();
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
    activeTick = tick();
  }, heartbeatMs);

  async function shutdown(source: "external" | "tick" | "heartbeat" = "external"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(tickTimer);
    shutdownPromise = (async () => {
      if (source !== "tick") await activeTick;
      if (source !== "heartbeat") await activeHeartbeat;
      await closeDaemonServer(server);
      await sessions.drainHooks();
      store.releaseDaemon({
        workspaceRealpath,
        generation: lease.generation,
      });
      store.close();
    })();
    return shutdownPromise;
  }

  async function heartbeat(): Promise<void> {
    if (heartbeating || stopped) return;
    heartbeating = true;
    try {
      if (!store.heartbeatDaemon({ workspaceRealpath, generation: lease.generation })) {
        void shutdown("heartbeat").then(() => options.onShutdown?.());
      }
    } catch {
      // Keep the daemon process alive; the next heartbeat can recover if the store is usable.
    } finally {
      heartbeating = false;
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const result = await runDaemonTick(store, { startRun: runId => sessions.start(runId) });
      if (stopped) return;
      if (result.runs > 0 || result.idleBlockers > 0 || sessions.activeCount() > 0 || sessions.hookActiveCount() > 0 || server.activeConnections() > 0) {
        idleSince = undefined;
        store.setDaemonIdleState({ workspaceRealpath, generation: lease.generation, idleStopMs });
        return;
      }
      idleSince ??= Date.now();
      store.setDaemonIdleState({
        workspaceRealpath,
        generation: lease.generation,
        idleSinceAt: new Date(idleSince).toISOString(),
        idleStopMs,
      });
      if (Date.now() - idleSince >= idleStopMs) {
        void shutdown("tick").then(() => options.onShutdown?.());
      }
    } catch {
      // Keep the daemon process alive; a later tick can retry runnable runs.
    } finally {
      ticking = false;
    }
  }

  activeTick = tick();
  return { shutdown };
}

async function closeDaemonServer(server: DaemonServerHandle): Promise<void> {
  try {
    await server.close();
  } catch {
    // Shutdown should still release the daemon lease and close the store.
  }
}

function canonicalPreparedRunWorkflow<T extends { ir: unknown; irJson: string; lock: { ir: { digest: string } } }>(prepared: T): T {
  const irFromJson = JSON.parse(prepared.irJson) as unknown;
  if (canonicalJson(irFromJson) !== canonicalJson(prepared.ir)) throw new Error("Prepared workflow IR JSON does not match prepared IR.");
  if (sha256(prepared.irJson) !== prepared.lock.ir.digest) throw new Error("Prepared workflow lock IR digest does not match IR JSON.");
  return { ...prepared, ir: irFromJson } as T;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}

function daemonControlCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  if (isDaemonErrorCode((error as { code?: unknown })?.code)) return (error as { code: DaemonErrorCode }).code;
  const failure = typeof error === "object" && error !== null && "failure" in error
    ? (error as { failure?: { type?: string } }).failure
    : undefined;
  if (failure?.type === "run-not-found" || failure?.type === "runtime-store-not-found") return "RUN_NOT_FOUND";
  if (failure?.type === "scheduler-store-failed") return "STORE_ERROR";
  if (failure?.type === "run-control-failed" && error instanceof Error && (error.message.includes("currently controlled by another owner") || error.message.includes("conflicts with a different fork input"))) return "CONTROL_CONFLICT";
  if (error instanceof Error && error.message.includes("conflicts with a different fork input")) return "CONTROL_CONFLICT";
  return "RUN_NOT_CONTROLLABLE";
}

function daemonAdmissionCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  if (isDaemonErrorCode((error as { code?: unknown })?.code)) return (error as { code: DaemonErrorCode }).code;
  return "STORE_ERROR";
}

function isDaemonErrorCode(value: unknown): value is DaemonErrorCode {
  return typeof value === "string" && ["INVALID_REQUEST", "INVALID_CONTROL", "RUN_NOT_FOUND", "RUN_TERMINAL", "RUN_NOT_CONTROLLABLE", "CONTROL_CONFLICT", "EXECUTION_UNAVAILABLE", "STORE_BUSY", "STORE_ERROR", "INTERNAL_ERROR"].includes(value);
}
