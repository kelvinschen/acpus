import { err, ok, ResultAsync } from "neverthrow";
import { sameRuntimeAuthority } from "./authority.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonErrorCode,
  type DaemonHandlerFailure,
  type DaemonRunStreamFrame,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";
import { startDaemonServer, type DaemonServerHandle } from "./server.js";
import type { RunIncident } from "./sessions.js";
import { tryLoadRuntimeConfiguration } from "../configuration.js";
import {
  openWorkspaceRuntimeInternal,
  type OwnedWorkspaceRuntime,
  type WorkspaceRuntimeOpenFailure,
} from "../workspace-runtime.js";
import type { InspectionError } from "../inspection/types.js";

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

export class DaemonRuntimeStoreReadinessError extends Error {
  constructor(readonly failure: WorkspaceRuntimeOpenFailure) {
    super(failure.message);
    this.name = "DaemonRuntimeStoreReadinessError";
  }
}

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions): Promise<DaemonLoopHandle> {
  const configuration = tryLoadRuntimeConfiguration(process.env);
  if (configuration.isErr()) throw new Error(configuration.error.message);
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const idleStopMs = options.idleStopMs ?? 30_000;
  let runtime: OwnedWorkspaceRuntime | undefined;
  let server: DaemonServerHandle;
  let stopped = false;
  let idleSince: number | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  server = await startDaemonServer(cwd, {
    status: () => {
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return ok({
        status: "ok",
        pid: process.pid,
        leaseGeneration: runtime.authority.leaseGeneration,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        packageVersion: options.packageVersion,
        authority: runtime.authority,
      });
    },
    submitAndObserve: (request, signal) => submitAndObserve(request, signal),
    inspect: request => {
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return new ResultAsync((async () => {
        const inspected = await runtime!.inspect(request.view);
        if (inspected.isErr()) return err(inspectionHandlerFailure(inspected.error));
        return inspected.value.kind === "archived-run"
          ? err(handlerFailure("RUN_NOT_FOUND", `Run '${request.view.runId}' was not found.`))
          : ok(inspected.value);
      })());
    },
    control: intent => {
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      return new ResultAsync((async () => {
        const controlled = await runtime!.control(intent);
        return controlled.isErr()
          ? err(handlerFailure(controlled.error.code, controlled.error.message, controlled.error.ambiguity))
          : ok(controlled.value);
      })());
    },
    shutdown: () => {
      if (!runtime) return err(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      if (server.activeConnections() > 1) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active client requests."));
      const activity = runtime.activity();
      if (activity.activeMutations) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active runtime mutations."));
      if (activity.activeSessions > 0) return err(handlerFailure("CONTROL_CONFLICT", "Daemon has active run sessions."));
      const accepted = runtime;
      runtime = undefined;
      setImmediate(() => requestShutdown(accepted));
      return ok({ status: "shutdown" as const });
    },
  });

  let opened;
  try {
    opened = await openWorkspaceRuntimeInternal(cwd, {
      heartbeatMs,
      idleStopMs,
      packageVersion: options.packageVersion,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      ...(options.onRunIncident === undefined ? {} : { onRunIncident: options.onRunIncident }),
      onAuthorityLost: lost => requestShutdown(lost),
    });
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Daemon startup could not release every resource.");
    }
    throw error;
  }
  if (opened.isErr()) {
    await server.close();
    throw new DaemonRuntimeStoreReadinessError(opened.error);
  }
  runtime = opened.value;
  idleTimer = setInterval(checkIdleStop, heartbeatMs);

  async function* submitAndObserve(
    request: DaemonSubmitAndObserveInput,
    signal: AbortSignal,
  ): AsyncIterable<DaemonRunStreamFrame> {
    const current = runtime;
    if (!current) {
      yield runStreamError("admission", "not-admitted", "EXECUTION_UNAVAILABLE", "Daemon is still initializing.");
      return;
    }
    if (!sameRuntimeAuthority(current.authority, request.expectedAuthority)) {
      yield runStreamError("authority", "not-admitted", "AUTHORITY_MISMATCH", "Runtime authority changed before run admission.");
      return;
    }
    const submitted = await current.submit({
      requestId: request.requestId,
      prepared: request.prepared,
      input: request.input,
      ...(request.agentInjections === undefined ? {} : { agentInjections: request.agentInjections }),
    });
    if (submitted.isErr()) {
      yield runStreamError(
        "admission",
        submitted.error.outcome,
        submitted.error.code,
        submitted.error.message,
        submitted.error.runId,
      );
      return;
    }
    yield { kind: "admitted", authority: current.authority, run: submitted.value };
    if (request.until === "admitted" || signal.aborted) return;
    for await (const observed of current.observeInspection({
      view: { kind: "run", runId: submitted.value.id },
      until: request.until,
    }, signal)) {
      if (observed.isErr()) {
        yield runStreamError(
          "observation",
          "admitted",
          "STORE_ERROR",
          observed.error.message,
          submitted.value.id,
        );
        return;
      }
      yield { kind: "observation", observation: observed.value };
    }
  }

  function checkIdleStop(): void {
    const current = runtime;
    if (!current || stopped) return;
    const activity = current.activity();
    if (activity.runsStarted > 0
      || activity.idleBlockers > 0
      || activity.activeSessions > 0
      || activity.activeHooks > 0
      || activity.activeMutations
      || activity.tickActive
      || server.activeConnections() > 0) {
      idleSince = undefined;
      current.setIdleState(undefined, idleStopMs);
      return;
    }
    idleSince ??= Date.now();
    current.setIdleState(new Date(idleSince).toISOString(), idleStopMs);
    if (Date.now() - idleSince >= idleStopMs) requestShutdown(current);
  }

  function requestShutdown(target: OwnedWorkspaceRuntime | undefined): void {
    const notify = () => {
      try {
        options.onShutdown?.();
      } catch {}
    };
    void shutdown(target).then(notify, notify);
  }

  async function shutdown(target = runtime): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    runtime = undefined;
    if (idleTimer) clearInterval(idleTimer);
    shutdownPromise = (async () => {
      const failures: unknown[] = [];
      for (const step of [() => server.close(), () => target?.close()]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Daemon shutdown could not release every resource.");
    })();
    return shutdownPromise;
  }

  return { shutdown };
}

function inspectionHandlerFailure(error: InspectionError): DaemonHandlerFailure {
  if (error.type === "invalid-query") return handlerFailure("INVALID_REQUEST", error.message);
  if (error.type === "run-not-found") return handlerFailure("RUN_NOT_FOUND", error.message);
  if (error.type === "runtime-store-unavailable") return handlerFailure("STORE_BUSY", error.message);
  return handlerFailure("STORE_ERROR", error.message);
}

function handlerFailure(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonHandlerFailure {
  return { code, message, ...(ambiguity ? { ambiguity } : {}) };
}

function runStreamError(
  phase: Extract<DaemonRunStreamFrame, { kind: "error" }>["phase"],
  outcome: Extract<DaemonRunStreamFrame, { kind: "error" }>["outcome"],
  code: DaemonErrorCode,
  message: string,
  runId?: string,
): Extract<DaemonRunStreamFrame, { kind: "error" }> {
  return {
    kind: "error",
    phase,
    outcome,
    ...(runId === undefined ? {} : { runId }),
    error: { code, message },
  };
}
