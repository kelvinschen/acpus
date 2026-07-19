import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync } from "neverthrow";
import { tryNormalizeWorkflowInput, type SchemaNormalizationFailure } from "../admission/input.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  type PreparedRunWorkflow,
  type RuntimeDiagnostics,
  type DaemonDiagnostics,
  type RunDetails,
  type ArtifactRecord, type RunDeleteFailure, type RunRecord,
} from "../store/store.js";
export type { ArtifactRecord };
export type { RunDeleteFailure } from "../store/store.js";

type RunVisualizationSnapshot = {
  run: RunDetails;
  overlay: WorkflowVisualizationOverlay;
};

type RuntimeHealthStatus = "ok" | "warn" | "fail";

export type RuntimeHealthCheck = {
  area: "workspace" | "store" | "daemon" | "runs" | "idle-stop";
  status: RuntimeHealthStatus;
  message: string;
  details?: Record<string, JsonValue>;
};

export type RuntimeHealthReport = {
  ok: boolean;
  phase: "doctor";
  state: "not-initialized" | "ready" | "unreadable";
  checks: RuntimeHealthCheck[];
};

export type ForkInputNormalizationFailure =
  | { type: "run-not-found"; runId: string; message: string }
  | SchemaNormalizationFailure;

export async function listRuns(cwd: string): Promise<RunRecord[]> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return [];
  try {
    return store.listRuns();
  } finally {
    store.close();
  }
}

export async function getRun(cwd: string, runId: string): Promise<RunDetails | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    return store.getRun(runId);
  } finally {
    store.close();
  }
}

export function deleteRun(cwd: string, runId: string): ResultAsync<RunRecord | undefined, RunDeleteFailure> {
  return new ResultAsync((async () => {
    const store = await openExistingWritableRuntimeStore(cwd);
    if (!store) return ok(undefined);
    try {
      return await store.deleteRun(runId);
    } finally {
      store.close();
    }
  })());
}

export async function getArtifact(cwd: string, runId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    return store.getArtifact(runId, artifactId);
  } finally {
    store.close();
  }
}

export async function listArtifacts(cwd: string, runId: string): Promise<ArtifactRecord[] | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    if (!store.getRun(runId)) return undefined;
    return store.listArtifacts(runId);
  } finally {
    store.close();
  }
}

export async function getRunVisualizationSnapshot(cwd: string, runId: string): Promise<RunVisualizationSnapshot | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const run = store.getRun(runId);
    if (!run) return undefined;
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' has no frozen workflow.`);
    return {
      run,
      overlay: createWorkflowVisualizationOverlay(frozen.ir, run.dynamic, { runId, status: run.status }),
    };
  } finally {
    store.close();
  }
}

export function tryNormalizeForkInput(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow): ResultAsync<JsonValue | undefined, ForkInputNormalizationFailure> {
  return new ResultAsync((async () => {
    const store = await openExistingRuntimeStore(cwd);
    if (!store) return err(runNotFound(runId));
    try {
      const frozen = store.getFrozenRun(runId);
      if (!frozen) return err(runNotFound(runId));
      if (input !== undefined) return tryNormalizeWorkflowInput(prepared?.ir ?? frozen.ir, input, "Fork input");
      return prepared ? tryNormalizeWorkflowInput(prepared.ir, frozen.input, "Fork input") : ok(undefined);
    } finally {
      store.close();
    }
  })());
}

export async function getRuntimeHealth(cwd: string): Promise<RuntimeHealthReport> {
  let store: Awaited<ReturnType<typeof openExistingRuntimeStore>>;
  try {
    store = await openExistingRuntimeStore(cwd);
  } catch (error) {
    return {
      ok: false,
      phase: "doctor",
      state: "unreadable",
      checks: [{
        area: "store",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  if (!store) {
    return {
      ok: true,
      phase: "doctor",
      state: "not-initialized",
      checks: [{
        area: "workspace",
        status: "ok",
        message: "Runtime store is not initialized.",
        details: { cwd },
      }],
    };
  }
  try {
    const diagnostics = store.getRuntimeDiagnostics();
    const checks: RuntimeHealthCheck[] = [
      { area: "workspace", status: "ok", message: "Workspace resolved.", details: { cwd } },
      { area: "store", status: "ok", message: "Runtime store opened read-only." },
      daemonCheck(diagnostics.daemon),
      {
        area: "runs",
        status: "ok",
        message: `${diagnostics.runs.total} runs, ${diagnostics.runs.runnable} runnable.`,
        details: diagnostics.runs as unknown as Record<string, JsonValue>,
      },
      idleStopCheck(diagnostics),
    ];
    if (diagnostics.leases.stale > 0) {
      checks.push({
        area: "runs",
        status: "warn",
        message: `${diagnostics.leases.stale} stale run leases found.`,
        details: { staleRunLeases: diagnostics.leases.stale },
      });
    }
    return { ok: checks.every(check => check.status !== "fail"), phase: "doctor", state: "ready", checks };
  } catch (error) {
    return {
      ok: false,
      phase: "doctor",
      state: "unreadable",
      checks: [{
        area: "store",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  } finally {
    store.close();
  }
}

function runNotFound(runId: string): Extract<ForkInputNormalizationFailure, { type: "run-not-found" }> {
  return { type: "run-not-found", runId, message: `Run '${runId}' was not found.` };
}

function daemonCheck(daemon: DaemonDiagnostics | undefined): RuntimeHealthCheck {
  if (!daemon) return { area: "daemon", status: "ok", message: "No daemon lease is present." };
  const heartbeatAgeMs = daemon.heartbeatAt ? Date.now() - Date.parse(daemon.heartbeatAt) : undefined;
  const idleAgeMs = daemon.idleSinceAt ? Date.now() - Date.parse(daemon.idleSinceAt) : undefined;
  const processAlive = daemon.pid === undefined ? undefined : isProcessAlive(daemon.pid);
  const stale = heartbeatAgeMs !== undefined && heartbeatAgeMs > 30_000;
  return {
    area: "daemon",
    status: stale || processAlive === false ? "warn" : "ok",
    message: stale ? "Daemon heartbeat is stale." : processAlive === false ? "Daemon pid is not alive." : idleAgeMs === undefined ? "Daemon lease is fresh." : "Daemon lease is fresh and idle.",
    details: {
      generation: daemon.generation,
      ...(daemon.pid === undefined ? {} : { pid: daemon.pid }),
      ...(heartbeatAgeMs === undefined ? {} : { heartbeatAgeMs }),
      ...(daemon.idleSinceAt === undefined ? {} : { idleSinceAt: daemon.idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(daemon.idleStopMs === undefined ? {} : { idleStopMs: daemon.idleStopMs }),
      ...(processAlive === undefined ? {} : { processAlive }),
      packageVersion: daemon.packageVersion,
      nodeVersion: daemon.nodeVersion,
      execPath: daemon.execPath,
    },
  };
}

function idleStopCheck(diagnostics: RuntimeDiagnostics): RuntimeHealthCheck {
  const { runnable: runnableRuns } = diagnostics.runs;
  const idleSinceAt = diagnostics.daemon?.idleSinceAt;
  const idleAgeMs = idleSinceAt ? Date.now() - Date.parse(idleSinceAt) : undefined;
  const blockers = [
    runnableRuns > 0 ? "runnable runs" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
  return {
    area: "idle-stop",
    status: "ok",
    message: blockers.length === 0 ? "No idle-stop blockers." : `Idle-stop blocked by ${blockers.join(", ")}.`,
    details: {
      runnableRuns,
      ...(idleSinceAt === undefined ? {} : { idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(diagnostics.daemon?.idleStopMs === undefined ? {} : { idleStopMs: diagnostics.daemon.idleStopMs }),
    },
  };
}

function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH" ? false : undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
