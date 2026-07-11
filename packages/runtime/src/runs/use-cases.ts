import { randomUUID } from "node:crypto";
import type { JsonValue } from "@acpus/expression/ir";
import { ResultAsync } from "neverthrow";
import { normalizeWorkflowInput } from "../admission/input.js";
import { runtimeAdvanceResult, tryAdvanceRuntimeRun, type RuntimeAdvanceError, type RuntimeAdvanceResult } from "./advance-runtime.js";
import { ForkSeedPlanError, type ForkSeedFailure } from "../scheduler/fork-seed.js";
import { applySchedulerControlIntent, InvalidSignalPayloadError, type RunControlIntent } from "../scheduler/control.js";
import { schedulerStoreError, type SchedulerStoreError } from "../scheduler/store-port.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  openRuntimeStore,
  type AgentOverrideMap,
  type ForkPreparedWorkflow,
  type PreparedRunWorkflow,
  type RuntimeDiagnostics,
  type DaemonDiagnostics,
  type RunDetails,
  type ArtifactRecord, type RunRecord,
} from "../store/store.js";
export type { ArtifactRecord };

export type RuntimeMutationAction = "pause" | "resume" | "retry" | "fork" | "cancel";

export type RunVisualizationSnapshot = {
  run: RunDetails;
  overlay: WorkflowVisualizationOverlay;
};

export type RuntimeMutationInput = {
  requestId?: string;
  target?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  unsafeReuse?: boolean;
};

export type RuntimeMutationResult = {
  run: RunDetails;
  advanced?: RuntimeAdvanceResult;
  forkRunId?: string;
};

export type RuntimeHealthStatus = "ok" | "warn" | "fail";

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

export type RuntimeUseCaseError =
  | { type: "runtime-store-not-found"; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "scheduler-store-failed"; cause: SchedulerStoreError; message: string }
  | { type: "runtime-advance-failed"; cause: RuntimeAdvanceError; message: string }
  | { type: "invalid-signal-payload"; nodeId: string; message: string }
  | { type: "fork-seed-failed"; cause: ForkSeedFailure; message: string }
  | { type: "run-control-failed"; controlType: RuntimeMutationAction | "signal"; message: string }
  | { type: "run-delete-active"; runId: string; message: string };

export async function admitWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): Promise<RuntimeAdvanceResult> {
  const result = await tryAdmitWorkflowRun(cwd, prepared, input, agentOverrides);
  return result.match(
    value => value,
    error => {
      throw new RuntimeUseCaseException(error);
    },
  );
}

export async function admitPreparedWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): Promise<RunDetails> {
  const store = await openRuntimeStore(cwd);
  try {
    const run = await store.admitRun({ prepared, cwd, input, ...(agentOverrides === undefined ? {} : { agentOverrides }) });
    const details = store.getRun(run.id);
    if (!details) throw new Error(`Admitted run ${run.id} was not persisted.`);
    return details;
  } finally {
    store.close();
  }
}

function tryAdmitWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): ResultAsync<RuntimeAdvanceResult, RuntimeUseCaseError> {
  return ResultAsync.fromPromise(admitWorkflowRunResult(cwd, prepared, input, agentOverrides), runtimeUseCaseThrownError);
}

async function admitWorkflowRunResult(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): Promise<RuntimeAdvanceResult> {
  const store = await openRuntimeStore(cwd);
  try {
    const run = await store.admitRun({ prepared, cwd, input, ...(agentOverrides === undefined ? {} : { agentOverrides }) });
    const advanced = await tryAdvanceRuntimeRun(cwd, store, run.id);
    return advanced.match(
      value => value,
      error => {
        throw new RuntimeUseCaseException({ type: "runtime-advance-failed", cause: error, message: error.message });
      },
    );
  } finally {
    store.close();
  }
}

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

export async function deleteRun(cwd: string, runId: string): Promise<RunRecord | undefined> {
  const result = await tryDeleteRun(cwd, runId);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new RuntimeUseCaseException(error);
    },
  );
}

function tryDeleteRun(cwd: string, runId: string): ResultAsync<RunRecord | undefined, RuntimeUseCaseError> {
  return ResultAsync.fromPromise(deleteRunResult(cwd, runId), runtimeUseCaseThrownError);
}

async function deleteRunResult(cwd: string, runId: string): Promise<RunRecord> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    const run = store.getRun(runId);
    if (!run) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    if (run.execution.state === "active") {
      throw new RuntimeUseCaseException({
        type: "run-delete-active",
        runId,
        message: `Run '${runId}' is active and cannot be deleted.`,
      });
    }
    const deleted = await store.deleteRun(runId);
    if (!deleted) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    return deleted;
  } finally {
    store.close();
  }
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

export async function listArtifacts(cwd: string, runId: string): Promise<ArtifactRecord[]> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return [];
  try {
    return store.listArtifacts(runId);
  } finally {
    store.close();
  }
}

export async function getRunVisualizationSnapshot(cwd: string, runId: string): Promise<RunVisualizationSnapshot | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const frozen = store.getFrozenRun(runId);
    const run = store.getRun(runId);
    if (!frozen || !run) return undefined;
    return {
      run,
      overlay: createWorkflowVisualizationOverlay(frozen.ir, run.dynamic, { runId, status: run.status }),
    };
  } finally {
    store.close();
  }
}

export async function getRunStaticVisualizationOverlay(cwd: string, runId: string): Promise<WorkflowVisualizationOverlay | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const frozen = store.getFrozenRun(runId);
    const run = store.getRun(runId);
    if (!frozen || !run) return undefined;
    return createWorkflowVisualizationOverlay(frozen.ir, undefined, { runId, status: run.status });
  } finally {
    store.close();
  }
}

export async function normalizeForkInput(cwd: string, runId: string, input: JsonValue | undefined, prepared?: PreparedRunWorkflow): Promise<JsonValue | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) return undefined;
    if (input !== undefined) return normalizeWorkflowInput(prepared?.ir ?? frozen.ir, input, "Fork input");
    return prepared ? normalizeWorkflowInput(prepared.ir, frozen.input, "Fork input") : undefined;
  } finally {
    store.close();
  }
}

export async function signalRun(cwd: string, runId: string, nodeId: string, payload: JsonValue): Promise<RuntimeMutationResult | undefined> {
  const result = await trySignalRun(cwd, runId, nodeId, payload);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new RuntimeUseCaseException(error);
    },
  );
}

export function trySignalRun(cwd: string, runId: string, nodeId: string, payload: JsonValue): ResultAsync<RuntimeMutationResult, RuntimeUseCaseError> {
  return ResultAsync.fromPromise(signalRunResultWithOptions(cwd, runId, nodeId, payload), runtimeUseCaseThrownError);
}

export async function applySignalRunControl(cwd: string, runId: string, nodeId: string, payload: JsonValue, options: { requestId?: string } = {}): Promise<RuntimeMutationResult | undefined> {
  const result = await ResultAsync.fromPromise(signalRunResultWithOptions(cwd, runId, nodeId, payload, { advance: false, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) }), runtimeUseCaseThrownError);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new RuntimeUseCaseException(error);
    },
  );
}

async function signalRunResultWithOptions(cwd: string, runId: string, nodeId: string, payload: JsonValue, options: { advance?: boolean; requestId?: string } = {}): Promise<RuntimeMutationResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const requestId = options.requestId ?? `signal:${runId}:${nodeId}:${randomUUID()}`;
    const result = await applySchedulerIntentResult(cwd, store, {
      requestId,
      runId,
      type: "signal",
      node: nodeId,
      payload,
      commandIdempotencyKey: requestId,
    }, options);
    return result;
  } finally {
    store.close();
  }
}

export async function mutateRun(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}): Promise<RuntimeMutationResult | undefined> {
  const result = await tryMutateRun(cwd, runId, action, input);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new RuntimeUseCaseException(error);
    },
  );
}

export function tryMutateRun(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}): ResultAsync<RuntimeMutationResult, RuntimeUseCaseError> {
  return ResultAsync.fromPromise(mutateRunResultWithOptions(cwd, runId, action, input), runtimeUseCaseThrownError);
}

export async function applyRunControl(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}): Promise<RuntimeMutationResult | undefined> {
  const result = await ResultAsync.fromPromise(mutateRunResultWithOptions(cwd, runId, action, input, { advance: false }), runtimeUseCaseThrownError);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new RuntimeUseCaseException(error);
    },
  );
}

async function mutateRunResultWithOptions(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}, options: { advance?: boolean } = {}): Promise<RuntimeMutationResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    requireRun(store, runId);
    if (action === "fork") return await forkRunResult(store, runId, input);
    return await applySchedulerIntentResult(cwd, store, mutationIntent(runId, action, input), options);
  } finally {
    store.close();
  }
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

function mutationIntent(runId: string, action: Exclude<RuntimeMutationAction, "fork">, input: RuntimeMutationInput): RunControlIntent {
  switch (action) {
    case "pause":
      return { requestId: input.requestId ?? `pause:${runId}:${randomUUID()}`, runId, type: "pause" };
    case "resume":
      return { requestId: input.requestId ?? `resume:${runId}:${randomUUID()}`, runId, type: "resume" };
    case "retry":
      return {
        requestId: input.requestId ?? `retry:${runId}:${input.target ?? "run"}:${randomUUID()}`,
        runId,
        type: "retry",
        ...(input.target ? { target: input.target } : {}),
      };
    case "cancel":
      return {
        requestId: input.requestId ?? `cancel:${runId}:${input.target ?? "run"}:${randomUUID()}`,
        runId,
        type: "cancel",
        ...(input.target ? { target: input.target } : {}),
      };
  }
}

export class RuntimeUseCaseException extends Error {
  constructor(readonly failure: RuntimeUseCaseError) {
    super(failure.message);
  }
}

async function applySchedulerIntentResult(cwd: string, store: NonNullable<Awaited<ReturnType<typeof openExistingWritableRuntimeStore>>>, intent: RunControlIntent, options: { advance?: boolean } = {}): Promise<RuntimeMutationResult> {
  try {
    const result = await applySchedulerControlIntent(cwd, store, intent, options);
    if (result.advanced?.status === "lease_lost") {
      throw new RuntimeUseCaseException({ type: "run-control-failed", controlType: intent.type, message: `Run '${intent.runId}' is currently controlled by another owner.` });
    }
    return {
      run: requireRun(store, result.runId),
      ...(result.advanced ? { advanced: runtimeAdvanceResult(store, result.runId, result.advanced) } : {}),
    };
  } catch (error) {
    if (error instanceof InvalidSignalPayloadError) {
      throw new RuntimeUseCaseException({
        type: "invalid-signal-payload",
        nodeId: error.nodeId,
        message: error.message,
      });
    }
    const storeError = schedulerStoreError(error);
    if (storeError) throw new RuntimeUseCaseException({ type: "scheduler-store-failed", cause: storeError, message: storeError.message });
    throw new RuntimeUseCaseException({ type: "run-control-failed", controlType: intent.type, message: error instanceof Error ? error.message : String(error) });
  }
}

async function forkRunResult(store: NonNullable<Awaited<ReturnType<typeof openExistingWritableRuntimeStore>>>, runId: string, input: RuntimeMutationInput): Promise<RuntimeMutationResult> {
  if (input.target === "") throw new Error("Fork target must be a non-empty string.");
  requireRun(store, runId);
  try {
    const fork = await store.forkRun(runId, {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.prepared ? { prepared: toForkPrepared(input.prepared) } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.agentOverrides !== undefined ? { agentOverrides: input.agentOverrides } : {}),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.unsafeReuse === true ? { unsafeReuse: true } : {}),
    });
    return { run: requireRun(store, fork.id), forkRunId: fork.id };
  } catch (error) {
    if (error instanceof ForkSeedPlanError) {
      throw new RuntimeUseCaseException({ type: "fork-seed-failed", cause: error.failure, message: error.message });
    }
    if (error instanceof Error && error.message.includes("conflicts with a different fork input")) {
      throw new RuntimeUseCaseException({ type: "run-control-failed", controlType: "fork", message: error.message });
    }
    throw error;
  }
}

function requireRun(store: NonNullable<Awaited<ReturnType<typeof openExistingWritableRuntimeStore>>>, runId: string): RunDetails {
  const run = store.getRun(runId);
  if (!run) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
  return run;
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

function runtimeUseCaseThrownError(error: unknown): RuntimeUseCaseError {
  if (error instanceof RuntimeUseCaseException) return error.failure;
  const storeError = schedulerStoreError(error);
  if (storeError) return { type: "scheduler-store-failed", cause: storeError, message: storeError.message };
  throw error;
}

function toForkPrepared(prepared: PreparedRunWorkflow): ForkPreparedWorkflow {
  return {
    workflowPath: prepared.workflowPath,
    irJson: prepared.irJson,
    sourceGraphDigest: prepared.sourceGraphDigest,
    ...(prepared.packageLockDigest ? { packageLockDigest: prepared.packageLockDigest } : {}),
    lock: prepared.lock,
  };
}
