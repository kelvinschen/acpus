import type { JsonValue } from "@acpus/expression/ir";
import { applySchedulerControlCommand } from "../scheduler/control.js";
import { advanceRuntimeRun, type RuntimeAdvanceResult } from "../runs/advance-runtime.js";
import type { AgentOverrideMap, ForkPreparedWorkflow, PendingRunControlCommand, RuntimeStore } from "../store/store.js";
import { ForkSeedPlanError } from "../scheduler/fork-seed.js";

export type AppliedControlCommand = {
  command: PendingRunControlCommand;
  sourceRunId: string;
  run: NonNullable<ReturnType<RuntimeStore["getRun"]>>;
  advanced?: RuntimeAdvanceResult;
  forkRunId?: string;
};

export async function applyControlCommand(cwd: string, store: RuntimeStore, command: PendingRunControlCommand, options: { ownerGeneration?: number; advance?: boolean } = {}): Promise<AppliedControlCommand> {
  if (command.status === "applied") return appliedCommandResult(store, command);
  if (!store.claimCommand(command.id, options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration })) {
    const current = store.getCommand(command.id);
    if (current?.status === "applied" && current.type !== "shutdown") return appliedCommandResult(store, current);
    throw new Error(`Command '${command.id}' is already ${current?.status ?? "missing"}.`);
  }
  try {
    const result = await applyControlCommandUnchecked(cwd, store, command, options);
    return result;
  } catch (error) {
    store.finishCommand({
      id: command.id,
      status: "failed",
      payload: error instanceof ForkSeedPlanError
        ? { ...error.failure, message: error.message }
        : { type: "unhandled-error", message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

function appliedCommandResult(store: RuntimeStore, command: PendingRunControlCommand): AppliedControlCommand {
  const runId = command.runId;
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

async function applyControlCommandUnchecked(cwd: string, store: RuntimeStore, command: PendingRunControlCommand, options: { advance?: boolean }): Promise<AppliedControlCommand> {
  const runId = command.runId;
  if (command.type !== "fork") {
    await applySchedulerControlCommand(cwd, store, command, { claimCommand: false, advance: false });
    const advanced = command.type === "pause" || options.advance === false ? undefined : await advanceRuntimeRun(cwd, store, runId);
    return {
      command,
      sourceRunId: runId,
      run: requireRun(store, runId),
      ...(advanced ? { advanced } : {}),
    };
  }
  const payload = forkCommandPayload(command);
  const fork = await store.forkRun(runId, {
    commandId: command.id,
    ...(payload.prepared ? { prepared: payload.prepared } : {}),
    ...(payload.input !== undefined ? { input: payload.input } : {}),
    ...(payload.agentOverrides !== undefined ? { agentOverrides: payload.agentOverrides } : {}),
    ...(payload.target !== undefined ? { target: payload.target } : {}),
    ...(payload.unsafeReuse === true ? { unsafeReuse: true } : {}),
  });
  return { command, sourceRunId: runId, run: requireRun(store, fork.id), forkRunId: fork.id };
}

function requireRun(store: RuntimeStore, runId: string): NonNullable<ReturnType<RuntimeStore["getRun"]>> {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run '${runId}' was not found.`);
  return run;
}

function forkCommandPayload(command: PendingRunControlCommand): { prepared?: ForkPreparedWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap; target?: string; unsafeReuse?: boolean } {
  const payload = commandInputPayload(command);
  if (!isRecord(payload)) return {};
  const prepared = parseForkPreparedWorkflow(payload.prepared);
  if (payload.prepared !== undefined && !prepared) throw new Error(`Fork command '${command.id}' has invalid prepared workflow payload.`);
  if (payload.target !== undefined && (typeof payload.target !== "string" || payload.target.length === 0)) throw new Error(`Fork command '${command.id}' has invalid target payload.`);
  if (payload.unsafeReuse !== undefined && typeof payload.unsafeReuse !== "boolean") throw new Error(`Fork command '${command.id}' has invalid unsafeReuse payload.`);
  return {
    ...(prepared ? { prepared } : {}),
    ...(payload.input !== undefined ? { input: payload.input } : {}),
    ...(payload.agentOverrides !== undefined ? { agentOverrides: payload.agentOverrides as AgentOverrideMap } : {}),
    ...(payload.target !== undefined ? { target: payload.target } : {}),
    ...(payload.unsafeReuse === true ? { unsafeReuse: true } : {}),
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
  return {
    workflowPath,
    irJson,
    irDigest,
    sourceGraphDigest,
    ...(packageLockDigest ? { packageLockDigest } : {}),
    lock: lock as unknown as ForkPreparedWorkflow["lock"],
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function commandInputPayload(command: PendingRunControlCommand): JsonValue | undefined {
  return command.status === "pending" || command.status === "running" ? command.payload : undefined;
}
