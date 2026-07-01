import { randomUUID } from "node:crypto";
import type { JsonValue } from "@acpus/expression/ir";
import { normalizeSignalPayload, normalizeWorkflowInput } from "../admission/input.js";
import type { AdvanceResult } from "../execution/advance.js";
import { applyControlCommand } from "../control/apply-command.js";
import { advanceRuntimeRun, type RuntimeAdvanceResult } from "./advance-runtime.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  openRuntimeStore,
  type ForkPreparedWorkflow,
  type PendingControlCommand,
  type PreparedRunWorkflow,
  type ReplayResult,
  type RunDetails,
  type RunRecord,
} from "../store/store.js";

export type RuntimeMutationAction = "pause" | "resume" | "retry" | "fork";

export type RuntimeCommandRecord = Pick<PendingControlCommand, "id" | "type" | "status" | "runId" | "payload">;

export type RuntimeMutationInput = {
  node?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
};

export type RuntimeMutationResult = {
  run: RunDetails;
  advanced?: RuntimeAdvanceResult | AdvanceResult;
  command?: RuntimeCommandRecord;
};

export async function admitWorkflowRun(cwd: string, prepared: PreparedRunWorkflow, input: JsonValue): Promise<RuntimeAdvanceResult> {
  const store = await openRuntimeStore(cwd);
  try {
    const run = await store.admitRun({ prepared, cwd, input });
    return await advanceRuntimeRun(cwd, store, run.id);
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
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) return undefined;
    const signalNodeId = store.scheduler.loadRunSnapshot(runId).projection.signalWaits[nodeId]?.nodeId ?? nodeId;
    const normalized = normalizeSignalPayload(frozen.ir, signalNodeId, payload);
    const command = store.submitCommand({
      runId,
      type: "signal",
      payload: { node: nodeId, payload: normalized },
      idempotencyKey: `signal:${runId}:${nodeId}:${randomUUID()}`,
    });
    const result = await applyControlCommand(cwd, store, command);
    const appliedCommand = store.getCommand(command.id) ?? command;
    return { run: result.run, ...(result.advanced ? { advanced: result.advanced } : {}), command: appliedCommand };
  } finally {
    store.close();
  }
}

export async function mutateRun(cwd: string, runId: string, action: RuntimeMutationAction, input: RuntimeMutationInput = {}): Promise<RuntimeMutationResult | undefined> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) return undefined;
  try {
    const payload = action === "retry" && input.node
      ? { node: input.node }
      : action === "fork"
        ? {
            ...(input.prepared ? { prepared: toForkPrepared(input.prepared) as unknown as JsonValue } : {}),
            ...(input.input !== undefined ? { input: input.input } : {}),
          }
        : {};
    const command = store.submitCommand({
      runId,
      type: action,
      payload,
      idempotencyKey: action === "retry" ? `${action}:${runId}:${input.node ?? "run"}:${randomUUID()}`
        : action === "fork" ? `${action}:${runId}:${randomUUID()}`
          : `${action}:${runId}:${randomUUID()}`,
    });
    if (command.status === "applied") {
      const run = store.getRun(runId);
      if (!run) return undefined;
      return { run, command: store.getCommand(command.id) ?? command };
    }
    const result = await applyControlCommand(cwd, store, command);
    const appliedCommand = store.getCommand(command.id) ?? command;
    return { run: result.run, ...(result.advanced ? { advanced: result.advanced } : {}), command: appliedCommand };
  } finally {
    store.close();
  }
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
