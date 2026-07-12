import type { JsonValue } from "@acpus/expression/ir";
import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import { normalizeSignalPayload } from "../admission/input.js";
import { compactSchemaSummary } from "../schema-summary.js";
import type { RuntimeStore } from "../store/store.js";
import { SchedulerControlInputError, throwSchedulerStoreResult, type SchedulerSnapshot, type SchedulerStoreResult } from "./store-port.js";
import { settleFrozenRunTransitions } from "./runtime-runner.js";

export type RunControlIntent =
  | { requestId: string; runId: string; type: "pause" }
  | { requestId: string; runId: string; type: "resume" }
  | { requestId: string; runId: string; type: "retry"; target?: string }
  | { requestId: string; runId: string; type: "cancel"; target?: string }
  | { requestId: string; runId: string; type: "signal"; node: string; payload: JsonValue; commandIdempotencyKey?: string };

export type SchedulerControlEffect =
  | { type: "pause"; state: "applied" }
  | { type: "resume"; state: "applied" }
  | { type: "retry"; state: "applied"; target?: string }
  | { type: "cancel"; state: "applied"; target?: string }
  | {
    type: "signal";
    state: "consumed";
    requestedTarget: string;
    target: string;
    validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
  };

export type SchedulerControlResult = {
  snapshot: SchedulerSnapshot;
  effect: SchedulerControlEffect;
};

export function applySchedulerControlIntent(
  store: RuntimeStore,
  intent: RunControlIntent,
  ownerEpoch: number,
): SchedulerControlResult {
  const runId = intent.runId;
  const idempotencyKey = `scheduler:control:${intent.requestId}`;
  const snapshot = settleFrozenRunTransitions({ store, runId, ownerEpoch });
  if (intent.type === "pause") {
    return {
      snapshot: unwrapStoreResult(store.scheduler.tryPauseRun({ runId, ownerEpoch, idempotencyKey })),
      effect: { type: "pause", state: "applied" },
    };
  }
  if (intent.type === "resume") {
    return {
      snapshot: unwrapStoreResult(store.scheduler.tryResumeRun({ runId, ownerEpoch, idempotencyKey })),
      effect: { type: "resume", state: "applied" },
    };
  }
  if (intent.type === "retry") {
    const target = intent.target;
    const applied = target === undefined
      ? unwrapStoreResult(store.scheduler.tryRetryRun({ runId, ownerEpoch, idempotencyKey }))
      : unwrapStoreResult(store.scheduler.tryRetry({ runId, ownerEpoch, idempotencyKey, target }));
    return {
      snapshot: applied,
      effect: { type: "retry", state: "applied", ...(target === undefined ? {} : { target }) },
    };
  }
  if (intent.type === "cancel") {
    const target = intent.target;
    return {
      snapshot: unwrapStoreResult(store.scheduler.tryCancel({
        runId,
        ownerEpoch,
        idempotencyKey,
        ...(target === undefined ? {} : { target }),
      })),
      effect: { type: "cancel", state: "applied", ...(target === undefined ? {} : { target }) },
    };
  }
  if (intent.type === "signal") {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' was not found.`);
    let signal: ReturnType<typeof signalPayload>;
    try {
      signal = signalPayload(intent, snapshot);
    } catch (error) {
      if (!looksLikeInstanceKey(intent.node) && !hasSignalNode(frozen.ir, intent.node)) throw new SchedulerControlInputError(`Signal node '${intent.node}' was not found.`);
      throw error;
    }
    let normalized: JsonValue;
    try {
      normalized = normalizeSignalPayload(frozen.ir, signal.nodeId, signal.payload);
    } catch (error) {
      throw new SchedulerControlInputError(error instanceof Error ? error.message : String(error));
    }
    const validation = signalValidation(frozen.ir, signal.nodeId);
    const applied = unwrapStoreResult(store.scheduler.tryConsumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.nodeKey,
      payload: normalized,
      commandIdempotencyKey: intent.commandIdempotencyKey ?? intent.requestId,
      idempotencyKey,
    }));
    return {
      snapshot: applied,
      effect: {
        type: "signal",
        state: "consumed",
        requestedTarget: intent.node,
        target: signal.nodeKey,
        validation,
      },
    };
  }
  return assertNever(intent);
}

function signalValidation(ir: WorkflowIR, nodeId: string): Extract<SchedulerControlEffect, { type: "signal" }>["validation"] {
  for (const { node } of walkNodes(ir.root)) {
    if (node.kind !== "signal" || node.id !== nodeId) continue;
    return node.outputSchema === undefined
      ? { kind: "raw-string" }
      : { kind: "schema", schemaSummary: compactSchemaSummary(node.outputSchema) };
  }
  throw new Error(`Signal node '${nodeId}' was not found in frozen workflow IR.`);
}

function signalPayload(intent: Extract<RunControlIntent, { type: "signal" }>, snapshot: SchedulerSnapshot): { nodeKey: string; nodeId: string; payload: JsonValue } {
  const target = intent.node;
  if (isOpenSignalWait(snapshot, target)) return { nodeKey: target, nodeId: snapshot.projection.signalWaits[target]!.nodeId, payload: intent.payload };
  const matches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.nodeId === target && isOpenSignalWait(snapshot, wait.nodeKey))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (matches.length === 1) return { nodeKey: matches[0]!.nodeKey, nodeId: matches[0]!.nodeId, payload: intent.payload };
  if (matches.length > 1) throw new SchedulerControlInputError(`Scheduler signal control request '${intent.requestId}' target '${target}' is ambiguous. Candidate nodeKeys: ${matches.map(wait => wait.nodeKey).join(", ")}.`);
  const consumedMatches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.status === "consumed" && (wait.nodeKey === target || wait.nodeId === target))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (consumedMatches.length === 1) return { nodeKey: consumedMatches[0]!.nodeKey, nodeId: consumedMatches[0]!.nodeId, payload: intent.payload };
  if (consumedMatches.length > 1) throw new SchedulerControlInputError(`Scheduler signal control request '${intent.requestId}' target '${target}' is ambiguous. Candidate nodeKeys: ${consumedMatches.map(wait => wait.nodeKey).join(", ")}.`);
  const duplicate = Object.values(snapshot.projection.signalWaits)
    .find(wait => wait.commandIdempotencyKey === (intent.commandIdempotencyKey ?? intent.requestId));
  if (duplicate) return { nodeKey: duplicate.nodeKey, nodeId: duplicate.nodeId, payload: intent.payload };
  throw new SchedulerControlInputError(`Scheduler signal control request '${intent.requestId}' target '${target}' was not found.`);
}

function hasSignalNode(ir: WorkflowIR, nodeId: string): boolean {
  for (const { node } of walkNodes(ir.root)) {
    if (node.kind === "signal" && node.id === nodeId) return true;
  }
  return false;
}

function looksLikeInstanceKey(value: string): boolean {
  return /~[0-9a-f]{12}$/i.test(value);
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
