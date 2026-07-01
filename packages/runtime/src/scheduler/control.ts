import type { JsonValue } from "@acpus/expression/ir";
import { normalizeSignalPayload } from "../admission/input.js";
import type { PendingControlCommand, RuntimeStore } from "../store/store.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { advanceFrozenRun } from "./runtime-runner.js";
import type { AdvanceRunSummary } from "./advance.js";

export type AppliedSchedulerControlCommand = {
  command: PendingControlCommand;
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
  command: PendingControlCommand,
  options: ApplySchedulerControlCommandOptions = {},
): Promise<AppliedSchedulerControlCommand> {
  if (command.status === "applied") return appliedCommandResult(store, command);
  if (options.claimCommand !== false && !store.claimCommand(command.id, options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration })) {
    const current = store.getCommand(command.id);
    if (current?.status === "applied") return appliedCommandResult(store, current);
    throw new Error(`Command '${command.id}' is already ${current?.status ?? "missing"}.`);
  }
  try {
    return await applySchedulerControlCommandUnchecked(cwd, store, command, options);
  } catch (error) {
    store.finishCommand({
      id: command.id,
      status: "failed",
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

function appliedCommandResult(store: RuntimeStore, command: PendingControlCommand): AppliedSchedulerControlCommand {
  const runId = requireRunId(command);
  return { command, runId, snapshot: store.scheduler.loadRunSnapshot(runId) };
}

async function applySchedulerControlCommandUnchecked(
  cwd: string,
  store: RuntimeStore,
  command: PendingControlCommand,
  options: ApplySchedulerControlCommandOptions,
): Promise<AppliedSchedulerControlCommand> {
  const runId = requireRunId(command);
  const ownerId = options.ownerId ?? "scheduler-control";
  const leaseMs = options.leaseMs ?? 30_000;
  const claim = store.scheduler.claimRun(runId, ownerId, leaseMs);
  if (!claim) {
    store.deferCommand(command.id);
    return {
      command,
      runId,
      snapshot: store.scheduler.loadRunSnapshot(runId),
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
    return { command, runId, snapshot: store.scheduler.loadRunSnapshot(runId), advanced };
  }
  return { command, runId, snapshot };
}

function applySchedulerControlIntent(store: RuntimeStore, command: PendingControlCommand, runId: string, ownerEpoch: number): SchedulerSnapshot {
  const idempotencyKey = `scheduler:control:${command.id}`;
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  if (command.type === "pause") {
    const reason = commandReason(command);
    return store.scheduler.pauseRun({
      runId,
      ownerEpoch,
      idempotencyKey,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  if (command.type === "resume") {
    return store.scheduler.resumeRun({ runId, ownerEpoch, idempotencyKey });
  }
  if (command.type === "retry") {
    const node = commandNode(command);
    return node === undefined
      ? store.scheduler.retryRun({ runId, ownerEpoch, idempotencyKey })
      : store.scheduler.retry({ runId, ownerEpoch, idempotencyKey, nodeKey: retryNodeKey(node, command.id, snapshot) });
  }
  if (command.type === "signal") {
    const signal = signalPayload(command, snapshot);
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    const normalized = normalizeSignalPayload(frozen.ir, signal.nodeId, signal.payload);
    return store.scheduler.consumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.nodeKey,
      payload: normalized,
      commandIdempotencyKey: command.idempotencyKey,
      idempotencyKey,
    });
  }
  throw new Error(`Unsupported scheduler command type '${command.type}'.`);
}

function requireRunId(command: PendingControlCommand): string {
  if (!command.runId) throw new Error(`Command '${command.id}' has no run id.`);
  return command.runId;
}

function commandReason(command: PendingControlCommand): string | undefined {
  const payload = command.payload;
  if (!isRecord(payload)) return undefined;
  return typeof payload.reason === "string" && payload.reason.length > 0 ? payload.reason : undefined;
}

function retryNodeKey(target: string, commandId: string, snapshot: SchedulerSnapshot): string {
  if (snapshot.projection.instances[target]) return target;
  const matches = Object.values(snapshot.projection.instances)
    .filter(instance => instance.nodeId === target && instance.status === "failed")
    .map(instance => instance.nodeKey)
    .sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Scheduler retry command '${commandId}' target '${target}' is ambiguous. Candidate nodeKeys: ${matches.join(", ")}.`);
  throw new Error(`Scheduler retry command '${commandId}' target '${target}' was not found.`);
}

function signalPayload(command: PendingControlCommand, snapshot: SchedulerSnapshot): { nodeKey: string; nodeId: string; payload: JsonValue } {
  const payload = command.payload;
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
  throw new Error(`Scheduler signal command '${command.id}' target '${target}' was not found.`);
}

function isOpenSignalWait(snapshot: SchedulerSnapshot, nodeKey: string): boolean {
  return snapshot.projection.signalWaits[nodeKey]?.status === "awaiting"
    && snapshot.projection.instances[nodeKey]?.status === "awaiting";
}

function commandNode(command: PendingControlCommand): string | undefined {
  const payload = command.payload;
  if (!isRecord(payload)) return undefined;
  return typeof payload.node === "string" && payload.node.length > 0 ? payload.node : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
