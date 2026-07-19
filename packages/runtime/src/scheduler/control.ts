import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, type Result } from "neverthrow";
import { tryNormalizeSignalPayload } from "../admission/input.js";
import { compactSchemaSummary } from "../schema-summary.js";
import type { RuntimeStore } from "../store/store.js";
import { schedulerStoreError, type SchedulerSnapshot, type SchedulerStoreError } from "./store-port.js";
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
  reopened: boolean;
};

export type SchedulerControlFailure = SchedulerStoreError
  | { type: "signal-target-not-found"; runId: string; target: string; message: string }
  | { type: "signal-target-ambiguous"; runId: string; target: string; candidateKeys: string[]; message: string }
  | { type: "signal-payload-invalid"; runId: string; target: string; message: string };

export function applySchedulerControlIntent(
  store: RuntimeStore,
  intent: RunControlIntent,
  ownerEpoch: number,
): Result<SchedulerControlResult, SchedulerControlFailure> {
  const runId = intent.runId;
  const idempotencyKey = `scheduler:control:${intent.requestId}`;
  if (intent.type === "pause") {
    return store.scheduler.tryPauseRun({ runId, ownerEpoch, idempotencyKey }).map(snapshot => ({
      snapshot,
      effect: { type: "pause", state: "applied" } as const,
      reopened: false,
    }));
  }
  if (intent.type === "cancel" && intent.target === undefined) {
    return store.scheduler.tryCancel({ runId, ownerEpoch, idempotencyKey }).map(snapshot => ({
      snapshot,
      effect: { type: "cancel", state: "applied" } as const,
      reopened: false,
    }));
  }

  const settled = trySettleFrozenRunTransitions(store, runId, ownerEpoch);
  if (settled.isErr()) return err(settled.error);
  const snapshot = settled.value;

  if (intent.type === "resume") {
    return store.scheduler.tryResumeRun({ runId, ownerEpoch, idempotencyKey }).map(resumed => ({
      snapshot: resumed,
      effect: { type: "resume", state: "applied" } as const,
      reopened: resumed.version > snapshot.version,
    }));
  }
  if (intent.type === "retry") {
    const target = intent.target;
    const applied = target === undefined
      ? store.scheduler.tryRetryRun({ runId, ownerEpoch, idempotencyKey })
      : store.scheduler.tryRetry({ runId, ownerEpoch, idempotencyKey, target });
    return applied.map(next => ({
      snapshot: next,
      effect: { type: "retry", state: "applied", ...(target === undefined ? {} : { target }) } as const,
      reopened: next.version > snapshot.version,
    }));
  }
  if (intent.type === "cancel") {
    const target = intent.target;
    return store.scheduler.tryCancel({ runId, ownerEpoch, idempotencyKey, ...(target === undefined ? {} : { target }) }).map(next => ({
      snapshot: next,
      effect: { type: "cancel", state: "applied", ...(target === undefined ? {} : { target }) } as const,
      reopened: false,
    }));
  }
  if (intent.type === "signal") {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) return err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const signal = resolveSignalPayload(intent, snapshot);
    if (signal.isErr()) {
      if (signal.error.type === "signal-target-not-found" && !looksLikeInstanceKey(intent.node) && !hasSignalNode(frozen.ir, intent.node)) {
        return err({ type: "signal-target-not-found", runId, target: intent.node, message: `Signal node '${intent.node}' was not found.` });
      }
      return err(signal.error);
    }
    const normalized = tryNormalizeSignalPayload(frozen.ir, signal.value.nodeId, signal.value.payload);
    if (normalized.isErr()) {
      return err({ type: "signal-payload-invalid", runId, target: intent.node, message: normalized.error.message });
    }
    const validation = signalValidation(frozen.ir, signal.value.nodeId);
    return store.scheduler.tryConsumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.value.nodeKey,
      requestedTarget: intent.node,
      payload: normalized.value,
      commandIdempotencyKey: intent.commandIdempotencyKey ?? intent.requestId,
      idempotencyKey,
    }).map(applied => ({
      snapshot: applied,
      effect: {
        type: "signal",
        state: "consumed",
        requestedTarget: intent.node,
        target: signal.value.nodeKey,
        validation,
      } as const,
      reopened: false,
    }));
  }
  return assertNever(intent);
}

function trySettleFrozenRunTransitions(store: RuntimeStore, runId: string, ownerEpoch: number): Result<SchedulerSnapshot, SchedulerStoreError> {
  try {
    return ok(settleFrozenRunTransitions({ store, runId, ownerEpoch }));
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (failure) return err(failure);
    throw error;
  }
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

export function resolveSignalPayload(
  intent: Extract<RunControlIntent, { type: "signal" }>,
  snapshot: SchedulerSnapshot,
): Result<{ nodeKey: string; nodeId: string; payload: JsonValue }, Extract<SchedulerControlFailure, { type: "signal-target-not-found" | "signal-target-ambiguous" }>> {
  const target = intent.node;
  const commandIdempotencyKey = intent.commandIdempotencyKey ?? intent.requestId;
  const duplicates = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.commandIdempotencyKey === commandIdempotencyKey)
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (duplicates.length > 1) {
    throw new Error(`Signal command idempotency key '${commandIdempotencyKey}' is bound to multiple waits.`);
  }
  if (duplicates.length === 1) {
    const duplicate = duplicates[0]!;
    if (duplicate.status !== "consumed") {
      throw new Error(`Signal command idempotency key '${commandIdempotencyKey}' is bound to a non-consumed wait.`);
    }
    return ok({ nodeKey: duplicate.nodeKey, nodeId: duplicate.nodeId, payload: intent.payload });
  }
  if (isOpenSignalWait(snapshot, target)) return ok({ nodeKey: target, nodeId: snapshot.projection.signalWaits[target]!.nodeId, payload: intent.payload });
  const matches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.nodeId === target && isOpenSignalWait(snapshot, wait.nodeKey))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (matches.length === 1) return ok({ nodeKey: matches[0]!.nodeKey, nodeId: matches[0]!.nodeId, payload: intent.payload });
  if (matches.length > 1) return ambiguousSignal(intent, matches.map(wait => wait.nodeKey));
  const consumedMatches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.status === "consumed" && (wait.nodeKey === target || wait.nodeId === target))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (consumedMatches.length === 1) return ok({ nodeKey: consumedMatches[0]!.nodeKey, nodeId: consumedMatches[0]!.nodeId, payload: intent.payload });
  if (consumedMatches.length > 1) return ambiguousSignal(intent, consumedMatches.map(wait => wait.nodeKey));
  return err({
    type: "signal-target-not-found",
    runId: intent.runId,
    target,
    message: `Scheduler signal control request '${intent.requestId}' target '${target}' was not found.`,
  });
}

function ambiguousSignal(
  intent: Extract<RunControlIntent, { type: "signal" }>,
  candidateKeys: string[],
): Result<never, Extract<SchedulerControlFailure, { type: "signal-target-ambiguous" }>> {
  return err({
    type: "signal-target-ambiguous",
    runId: intent.runId,
    target: intent.node,
    candidateKeys,
    message: `Scheduler signal control request '${intent.requestId}' target '${intent.node}' is ambiguous. Candidate nodeKeys: ${candidateKeys.join(", ")}.`,
  });
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

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler control intent: ${String(value)}`);
}
