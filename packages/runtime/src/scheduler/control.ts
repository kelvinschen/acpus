import type { JsonValue } from "@acpus/expression/ir";
import { normalizeSignalPayload } from "../admission/input.js";
import type { PendingRunControlCommand, RuntimeStore } from "../store/store.js";
import { schedulerStoreError, throwSchedulerStoreResult, type SchedulerSnapshot, type SchedulerStoreResult } from "./store-port.js";
import { advanceFrozenRun } from "./runtime-runner.js";
import type { AdvanceRunSummary } from "./advance.js";

export type AppliedSchedulerControlCommand = {
  command: PendingRunControlCommand;
  runId: string;
  snapshot: SchedulerSnapshot;
  advanced?: AdvanceRunSummary;
};

export type ApplySchedulerControlCommandOptions = {
  ownerGeneration?: number;
  ownerId?: string;
  leaseMs?: number;
  advance?: boolean;
  claimCommand?: boolean;
};

export async function applySchedulerControlCommand(
  cwd: string,
  store: RuntimeStore,
  command: PendingRunControlCommand,
  options: ApplySchedulerControlCommandOptions = {},
): Promise<AppliedSchedulerControlCommand> {
  if (command.status === "applied") return appliedCommandResult(store, command);
  if (options.claimCommand !== false && !store.claimCommand(command.id, options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration })) {
    const current = store.getCommand(command.id);
    if (current?.status === "applied" && current.type !== "shutdown") return appliedCommandResult(store, current);
    throw new Error(`Command '${command.id}' is already ${current?.status ?? "missing"}.`);
  }
  try {
    return await applySchedulerControlCommandUnchecked(cwd, store, command, options);
  } catch (error) {
    const storeError = schedulerStoreError(error);
    store.finishCommand({
      id: command.id,
      status: "failed",
      payload: {
        type: storeError?.type ?? "unhandled-error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

function appliedCommandResult(store: RuntimeStore, command: PendingRunControlCommand): AppliedSchedulerControlCommand {
  const runId = command.runId;
  return { command, runId, snapshot: unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)) };
}

async function applySchedulerControlCommandUnchecked(
  cwd: string,
  store: RuntimeStore,
  command: PendingRunControlCommand,
  options: ApplySchedulerControlCommandOptions,
): Promise<AppliedSchedulerControlCommand> {
  const runId = command.runId;
  const ownerId = options.ownerId ?? "scheduler-control";
  const leaseMs = options.leaseMs ?? 30_000;
  const claim = store.scheduler.claimRun(runId, ownerId, leaseMs);
  if (!claim) {
    store.deferCommand(command.id);
    return {
      command,
      runId,
      snapshot: unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)),
      advanced: { status: "lease_lost", runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    };
  }

  let snapshot: SchedulerSnapshot;
  try {
    snapshot = applySchedulerControlIntent(store, command, runId, claim.ownerEpoch);
    store.finishCommand({ id: command.id, status: "applied", payload: { status: snapshot.projection.run.status } });
  } finally {
    store.scheduler.releaseRun(claim);
  }

  if (command.type !== "pause" && options.advance !== false) {
    const advanced = await advanceFrozenRun({ cwd, store, runId, ownerId, leaseMs });
    return { command, runId, snapshot: unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)), advanced };
  }
  return { command, runId, snapshot };
}

function applySchedulerControlIntent(store: RuntimeStore, command: PendingRunControlCommand, runId: string, ownerEpoch: number): SchedulerSnapshot {
  const idempotencyKey = `scheduler:control:${command.id}`;
  const snapshot = unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId));
  if (command.type === "pause") {
    const reason = commandReason(command);
    return unwrapStoreResult(store.scheduler.tryPauseRun({
      runId,
      ownerEpoch,
      idempotencyKey,
      ...(reason === undefined ? {} : { reason }),
    }));
  }
  if (command.type === "resume") {
    return unwrapStoreResult(store.scheduler.tryResumeRun({ runId, ownerEpoch, idempotencyKey }));
  }
  if (command.type === "retry") {
    const target = commandTarget(command);
    return target === undefined
      ? unwrapStoreResult(store.scheduler.tryRetryRun({ runId, ownerEpoch, idempotencyKey }))
      : unwrapStoreResult(store.scheduler.tryRetry({ runId, ownerEpoch, idempotencyKey, targetKey: retryTargetKey(target, command.id, snapshot) }));
  }
  if (command.type === "cancel") {
    const target = commandTarget(command);
    const targetKey = target === undefined ? undefined : cancelTargetKey(target, command.id, snapshot);
    return unwrapStoreResult(store.scheduler.tryCancel({
      runId,
      ownerEpoch,
      idempotencyKey,
      ...(targetKey === undefined ? {} : { targetKey }),
    }));
  }
  if (command.type === "signal") {
    const signal = signalPayload(command, snapshot);
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    const normalized = normalizeSignalPayload(frozen.ir, signal.nodeId, signal.payload);
    return unwrapStoreResult(store.scheduler.tryConsumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.nodeKey,
      payload: normalized,
      commandIdempotencyKey: command.idempotencyKey,
      idempotencyKey,
    }));
  }
  throw new Error(`Unsupported scheduler command type '${command.type}'.`);
}

function commandReason(command: PendingRunControlCommand): string | undefined {
  const payload = commandInputPayload(command);
  if (!isRecord(payload)) return undefined;
  return typeof payload.reason === "string" && payload.reason.length > 0 ? payload.reason : undefined;
}

function retryTargetKey(target: string, commandId: string, snapshot: SchedulerSnapshot): string {
  if (snapshot.projection.instances[target]) return target;
  if (snapshot.projection.frames[target]) return target;
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && instance.status === "failed")
    .map(instance => instance.nodeKey)
    .sort();
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame => (frame.frameKind === "node" || frame.frameKind === "loop") && frame.nodeId === target && frame.status === "failed")
    .map(frame => frame.frameKey)
    .sort();
  const matches = [...instanceMatches, ...frameMatches].sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Scheduler retry command '${commandId}' target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`);
  return target;
}

function cancelTargetKey(target: string, commandId: string, snapshot: SchedulerSnapshot): string {
  if (snapshot.projection.instances[target]) return target;
  if (snapshot.projection.frames[target]) return target;
  const instanceMatches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && !isTerminalStatus(instance.status))
    .map(instance => instance.nodeKey)
    .sort();
  const frameMatches = Object.values(snapshot.projection.frames)
    .filter(frame => (frame.frameKind === "node" || frame.frameKind === "loop") && frame.nodeId === target && !isTerminalStatus(frame.status))
    .map(frame => frame.frameKey)
    .sort();
  const matches = [...instanceMatches, ...frameMatches].sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Scheduler cancel command '${commandId}' target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`);
  return target;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function signalPayload(command: PendingRunControlCommand, snapshot: SchedulerSnapshot): { nodeKey: string; nodeId: string; payload: JsonValue } {
  const payload = commandInputPayload(command);
  if (!isRecord(payload) || typeof payload.node !== "string" || payload.node.length === 0) {
    throw new Error(`Scheduler signal command '${command.id}' requires payload.node.`);
  }
  const target = payload.node;
  if (isOpenSignalWait(snapshot, target)) return { nodeKey: target, nodeId: snapshot.projection.signalWaits[target]!.nodeId, payload: payload.payload as JsonValue };
  const matches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.nodeId === target && isOpenSignalWait(snapshot, wait.nodeKey))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (matches.length === 1) return { nodeKey: matches[0]!.nodeKey, nodeId: matches[0]!.nodeId, payload: payload.payload as JsonValue };
  if (matches.length > 1) throw new Error(`Scheduler signal command '${command.id}' target '${target}' is ambiguous. Candidate nodeKeys: ${matches.map(wait => wait.nodeKey).join(", ")}.`);
  const duplicate = Object.values(snapshot.projection.signalWaits)
    .find(wait => wait.commandIdempotencyKey === command.idempotencyKey);
  if (duplicate) return { nodeKey: duplicate.nodeKey, nodeId: duplicate.nodeId, payload: payload.payload as JsonValue };
  throw new Error(`Scheduler signal command '${command.id}' target '${target}' was not found.`);
}

function isOpenSignalWait(snapshot: SchedulerSnapshot, nodeKey: string): boolean {
  return snapshot.projection.signalWaits[nodeKey]?.status === "awaiting"
    && snapshot.projection.instances[nodeKey]?.status === "awaiting";
}

function commandTarget(command: PendingRunControlCommand): string | undefined {
  const payload = commandInputPayload(command);
  if (!isRecord(payload)) return undefined;
  return typeof payload.target === "string" && payload.target.length > 0 ? payload.target : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unwrapStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}

function commandInputPayload(command: PendingRunControlCommand): JsonValue | undefined {
  return command.status === "pending" || command.status === "running" ? command.payload : undefined;
}
