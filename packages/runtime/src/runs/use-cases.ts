import { randomUUID } from "node:crypto";
import type { NodeIR, SchemaIR, ScopeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { ResultAsync } from "neverthrow";
import { normalizeSignalPayload, normalizeWorkflowInput } from "../admission/input.js";
import { applyControlCommand } from "../control/apply-command.js";
import { tryAdvanceRuntimeRun, type RuntimeAdvanceError, type RuntimeAdvanceObserver, type RuntimeAdvanceResult } from "./advance-runtime.js";
import { ForkSeedPlanError, type ForkSeedFailure } from "../scheduler/fork-seed.js";
import { schedulerStoreError, type SchedulerStoreError } from "../scheduler/store-port.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  openRuntimeStore,
  type AgentOverrideMap,
  type ForkPreparedWorkflow,
  type PendingControlCommand,
  type PendingRunControlCommand,
  type PreparedRunWorkflow,
  type RuntimeDiagnostics,
  type SupervisorDiagnostics,
  type RunDetails,
  type RunRecord,
  type SubmitRunControlCommandInput,
} from "../store/store.js";

export type RuntimeMutationAction = "pause" | "resume" | "retry" | "fork" | "cancel";

export type RuntimeCommandRecord = Pick<PendingControlCommand, "id" | "type" | "status" | "runId" | "payload">;

export type RunInspectionStaticNode = {
  nodeId: string;
  kind: NodeIR["kind"];
  order: number;
  outputSchema?: SchemaIR;
};

export type RunInspection = {
  run: RunDetails;
  staticNodes: RunInspectionStaticNode[];
};

export type RuntimeMutationInput = {
  target?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
  unsafeReuse?: boolean;
};

export type RuntimeMutationResult = {
  run: RunDetails;
  advanced?: RuntimeAdvanceResult;
  command?: RuntimeCommandRecord;
  forkRunId?: string;
};

export type RuntimeHealthStatus = "ok" | "warn" | "fail";

export type RuntimeHealthCheck = {
  area: "workspace" | "store" | "supervisor" | "queues" | "runs" | "idle-stop";
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
  | { type: "control-command-failed"; commandType: PendingControlCommand["type"]; message: string };

export async function admitWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): Promise<RuntimeAdvanceResult> {
  const result = await tryAdmitWorkflowRun(cwd, prepared, input, agentOverrides);
  return result.match(
    value => value,
    error => {
      throw new Error(error.message);
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

export async function advanceWorkflowRun(cwd: string, runId: string, ownerId = "runtime-public", observe?: RuntimeAdvanceObserver): Promise<RuntimeAdvanceResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new Error("Runtime store was not found.");
  try {
    const advanced = await tryAdvanceRuntimeRun(cwd, store, runId, ownerId, observe);
    return advanced.match(
      value => value,
      error => {
        throw new Error(error.message);
      },
    );
  } finally {
    store.close();
  }
}

export async function releaseWorkflowRunOwner(cwd: string, runId: string, ownerId: string): Promise<boolean> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) return false;
  try {
    return store.releaseRunOwner(runId, ownerId);
  } finally {
    store.close();
  }
}

export function tryAdmitWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue, agentOverrides?: AgentOverrideMap): ResultAsync<RuntimeAdvanceResult, RuntimeUseCaseError> {
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

export async function getRunInspection(cwd: string, runId: string): Promise<RunInspection | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const run = store.getRun(runId);
    if (!run) return undefined;
    const frozen = store.getFrozenRun(runId);
    return {
      run,
      staticNodes: frozen ? inspectionStaticNodes(frozen.ir) : [],
    };
  } finally {
    store.close();
  }
}

export async function getRunVisualizationOverlay(cwd: string, runId: string): Promise<WorkflowVisualizationOverlay | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const frozen = store.getFrozenRun(runId);
    const run = store.getRun(runId);
    if (!frozen || !run) return undefined;
    return createWorkflowVisualizationOverlay(frozen.ir, run.dynamic, { runId, status: run.status });
  } finally {
    store.close();
  }
}

function inspectionStaticNodes(ir: WorkflowIR): RunInspectionStaticNode[] {
  const nodes: RunInspectionStaticNode[] = [];
  visitScope(ir.root, nodes);
  return nodes;
}

function visitScope(scope: ScopeIR, nodes: RunInspectionStaticNode[]): void {
  for (const node of scope.nodes) {
    nodes.push({
      nodeId: node.id,
      kind: node.kind,
      order: nodes.length,
      ...(node.kind === "signal" ? { outputSchema: node.outputSchema } : {}),
    });
    for (const child of childScopes(node)) visitScope(child, nodes);
  }
}

function childScopes(node: NodeIR): ScopeIR[] {
  if (node.kind === "if") return [node.then, node.else];
  if (node.kind === "switch") return [...node.cases.map(item => item.then), node.default];
  if (node.kind === "parallel") return Object.values(node.branches).map(branch => branch.scope);
  if (node.kind === "fanout" || node.kind === "loop") return [node.do];
  return [];
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

export async function queueSupervisorShutdown(cwd: string): Promise<RuntimeCommandRecord | undefined> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    return store.submitCommand({
      type: "shutdown",
      idempotencyKey: "shutdown",
    });
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
      throw new Error(error.message);
    },
  );
}

export function trySignalRun(cwd: string, runId: string, nodeId: string, payload: JsonValue): ResultAsync<RuntimeMutationResult, RuntimeUseCaseError> {
  return ResultAsync.fromPromise(signalRunResultWithOptions(cwd, runId, nodeId, payload), runtimeUseCaseThrownError);
}

export async function applySignalRunControl(cwd: string, runId: string, nodeId: string, payload: JsonValue): Promise<RuntimeMutationResult | undefined> {
  const result = await ResultAsync.fromPromise(signalRunResultWithOptions(cwd, runId, nodeId, payload, { advance: false }), runtimeUseCaseThrownError);
  return result.match(
    value => value,
    error => {
      if (error.type === "runtime-store-not-found" || error.type === "run-not-found") return undefined;
      throw new Error(error.message);
    },
  );
}

async function signalRunResultWithOptions(cwd: string, runId: string, nodeId: string, payload: JsonValue, options: { advance?: boolean } = {}): Promise<RuntimeMutationResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const snapshot = store.scheduler.tryLoadRunSnapshot(runId);
    if (snapshot.isErr()) throw new RuntimeUseCaseException({ type: "scheduler-store-failed", cause: snapshot.error, message: snapshot.error.message });
    const signalNodeId = snapshot.value.projection.signalWaits[nodeId]?.nodeId ?? nodeId;
    let normalized: JsonValue;
    try {
      normalized = normalizeSignalPayload(frozen.ir, signalNodeId, payload);
    } catch (error) {
      throw new RuntimeUseCaseException({ type: "invalid-signal-payload", nodeId: signalNodeId, message: error instanceof Error ? error.message : String(error) });
    }
    const command = store.submitCommand({
      runId,
      type: "signal",
      payload: { node: nodeId, payload: normalized },
      idempotencyKey: `signal:${runId}:${nodeId}:${randomUUID()}`,
    });
    const result = await applyCommandResult(cwd, store, command, options);
    const appliedCommand = store.getCommand(command.id) ?? command;
    return { run: result.run, ...(result.advanced ? { advanced: result.advanced } : {}), command: appliedCommand };
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
      throw new Error(error.message);
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
      throw new Error(error.message);
    },
  );
}

async function mutateRunResultWithOptions(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}, options: { advance?: boolean } = {}): Promise<RuntimeMutationResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    const command = store.submitCommand(mutationCommandInput(runId, action, input));
    if (command.status === "applied") {
      const run = store.getRun(runId);
      if (!run) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
      const applied = store.getCommand(command.id) ?? command;
      const forkRunId = applied.type === "fork" && applied.status === "applied" && typeof applied.payload.forkRunId === "string"
        ? applied.payload.forkRunId
        : undefined;
      return { run, command: applied, ...(forkRunId ? { forkRunId } : {}) };
    }
    const result = await applyCommandResult(cwd, store, command, options);
    const appliedCommand = store.getCommand(command.id) ?? command;
    return { run: result.run, ...(result.advanced ? { advanced: result.advanced } : {}), command: appliedCommand, ...(result.forkRunId ? { forkRunId: result.forkRunId } : {}) };
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
      supervisorCheck(diagnostics.supervisor),
      {
        area: "queues",
        status: diagnostics.commands.failed > 0 ? "warn" : "ok",
        message: `${diagnostics.commands.pending} pending, ${diagnostics.commands.running} running, ${diagnostics.commands.failed} failed commands.`,
        details: {
          pending: diagnostics.commands.pending,
          running: diagnostics.commands.running,
          failed: diagnostics.commands.failed,
          ...(diagnostics.commands.oldestPendingAt ? { oldestPendingAt: diagnostics.commands.oldestPendingAt } : {}),
        },
      },
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

function mutationCommandInput(runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput): SubmitRunControlCommandInput {
  if (action === "fork" && input.target === "") throw new Error("Fork target must be a non-empty string.");
  switch (action) {
    case "pause":
      return { runId, type: "pause", idempotencyKey: `pause:${runId}:${randomUUID()}` };
    case "resume":
      return { runId, type: "resume", idempotencyKey: `resume:${runId}:${randomUUID()}` };
    case "retry":
      return {
        runId,
        type: "retry",
        ...(input.target ? { payload: { target: input.target } } : {}),
        idempotencyKey: `retry:${runId}:${input.target ?? "run"}:${randomUUID()}`,
      };
    case "cancel":
      return {
        runId,
        type: "cancel",
        ...(input.target ? { payload: { target: input.target } } : {}),
        idempotencyKey: `cancel:${runId}:${input.target ?? "run"}:${randomUUID()}`,
      };
    case "fork":
      return {
        runId,
        type: "fork",
        payload: {
          ...(input.prepared ? { prepared: toForkPrepared(input.prepared) } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.agentOverrides !== undefined ? { agentOverrides: input.agentOverrides } : {}),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.unsafeReuse === true ? { unsafeReuse: true } : {}),
        },
        idempotencyKey: `fork:${runId}:${input.target ?? "root"}:${randomUUID()}`,
      };
  }
}

class RuntimeUseCaseException extends Error {
  constructor(readonly failure: RuntimeUseCaseError) {
    super(failure.message);
  }
}

async function applyCommandResult(cwd: string, store: NonNullable<Awaited<ReturnType<typeof openExistingWritableRuntimeStore>>>, command: PendingRunControlCommand, options: { advance?: boolean } = {}): Promise<Awaited<ReturnType<typeof applyControlCommand>>> {
  try {
    return await applyControlCommand(cwd, store, command, options);
  } catch (error) {
    if (error instanceof ForkSeedPlanError) {
      throw new RuntimeUseCaseException({ type: "fork-seed-failed", cause: error.failure, message: error.message });
    }
    const storeError = schedulerStoreError(error);
    if (storeError) throw new RuntimeUseCaseException({ type: "scheduler-store-failed", cause: storeError, message: storeError.message });
    throw new RuntimeUseCaseException({ type: "control-command-failed", commandType: command.type, message: error instanceof Error ? error.message : String(error) });
  }
}

function supervisorCheck(supervisor: SupervisorDiagnostics | undefined): RuntimeHealthCheck {
  if (!supervisor) return { area: "supervisor", status: "ok", message: "No supervisor lease is present." };
  const heartbeatAgeMs = supervisor.heartbeatAt ? Date.now() - Date.parse(supervisor.heartbeatAt) : undefined;
  const idleAgeMs = supervisor.idleSinceAt ? Date.now() - Date.parse(supervisor.idleSinceAt) : undefined;
  const processAlive = supervisor.pid === undefined ? undefined : isProcessAlive(supervisor.pid);
  const stale = heartbeatAgeMs !== undefined && heartbeatAgeMs > 30_000;
  return {
    area: "supervisor",
    status: stale || processAlive === false ? "warn" : "ok",
    message: stale ? "Supervisor heartbeat is stale." : processAlive === false ? "Supervisor pid is not alive." : idleAgeMs === undefined ? "Supervisor lease is fresh." : "Supervisor lease is fresh and idle.",
    details: {
      generation: supervisor.generation,
      ...(supervisor.pid === undefined ? {} : { pid: supervisor.pid }),
      ...(heartbeatAgeMs === undefined ? {} : { heartbeatAgeMs }),
      ...(supervisor.idleSinceAt === undefined ? {} : { idleSinceAt: supervisor.idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(supervisor.idleStopMs === undefined ? {} : { idleStopMs: supervisor.idleStopMs }),
      ...(processAlive === undefined ? {} : { processAlive }),
      packageVersion: supervisor.packageVersion,
      nodeVersion: supervisor.nodeVersion,
      execPath: supervisor.execPath,
    },
  };
}

function idleStopCheck(diagnostics: RuntimeDiagnostics): RuntimeHealthCheck {
  const { pending: pendingCommands } = diagnostics.commands;
  const { runnable: runnableRuns } = diagnostics.runs;
  const { activeForeground } = diagnostics.leases;
  const idleSinceAt = diagnostics.supervisor?.idleSinceAt;
  const idleAgeMs = idleSinceAt ? Date.now() - Date.parse(idleSinceAt) : undefined;
  const blockers = [
    pendingCommands > 0 ? "pending commands" : undefined,
    runnableRuns > 0 ? "runnable runs" : undefined,
    activeForeground > 0 ? "active foreground ownership" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
  return {
    area: "idle-stop",
    status: "ok",
    message: blockers.length === 0 ? "No idle-stop blockers." : `Idle-stop blocked by ${blockers.join(", ")}.`,
    details: {
      pendingCommands,
      runnableRuns,
      activeForeground,
      ...(idleSinceAt === undefined ? {} : { idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(diagnostics.supervisor?.idleStopMs === undefined ? {} : { idleStopMs: diagnostics.supervisor.idleStopMs }),
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
    irDigest: prepared.irDigest,
    sourceGraphDigest: prepared.sourceGraphDigest,
    ...(prepared.packageLockDigest ? { packageLockDigest: prepared.packageLockDigest } : {}),
    lock: prepared.lock,
  };
}
