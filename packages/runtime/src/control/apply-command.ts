import type { JsonValue } from "@acpus/expression/ir";
import { advanceRun, type AdvanceResult } from "../execution/advance.js";
import { findSignalNode } from "../execution/ir.js";
import { normalizeValue } from "../evaluation/schema.js";
import { applySchedulerControlCommand } from "../scheduler/control.js";
import { advanceRuntimeRun, hasSchedulerState, type RuntimeAdvanceResult } from "../runs/advance-runtime.js";
import type { AgentOverrideMap, ForkPreparedWorkflow, PendingControlCommand, RuntimeStore } from "../store/store.js";

export type AppliedControlCommand = {
  command: PendingControlCommand;
  sourceRunId: string;
  run: NonNullable<ReturnType<RuntimeStore["getRun"]>>;
  advanced?: AdvanceResult | RuntimeAdvanceResult;
  forkRunId?: string;
};

export async function applyControlCommand(cwd: string, store: RuntimeStore, command: PendingControlCommand, options: { ownerGeneration?: number } = {}): Promise<AppliedControlCommand> {
  if (command.status === "applied") return appliedCommandResult(store, command);
  if (!store.claimCommand(command.id, options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration })) {
    const current = store.getCommand(command.id);
    if (current?.status === "applied") return appliedCommandResult(store, current);
    throw new Error(`Command '${command.id}' is already ${current?.status ?? "missing"}.`);
  }
  try {
    const result = await applyControlCommandUnchecked(cwd, store, command);
    return result;
  } catch (error) {
    store.finishCommand({
      id: command.id,
      status: "failed",
      payload: { type: "unhandled-error", message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

function appliedCommandResult(store: RuntimeStore, command: PendingControlCommand): AppliedControlCommand {
  const runId = requireRunId(command);
  const forkRunId = command.type === "fork" && command.status === "applied" && typeof command.payload.forkRunId === "string"
    ? command.payload.forkRunId
    : undefined;
  const targetRunId = forkRunId ?? runId;
  return {
    command,
    sourceRunId: runId,
    run: requireRun(store, targetRunId),
    ...(forkRunId ? { forkRunId } : {}),
  };
}

async function applyControlCommandUnchecked(cwd: string, store: RuntimeStore, command: PendingControlCommand): Promise<AppliedControlCommand> {
  const runId = requireRunId(command);
  if (usesSchedulerControl(store, runId, command)) {
    await applySchedulerControlCommand(cwd, store, command, { claimCommand: false, advance: false });
    const advanced = command.type === "pause" ? undefined : await advanceRuntimeRun(cwd, store, runId);
    return {
      command,
      sourceRunId: runId,
      run: requireRun(store, runId),
      ...(advanced ? { advanced } : {}),
    };
  }
  if (command.type === "pause") {
    store.pauseRun(runId, { commandId: command.id });
    return { command, sourceRunId: runId, run: requireRun(store, runId) };
  }
  if (command.type === "resume") {
    store.resumeRun(runId, { commandId: command.id });
    const advanced = await advanceRun(cwd, store, runId);
    return { command, sourceRunId: runId, run: requireRun(store, runId), advanced };
  }
  if (command.type === "retry") {
    const node = commandNode(command);
    if (node) store.retryNode(runId, node, { commandId: command.id });
    else store.retryRun(runId, { commandId: command.id });
    const advanced = await advanceRun(cwd, store, runId);
    return { command, sourceRunId: runId, run: requireRun(store, runId), advanced };
  }
  if (command.type === "fork") {
    const payload = forkCommandPayload(command);
    const fork = await store.forkRun(runId, {
      commandId: command.id,
      ...(payload.prepared ? { prepared: payload.prepared } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.agentOverrides !== undefined ? { agentOverrides: payload.agentOverrides } : {}),
    });
    return { command, sourceRunId: runId, run: requireRun(store, fork.id), forkRunId: fork.id };
  }
  if (command.type === "signal") {
    const payload = signalCommandPayload(command);
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    const signal = findSignalNode(frozen.ir.root, payload.node);
    if (!signal) throw new Error(`Signal node '${payload.node}' was not found.`);
    const normalized = normalizeValue(signal.outputSchema, payload.payload, "Signal payload");
    store.signalRun({ runId, nodeKey: payload.node, payload: normalized });
    const advanced = await advanceRun(cwd, store, runId);
    store.finishCommand({ id: command.id, status: "applied", payload: { status: advanced.status } });
    return { command, sourceRunId: runId, run: requireRun(store, runId), advanced };
  }
  throw new Error(`Unsupported command type '${command.type}'.`);
}

function usesSchedulerControl(store: RuntimeStore, runId: string, command: PendingControlCommand): boolean {
  if (!hasSchedulerState(store, runId)) return false;
  return command.type === "pause" || command.type === "resume" || command.type === "signal" || command.type === "retry";
}

function requireRunId(command: PendingControlCommand): string {
  if (!command.runId) throw new Error(`Command '${command.id}' has no run id.`);
  return command.runId;
}

function requireRun(store: RuntimeStore, runId: string): NonNullable<ReturnType<RuntimeStore["getRun"]>> {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run '${runId}' was not found.`);
  return run;
}

function commandNode(command: PendingControlCommand): string | undefined {
  const payload = commandInputPayload(command);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return typeof payload.node === "string" && payload.node.length > 0 ? payload.node : undefined;
}

function signalCommandPayload(command: PendingControlCommand): { node: string; payload: JsonValue } {
  const payload = commandInputPayload(command);
  if (!isRecord(payload)) throw new Error(`Signal command '${command.id}' payload must be an object.`);
  const node = payload.node;
  if (typeof node !== "string" || node.length === 0) throw new Error(`Signal command '${command.id}' payload.node must be a non-empty string.`);
  return { node, payload: payload.payload as JsonValue };
}

function forkCommandPayload(command: PendingControlCommand): { prepared?: ForkPreparedWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap } {
  const payload = commandInputPayload(command);
  if (!isRecord(payload)) return {};
  const prepared = parseForkPreparedWorkflow(payload.prepared);
  if (payload.prepared !== undefined && !prepared) throw new Error(`Fork command '${command.id}' has invalid prepared workflow payload.`);
  return {
    ...(prepared ? { prepared } : {}),
    ...(payload.input !== undefined ? { input: payload.input } : {}),
    ...(payload.agentOverrides !== undefined ? { agentOverrides: payload.agentOverrides as AgentOverrideMap } : {}),
  };
}

function parseForkPreparedWorkflow(value: unknown): ForkPreparedWorkflow | undefined {
  if (!isRecord(value)) return undefined;
  const workflowPath = value.workflowPath;
  const irJson = value.irJson;
  const irDigest = value.irDigest;
  const sourceGraphDigest = value.sourceGraphDigest;
  const packageLockDigest = value.packageLockDigest;
  const lock = value.lock;
  if (typeof workflowPath !== "string"
    || typeof irJson !== "string"
    || typeof irDigest !== "string"
    || typeof sourceGraphDigest !== "string"
    || !isRecord(lock)
    || (packageLockDigest !== undefined && typeof packageLockDigest !== "string")) {
    return undefined;
  }
  return typeof value.workflowPath === "string"
    ? {
      workflowPath,
      irJson,
      irDigest,
      sourceGraphDigest,
      ...(packageLockDigest ? { packageLockDigest } : {}),
      lock: lock as unknown as ForkPreparedWorkflow["lock"],
    }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function commandInputPayload(command: PendingControlCommand): JsonValue | undefined {
  return command.status === "pending" || command.status === "running" ? command.payload : undefined;
}
