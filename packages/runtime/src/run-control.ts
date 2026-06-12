import type { AcpusIr } from "@acpus/core";
import type { NodeExecutionState, NodeState } from "./types.js";
import { isNodeKeyBelowAnyAnchor } from "./keys.js";
import { RunStore } from "./store.js";
import {
  canTransition,
  cancelPendingForRunCancel,
  resetCancelledForRunRetry,
  resetAwaitingForCrashRecovery,
  resetFailedForRetry,
  resetPausedForRunResume,
  resetRunningForCrashRecovery,
  transition
} from "./state-machine.js";

export type RunControlAbortState = "paused" | "cancelled";

export const PAUSED_ABORT_ERROR = "Aborted: paused";

export function abortedNodeError(state: RunControlAbortState): string {
  return state === "paused" ? PAUSED_ABORT_ERROR : "Aborted: cancelled";
}

export function isPausedContinuationState(state: NodeExecutionState | undefined): boolean {
  return state?.state === "pending" && state.attempt > 0 && state.error === PAUSED_ABORT_ERROR;
}

export interface NodeRetryPreparation {
  state: NodeExecutionState;
  ir: AcpusIr;
  input: Record<string, unknown>;
}

export class RunControl {
  /** Active abort controllers keyed by "runId:nodeKey" for pause/cancel support. */
  private readonly abortControllers: Map<string, AbortController> = new Map();

  /** Intent of an in-flight abort keyed by "runId:nodeKey" (pause vs cancel). */
  private readonly abortIntents: Map<string, RunControlAbortState> = new Map();

  /** Per-run scheduling guards used to stop new work after pause/cancel. */
  private readonly schedulingPaused = new Map<string, boolean>();
  private readonly schedulingCancelled = new Map<string, boolean>();

  constructor(private readonly store: RunStore) {}

  registerAbortController(runId: string, nodeKey: string, controller: AbortController): void {
    this.abortControllers.set(this.key(runId, nodeKey), controller);
  }

  clearInFlightNode(runId: string, nodeKey: string): void {
    this.abortControllers.delete(this.key(runId, nodeKey));
    this.abortIntents.delete(this.key(runId, nodeKey));
  }

  clearSchedulingGuards(runId: string): void {
    this.schedulingPaused.delete(runId);
    this.schedulingCancelled.delete(runId);
  }

  recoverStaleNodes(runId: string): void {
    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        nodeState.state = resetRunningForCrashRecovery(nodeState.state);
        this.store.writeNodeState(runId, nodeState);
      } else if (nodeState.state === "awaiting") {
        nodeState.state = resetAwaitingForCrashRecovery(nodeState.state);
        this.store.writeNodeState(runId, nodeState);
      }
    }
  }

  prepareNodeRetry(runId: string, nodeKey: string): NodeRetryPreparation {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state) {
      throw new Error(`Node ${nodeKey} not found in run ${runId}`);
    }
    if (state.state !== "failed") {
      throw new Error(
        `Cannot retry node ${nodeKey} in state '${state.state}': only failed executable nodes are retryable`
      );
    }
    if (state.kind !== "run.agent" && state.kind !== "run.program") {
      throw new Error(`Cannot retry node ${nodeKey}: only failed executable nodes are retryable`);
    }
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "failed") {
      throw new Error(`Cannot retry node ${nodeKey}: node retry is accepted only when the Run is failed`);
    }

    const ir = this.store.readIr(runId);
    const input = this.store.readInput(runId);
    if (!ir || !input) {
      throw new Error(`Cannot retry node ${nodeKey}: run ${runId} has no persisted IR or input`);
    }

    return { state, ir, input };
  }

  resetNodeForRetry(runId: string, state: NodeExecutionState): void {
    state.state = resetFailedForRetry(state.state);
    state.error = undefined;
    this.store.writeNodeState(runId, state);
  }

  pauseRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "running") {
      throw new Error(`Cannot pause a run in state '${meta.status}'`);
    }

    this.schedulingPaused.set(runId, true);

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running") {
        this.pauseRunningNode(runId, nodeState.nodeKey);
      }
    }

    meta.status = "paused";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  cancelRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "running" && meta.status !== "paused") {
      throw new Error(`Cannot cancel a run in state '${meta.status}'`);
    }

    this.schedulingCancelled.set(runId, true);

    for (const [key, intent] of this.abortIntents) {
      if (key.startsWith(`${runId}:`) && intent === "paused") {
        this.abortIntents.set(key, "cancelled");
      }
    }

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "running" || nodeState.state === "awaiting") {
        this.cancelMaterializedNode(runId, nodeState.nodeKey);
      }
    }

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "paused" && canTransition(nodeState.state, "cancelled")) {
        nodeState.state = transition(nodeState.state, "cancelled") as NodeState;
        this.store.writeNodeState(runId, nodeState);
      }
    }

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "pending") {
        nodeState.state = cancelPendingForRunCancel(nodeState.state);
        this.store.writeNodeState(runId, nodeState);
      }
    }

    meta.status = "cancelled";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  resumeRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "paused") {
      throw new Error(`Cannot resume a run in state '${meta.status}'`);
    }

    this.clearSchedulingGuards(runId);
    this.recoverStaleNodes(runId);

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "paused") {
        nodeState.state = resetPausedForRunResume(nodeState.state);
        this.store.writeNodeState(runId, nodeState);
      }
    }

    meta.status = "running";
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  retryRun(runId: string): void {
    const meta = this.store.readRunMeta(runId);
    if (!meta) throw new Error(`Run ${runId} not found`);
    if (meta.status !== "failed") {
      throw new Error(`Cannot retry a run in state '${meta.status}'`);
    }

    this.clearSchedulingGuards(runId);

    for (const nodeState of this.store.listNodeStates(runId)) {
      if (nodeState.state === "failed") {
        nodeState.state = resetFailedForRetry(nodeState.state);
        this.clearAttemptFields(nodeState);
        this.store.writeNodeState(runId, nodeState);
      } else if (nodeState.state === "paused") {
        nodeState.state = resetPausedForRunResume(nodeState.state);
        this.clearAttemptFields(nodeState);
        this.store.writeNodeState(runId, nodeState);
      } else if (nodeState.state === "cancelled") {
        nodeState.state = resetCancelledForRunRetry(nodeState.state);
        this.clearAttemptFields(nodeState);
        this.store.writeNodeState(runId, nodeState);
      }
    }

    meta.status = "running";
    meta.output = undefined;
    meta.error = undefined;
    meta.runAttempt++;
    meta.updatedAt = new Date().toISOString();
    this.store.writeRunMeta(runId, meta);
  }

  applySchedulingGuard(runId: string, state: NodeExecutionState): RunControlAbortState | undefined {
    if (this.schedulingPaused.get(runId) && state.state === "pending") {
      return "paused";
    }
    if (this.schedulingCancelled.get(runId) && state.state === "pending") {
      state.state = cancelPendingForRunCancel(state.state);
      this.store.writeNodeState(runId, state);
      return "cancelled";
    }
    return undefined;
  }

  abortIntent(runId: string, nodeKey: string): RunControlAbortState {
    return this.abortIntents.get(this.key(runId, nodeKey)) ?? "paused";
  }

  readAbortedStateOnDisk(runId: string, nodeKey: string): RunControlAbortState | undefined {
    const state = this.store.readNodeState(runId, nodeKey)?.state;
    return state === "paused" || state === "cancelled" ? state : undefined;
  }

  isStaleAttemptOnDisk(runId: string, nodeKey: string, attempt: number, startedAt: string | undefined): boolean {
    const current = this.store.readNodeState(runId, nodeKey);
    return current !== undefined && current.attempt > attempt && current.startedAt !== startedAt;
  }

  syncInFrameAttemptFromDisk(runId: string, nodeKey: string, state: NodeExecutionState): void {
    const current = this.store.readNodeState(runId, nodeKey);
    if (current !== undefined && current.startedAt === state.startedAt && current.attempt > state.attempt) {
      state.attempt = current.attempt;
    }
  }

  cancelDescendantsInScope(runId: string, rootNodeKey: string): void {
    this.descendantsInScope(runId, rootNodeKey, (rid, key) => this.cancelMaterializedNode(rid, key));
  }

  private pauseRunningNode(runId: string, nodeKey: string): void {
    const state = this.store.readNodeState(runId, nodeKey);
    if (!state || !canTransition(state.state, "paused")) {
      return;
    }
    this.abortIntents.set(this.key(runId, nodeKey), "paused");
    this.abortControllers.get(this.key(runId, nodeKey))?.abort();

    state.state = transition(state.state, "paused") as NodeState;
    this.store.writeNodeState(runId, state);
  }

  private cancelMaterializedNode(runId: string, nodeKey: string): void {
    this.abortIntents.set(this.key(runId, nodeKey), "cancelled");
    this.abortControllers.get(this.key(runId, nodeKey))?.abort();

    const state = this.store.readNodeState(runId, nodeKey);
    if (state?.state === "pending") {
      state.state = cancelPendingForRunCancel(state.state);
      this.store.writeNodeState(runId, state);
    } else if (state && canTransition(state.state, "cancelled")) {
      state.state = transition(state.state, "cancelled") as NodeState;
      this.store.writeNodeState(runId, state);
    }
  }

  private descendantsInScope(
    runId: string,
    rootNodeKey: string,
    action: (runId: string, nodeKey: string) => void
  ): void {
    const states = this.store.listNodeStates(runId);

    for (const nodeState of states) {
      if (nodeState.state !== "running" && nodeState.state !== "awaiting" && nodeState.state !== "pending") continue;
      if (!isNodeKeyBelowAnyAnchor(nodeState.nodeKey, [rootNodeKey])) continue;
      action(runId, nodeState.nodeKey);
    }
  }

  private key(runId: string, nodeKey: string): string {
    return `${runId}:${nodeKey}`;
  }

  private clearAttemptFields(state: NodeExecutionState): void {
    state.startedAt = undefined;
    state.completedAt = undefined;
    state.error = undefined;
    state.output = undefined;
    state.artifactRefs = undefined;
    state.dynamicContext = undefined;
    state.agentTelemetry = undefined;
  }
}
