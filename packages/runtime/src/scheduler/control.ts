import type { JsonValue } from "@acpus/expression/ir";
import type { WorkflowIR } from "@acpus/core/ir";
import { normalizeSignalPayload } from "../admission/input.js";
import type { RuntimeStore } from "../store/store.js";
import { throwSchedulerStoreResult, type SchedulerSnapshot, type SchedulerStoreResult } from "./store-port.js";
import { advanceFrozenRun, drainFrozenRunTransitions } from "./runtime-runner.js";
import type { AdvanceRunSummary } from "./advance.js";
import type { TaskAttemptRunner } from "../execution/task-process.js";

export type RunControlIntent =
  | { requestId: string; runId: string; type: "pause"; reason?: string }
  | { requestId: string; runId: string; type: "resume" }
  | { requestId: string; runId: string; type: "retry"; target?: string }
  | { requestId: string; runId: string; type: "cancel"; target?: string }
  | { requestId: string; runId: string; type: "signal"; node: string; payload: JsonValue; commandIdempotencyKey?: string };

export type AppliedSchedulerControlIntent = {
  intent: RunControlIntent;
  runId: string;
  snapshot: SchedulerSnapshot;
  advanced?: AdvanceRunSummary;
};

export type ApplySchedulerControlIntentOptions = {
  ownerId?: string;
  leaseMs?: number;
  advance?: boolean;
  taskAttemptRunner?: TaskAttemptRunner;
};

export class InvalidSignalPayloadError extends Error {
  constructor(readonly nodeId: string, message: string) {
    super(message);
  }
}

export async function applySchedulerControlIntent(
  cwd: string,
  store: RuntimeStore,
  intent: RunControlIntent,
  options: ApplySchedulerControlIntentOptions = {},
): Promise<AppliedSchedulerControlIntent> {
  const runId = intent.runId;
  const ownerId = options.ownerId ?? "scheduler-control";
  const leaseMs = options.leaseMs ?? 30_000;
  const claim = store.scheduler.claimRun(runId, ownerId, leaseMs);
  if (!claim) {
    return {
      intent,
      runId,
      snapshot: unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)),
      advanced: { status: "lease_lost", runId, started: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    };
  }

  let snapshot: SchedulerSnapshot;
  try {
    snapshot = applySchedulerControlProjection(store, intent, runId, claim.ownerEpoch);
  } finally {
    store.scheduler.releaseRun(claim);
  }

  if (intent.type !== "pause" && options.advance !== false) {
    const advanced = await advanceFrozenRun({
      cwd,
      store,
      runId,
      ownerId,
      leaseMs,
      ...(options.taskAttemptRunner === undefined ? {} : { taskAttemptRunner: options.taskAttemptRunner }),
    });
    return { intent, runId, snapshot: unwrapStoreResult(store.scheduler.tryLoadRunSnapshot(runId)), advanced };
  }
  return { intent, runId, snapshot };
}

export function applySchedulerControlIntentWithOwnerEpoch(
  store: RuntimeStore,
  intent: RunControlIntent,
  ownerEpoch: number,
): AppliedSchedulerControlIntent {
  const runId = intent.runId;
  return {
    intent,
    runId,
    snapshot: applySchedulerControlProjection(store, intent, runId, ownerEpoch),
  };
}

function applySchedulerControlProjection(store: RuntimeStore, intent: RunControlIntent, runId: string, ownerEpoch: number): SchedulerSnapshot {
  const idempotencyKey = `scheduler:control:${intent.requestId}`;
  const snapshot = drainFrozenRunTransitions({ store, runId, ownerEpoch });
  if (intent.type === "pause") {
    const reason = intent.reason;
    return unwrapStoreResult(store.scheduler.tryPauseRun({
      runId,
      ownerEpoch,
      idempotencyKey,
      ...(reason === undefined ? {} : { reason }),
    }));
  }
  if (intent.type === "resume") {
    return unwrapStoreResult(store.scheduler.tryResumeRun({ runId, ownerEpoch, idempotencyKey }));
  }
  if (intent.type === "retry") {
    const target = intent.target;
    return target === undefined
      ? unwrapStoreResult(store.scheduler.tryRetryRun({ runId, ownerEpoch, idempotencyKey }))
      : unwrapStoreResult(store.scheduler.tryRetry({ runId, ownerEpoch, idempotencyKey, targetKey: retryTargetKey(target, intent.requestId, snapshot) }));
  }
  if (intent.type === "cancel") {
    const target = intent.target;
    const targetKey = target === undefined ? undefined : cancelTargetKey(target, intent.requestId, snapshot);
    return unwrapStoreResult(store.scheduler.tryCancel({
      runId,
      ownerEpoch,
      idempotencyKey,
      ...(targetKey === undefined ? {} : { targetKey }),
    }));
  }
  if (intent.type === "signal") {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    let signal: ReturnType<typeof signalPayload>;
    try {
      signal = signalPayload(intent, snapshot);
    } catch (error) {
      if (!looksLikeInstanceKey(intent.node) && !hasSignalNode(frozen.ir, intent.node)) throw new Error(`Signal node '${intent.node}' was not found.`);
      throw error;
    }
    let normalized: JsonValue;
    try {
      normalized = normalizeSignalPayload(frozen.ir, signal.nodeId, signal.payload);
    } catch (error) {
      throw new InvalidSignalPayloadError(signal.nodeId, error instanceof Error ? error.message : String(error));
    }
    return unwrapStoreResult(store.scheduler.tryConsumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.nodeKey,
      payload: normalized,
      commandIdempotencyKey: intent.commandIdempotencyKey ?? intent.requestId,
      idempotencyKey,
    }));
  }
  return assertNever(intent);
}

function retryTargetKey(target: string, requestId: string, snapshot: SchedulerSnapshot): string {
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
  if (matches.length > 1) throw new Error(`Scheduler retry control request '${requestId}' target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`);
  return target;
}

function cancelTargetKey(target: string, requestId: string, snapshot: SchedulerSnapshot): string {
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
  if (matches.length > 1) throw new Error(`Scheduler cancel control request '${requestId}' target '${target}' is ambiguous. Candidate target keys: ${matches.join(", ")}.`);
  return target;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function signalPayload(intent: Extract<RunControlIntent, { type: "signal" }>, snapshot: SchedulerSnapshot): { nodeKey: string; nodeId: string; payload: JsonValue } {
  const target = intent.node;
  if (isOpenSignalWait(snapshot, target)) return { nodeKey: target, nodeId: snapshot.projection.signalWaits[target]!.nodeId, payload: intent.payload };
  const matches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.nodeId === target && isOpenSignalWait(snapshot, wait.nodeKey))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (matches.length === 1) return { nodeKey: matches[0]!.nodeKey, nodeId: matches[0]!.nodeId, payload: intent.payload };
  if (matches.length > 1) throw new Error(`Scheduler signal control request '${intent.requestId}' target '${target}' is ambiguous. Candidate nodeKeys: ${matches.map(wait => wait.nodeKey).join(", ")}.`);
  const consumedMatches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.status === "consumed" && (wait.nodeKey === target || wait.nodeId === target))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (consumedMatches.length === 1) return { nodeKey: consumedMatches[0]!.nodeKey, nodeId: consumedMatches[0]!.nodeId, payload: intent.payload };
  if (consumedMatches.length > 1) throw new Error(`Scheduler signal control request '${intent.requestId}' target '${target}' is ambiguous. Candidate nodeKeys: ${consumedMatches.map(wait => wait.nodeKey).join(", ")}.`);
  const duplicate = Object.values(snapshot.projection.signalWaits)
    .find(wait => wait.commandIdempotencyKey === (intent.commandIdempotencyKey ?? intent.requestId));
  if (duplicate) return { nodeKey: duplicate.nodeKey, nodeId: duplicate.nodeId, payload: intent.payload };
  throw new Error(`Scheduler signal control request '${intent.requestId}' target '${target}' was not found.`);
}

function hasSignalNode(ir: WorkflowIR, nodeId: string): boolean {
  return scopeHasSignalNode(ir.root, nodeId);
}

function looksLikeInstanceKey(value: string): boolean {
  return /~[0-9a-f]{12}$/i.test(value);
}

function scopeHasSignalNode(scope: WorkflowIR["root"], nodeId: string): boolean {
  for (const node of scope.nodes) {
    if (node.kind === "signal" && node.id === nodeId) return true;
    for (const child of childScopes(node)) {
      if (scopeHasSignalNode(child, nodeId)) return true;
    }
  }
  return false;
}

function childScopes(node: WorkflowIR["root"]["nodes"][number]): WorkflowIR["root"][] {
  if (node.kind === "if") return [node.then, ...(node.else ? [node.else] : [])];
  if (node.kind === "switch") return [...node.cases.map(item => item.then), ...(node.default ? [node.default] : [])];
  if (node.kind === "parallel") return Object.values(node.branches).map(branch => branch.scope);
  if (node.kind === "fanout" || node.kind === "loop") return [node.do];
  return [];
}

function isOpenSignalWait(snapshot: SchedulerSnapshot, nodeKey: string): boolean {
  return snapshot.projection.signalWaits[nodeKey]?.status === "awaiting"
    && snapshot.projection.instances[nodeKey]?.status === "awaiting";
}

function unwrapStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler control intent: ${String(value)}`);
}
