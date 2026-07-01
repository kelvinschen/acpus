import { randomUUID } from "node:crypto";
import type { JsonValue } from "@acpus/expression/ir";
import { ResultAsync } from "neverthrow";
import { normalizeSignalPayload, normalizeWorkflowInput } from "../admission/input.js";
import type { AdvanceResult } from "../execution/advance.js";
import { applyControlCommand } from "../control/apply-command.js";
import { tryAdvanceRuntimeRun, type RuntimeAdvanceError, type RuntimeAdvanceResult } from "./advance-runtime.js";
import { schedulerStoreError, type SchedulerStoreError } from "../scheduler/store-port.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  openRuntimeStore,
  type AgentOverrideMap,
  type ForkPreparedWorkflow,
  type PendingControlCommand,
  type PreparedRunWorkflow,
  type ReplayResult,
  type RunDetails,
  type RunRecord,
  type SubmitCommandInput,
} from "../store/store.js";

export type RuntimeMutationAction = "pause" | "resume" | "retry" | "fork";

export type RuntimeCommandRecord = Pick<PendingControlCommand, "id" | "type" | "status" | "runId" | "payload">;

export type RuntimeMutationInput = {
  node?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
  agentOverrides?: AgentOverrideMap;
};

export type RuntimeMutationResult = {
  run: RunDetails;
  advanced?: RuntimeAdvanceResult | AdvanceResult;
  command?: RuntimeCommandRecord;
};

export type RuntimeUseCaseError =
  | { type: "runtime-store-not-found"; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "scheduler-store-failed"; cause: SchedulerStoreError; message: string }
  | { type: "runtime-advance-failed"; cause: RuntimeAdvanceError; message: string }
  | { type: "invalid-signal-payload"; nodeId: string; message: string }
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

export async function replayRun(cwd: string, runId: string): Promise<ReplayResult | undefined> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    return store.replayRun(runId);
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
  return ResultAsync.fromPromise(signalRunResult(cwd, runId, nodeId, payload), runtimeUseCaseThrownError);
}

async function signalRunResult(cwd: string, runId: string, nodeId: string, payload: JsonValue): Promise<RuntimeMutationResult> {
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
    const result = await applyCommandResult(cwd, store, command);
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
  return ResultAsync.fromPromise(mutateRunResult(cwd, runId, action, input), runtimeUseCaseThrownError);
}

async function mutateRunResult(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}): Promise<RuntimeMutationResult> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) throw new RuntimeUseCaseException({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    const command = store.submitCommand(mutationCommandInput(runId, action, input));
    if (command.status === "applied") {
      const run = store.getRun(runId);
      if (!run) throw new RuntimeUseCaseException({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
      return { run, command: store.getCommand(command.id) ?? command };
    }
    const result = await applyCommandResult(cwd, store, command);
    const appliedCommand = store.getCommand(command.id) ?? command;
    return { run: result.run, ...(result.advanced ? { advanced: result.advanced } : {}), command: appliedCommand };
  } finally {
    store.close();
  }
}

function mutationCommandInput(runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput): SubmitCommandInput {
  switch (action) {
    case "pause":
      return { runId, type: "pause", idempotencyKey: `pause:${runId}:${randomUUID()}` };
    case "resume":
      return { runId, type: "resume", idempotencyKey: `resume:${runId}:${randomUUID()}` };
    case "retry":
      return {
        runId,
        type: "retry",
        ...(input.node ? { payload: { node: input.node } } : {}),
        idempotencyKey: `retry:${runId}:${input.node ?? "run"}:${randomUUID()}`,
      };
    case "fork":
      return {
        runId,
        type: "fork",
        payload: {
          ...(input.prepared ? { prepared: toForkPrepared(input.prepared) as unknown as JsonValue } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.agentOverrides !== undefined ? { agentOverrides: input.agentOverrides as unknown as JsonValue } : {}),
        },
        idempotencyKey: `fork:${runId}:${randomUUID()}`,
      };
  }
}

class RuntimeUseCaseException extends Error {
  constructor(readonly failure: RuntimeUseCaseError) {
    super(failure.message);
  }
}

async function applyCommandResult(cwd: string, store: NonNullable<Awaited<ReturnType<typeof openExistingWritableRuntimeStore>>>, command: PendingControlCommand): Promise<Awaited<ReturnType<typeof applyControlCommand>>> {
  try {
    return await applyControlCommand(cwd, store, command);
  } catch (error) {
    const storeError = schedulerStoreError(error);
    if (storeError) throw new RuntimeUseCaseException({ type: "scheduler-store-failed", cause: storeError, message: storeError.message });
    throw new RuntimeUseCaseException({ type: "control-command-failed", commandType: command.type, message: error instanceof Error ? error.message : String(error) });
  }
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
