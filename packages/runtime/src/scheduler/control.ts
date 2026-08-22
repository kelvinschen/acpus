import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { tryNormalizeSignalPayload } from "../admission/input.js";
import { compactSchemaSummary } from "../schema-summary.js";
import type { RuntimeStoreBusy, RuntimeStoreShape } from "../store/service.js";
import { resolveOccurrenceRef } from "./occurrence-ref.js";
import type { SchedulerSnapshot, SchedulerStoreError } from "./store-port.js";
import type { SchedulerSteerProof } from "./store-port.js";
import { settleFrozenRunTransitions } from "./runtime-runner.js";

export type RunControlIntent =
  | { requestId: string; runId: string; type: "pause" }
  | { requestId: string; runId: string; type: "resume" }
  | { requestId: string; runId: string; type: "retry"; target: string }
  | { requestId: string; runId: string; type: "cancel"; target?: string }
  | { requestId: string; runId: string; type: "steer"; target: string; instruction: string }
  | { requestId: string; runId: string; type: "signal"; node: string; payload: JsonValue; commandIdempotencyKey?: string };

export type SchedulerControlEffect =
  | { type: "pause"; state: "applied" }
  | { type: "resume"; state: "applied" }
  | { type: "retry"; state: "applied"; target: string }
  | { type: "cancel"; state: "applied"; target?: string }
  | {
    type: "steer";
    state: "applied";
    steerId: string;
    requestedTarget: string;
    target: string;
    delivery: "interrupt_continue";
    fencedAttemptId: string;
    continuation: "queued";
  }
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
  observationFence?: {
    runId: string;
    attemptId: string;
    eventSequence: number;
    committedAt: string;
    reason: string;
  };
};

export type SchedulerControlFailure = SchedulerStoreError
  | { type: "signal-target-not-found"; runId: string; target: string; message: string }
  | { type: "signal-target-ambiguous"; runId: string; target: string; candidateKeys: string[]; message: string }
  | { type: "signal-payload-invalid"; runId: string; target: string; message: string };

export function applySchedulerControlIntent(
  store: RuntimeStoreShape,
  intent: RunControlIntent,
  ownerEpoch: number,
  steerProof?: SchedulerSteerProof,
): Effect.Effect<SchedulerControlResult, SchedulerControlFailure | RuntimeStoreBusy> {
  return Effect.gen(function* () {
  const runId = intent.runId;
  const idempotencyKey = `scheduler:control:${intent.requestId}`;
  if (intent.type === "pause") {
    const snapshot = yield* store.scheduler.tryPauseRun({ runId, ownerEpoch, idempotencyKey });
    return {
      snapshot,
      effect: { type: "pause", state: "applied" } as const,
      reopened: false,
    };
  }
  if (intent.type === "cancel" && intent.target === undefined) {
    const snapshot = yield* store.scheduler.tryCancel({ runId, ownerEpoch, idempotencyKey });
    return {
      snapshot,
      effect: { type: "cancel", state: "applied" } as const,
      reopened: false,
    };
  }
  if (intent.type === "retry") {
    const planned = yield* store.scheduler.tryPlanRetry({ runId, idempotencyKey, target: intent.target });
    if (planned.sessions.length > 0) {
      return yield* Effect.fail({
        type: "retry-neutralization-mismatch" as const,
        runId,
        expectedAgentSessionIds: planned.sessions.map(session => session.agentSessionId),
        actualAgentSessionIds: [],
        message: `Retry target '${intent.target}' requires Agent Session neutralization.`,
      });
    }
    if (planned.duplicate) {
      return {
        snapshot: planned.snapshot,
        effect: { type: "retry", state: "applied", target: intent.target },
        reopened: false,
      };
    }
    const snapshot = yield* store.scheduler.tryCommitRetry({
      runId,
      ownerEpoch,
      idempotencyKey,
      target: intent.target,
      expectedVersion: planned.snapshot.version,
      neutralizedAgentSessionIds: [],
    });
    return {
      snapshot,
      effect: { type: "retry", state: "applied", target: intent.target } as const,
      reopened: snapshot.version > planned.snapshot.version,
    };
  }
  if (intent.type === "steer") {
    const applied = yield* store.scheduler.trySteerAgent({
      runId,
      ownerEpoch,
      idempotencyKey,
      steerId: intent.requestId,
      target: intent.target,
      instruction: intent.instruction,
      ...(steerProof === undefined ? {} : { proof: steerProof }),
    });
    return {
      snapshot: applied.snapshot,
      effect: {
        type: "steer",
        state: "applied",
        steerId: applied.steerId,
        requestedTarget: applied.requestedTarget,
        target: applied.target,
        delivery: "interrupt_continue",
        fencedAttemptId: applied.fencedAttemptId,
        continuation: "queued",
      } as const,
      reopened: false,
      observationFence: {
        runId,
        attemptId: applied.fencedAttemptId,
        eventSequence: applied.fenceEventSequence,
        committedAt: applied.fencedAt,
        reason: "operator_steered",
      },
    };
  }

  const snapshot = yield* settleFrozenRunTransitions({ store, runId, ownerEpoch });

  if (intent.type === "resume") {
    const resumed = yield* store.scheduler.tryResumeRun({ runId, ownerEpoch, idempotencyKey });
    return {
      snapshot: resumed,
      effect: { type: "resume", state: "applied" } as const,
      reopened: resumed.version > snapshot.version,
    };
  }
  if (intent.type === "cancel") {
    const target = intent.target;
    const next = yield* store.scheduler.tryCancel({ runId, ownerEpoch, idempotencyKey, ...(target === undefined ? {} : { target }) });
    return {
      snapshot: next,
      effect: { type: "cancel", state: "applied", ...(target === undefined ? {} : { target }) } as const,
      reopened: false,
    };
  }
  if (intent.type === "signal") {
    const frozen = yield* store.getFrozenRun(runId);
    if (!frozen) return yield* Effect.fail({ type: "run-not-found" as const, runId, message: `Run '${runId}' was not found.` });
    const signal = resolveSignalPayload(intent, snapshot);
    if (Result.isFailure(signal)) {
      if (signal.failure.type === "signal-target-not-found" && !looksLikeInstanceKey(intent.node) && !hasSignalNode(frozen.ir, intent.node)) {
        return yield* Effect.fail({ type: "signal-target-not-found" as const, runId, target: intent.node, message: `Signal node '${intent.node}' was not found.` });
      }
      return yield* Effect.fail(signal.failure);
    }
    const normalized = tryNormalizeSignalPayload(frozen.ir, signal.success.nodeId, signal.success.payload);
    if (Result.isFailure(normalized)) {
      return yield* Effect.fail({ type: "signal-payload-invalid" as const, runId, target: intent.node, message: normalized.failure.message });
    }
    const validation = signalValidation(frozen.ir, signal.success.nodeId);
    const applied = yield* store.scheduler.tryConsumeSignal({
      runId,
      ownerEpoch,
      nodeKey: signal.success.nodeKey,
      requestedTarget: intent.node,
      payload: normalized.success,
      commandIdempotencyKey: intent.commandIdempotencyKey ?? intent.requestId,
      idempotencyKey,
    });
    return {
      snapshot: applied,
      effect: {
        type: "signal",
        state: "consumed",
        requestedTarget: intent.node,
        target: signal.success.nodeKey,
        validation,
      } as const,
      reopened: false,
    };
  }
  return assertNever(intent);
  });
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
): Result.Result<{ nodeKey: string; nodeId: string; payload: JsonValue }, Extract<SchedulerControlFailure, { type: "signal-target-not-found" | "signal-target-ambiguous" }>> {
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
    return Result.succeed({ nodeKey: duplicate.nodeKey, nodeId: duplicate.nodeId, payload: intent.payload });
  }
  const occurrence = resolveOccurrenceRef(snapshot.projection, target, { attempt: "reject" });
  if (occurrence && !occurrence.ok) {
    if (occurrence.error.type === "occurrence-ref-collision") {
      return ambiguousSignal(intent, occurrence.error.candidateKeys);
    }
    const suffix = occurrence.error.type === "occurrence-ref-attempt-not-allowed"
      ? ` selects attempt ${occurrence.error.attemptNo}; signal the occurrence without an attempt suffix`
      : " was not found";
    return Result.fail({
      type: "signal-target-not-found",
      runId: intent.runId,
      target,
      message: `Scheduler signal control request '${intent.requestId}' target '${target}'${suffix}.`,
    });
  }
  if (occurrence?.value.kind === "frame") {
    return Result.fail({
      type: "signal-target-not-found",
      runId: intent.runId,
      target,
      message: `Scheduler signal control request '${intent.requestId}' target '${target}' resolves to a frame, not a Signal occurrence.`,
    });
  }
  const resolvedTarget = occurrence?.value.nodeKey ?? target;
  if (isOpenSignalWait(snapshot, resolvedTarget)) {
    return Result.succeed({
      nodeKey: resolvedTarget,
      nodeId: snapshot.projection.signalWaits[resolvedTarget]!.nodeId,
      payload: intent.payload,
    });
  }
  const matches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => occurrence === undefined
      && wait.nodeId === target
      && isOpenSignalWait(snapshot, wait.nodeKey))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (matches.length === 1) return Result.succeed({ nodeKey: matches[0]!.nodeKey, nodeId: matches[0]!.nodeId, payload: intent.payload });
  if (matches.length > 1) return ambiguousSignal(intent, matches.map(wait => wait.nodeKey));
  const consumedMatches = Object.values(snapshot.projection.signalWaits)
    .filter(wait => wait.status === "consumed"
      && (wait.nodeKey === resolvedTarget
        || (occurrence === undefined && wait.nodeId === target)))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  if (consumedMatches.length === 1) return Result.succeed({ nodeKey: consumedMatches[0]!.nodeKey, nodeId: consumedMatches[0]!.nodeId, payload: intent.payload });
  if (consumedMatches.length > 1) return ambiguousSignal(intent, consumedMatches.map(wait => wait.nodeKey));
  return Result.fail({
    type: "signal-target-not-found",
    runId: intent.runId,
    target,
    message: `Scheduler signal control request '${intent.requestId}' target '${target}' was not found.`,
  });
}

function ambiguousSignal(
  intent: Extract<RunControlIntent, { type: "signal" }>,
  candidateKeys: string[],
): Result.Result<never, Extract<SchedulerControlFailure, { type: "signal-target-ambiguous" }>> {
  return Result.fail({
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
  return value.startsWith("@") || /~[0-9a-f]{8}$/i.test(value);
}

function isOpenSignalWait(snapshot: SchedulerSnapshot, nodeKey: string): boolean {
  return snapshot.projection.signalWaits[nodeKey]?.status === "awaiting"
    && snapshot.projection.instances[nodeKey]?.status === "awaiting";
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler control intent: ${String(value)}`);
}
