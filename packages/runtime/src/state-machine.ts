import type { IrNodeKind } from "@acpus/core";
import type { NodeExecutionState, NodeState } from "./types.js";

// ─── Legal transitions ───────────────────────────────────────────
//
// This table models only the *business lifecycle* of a Node. Control-plane
// resets (operator retry, crash recovery) are NOT transitions here — they are
// reset operations exposed via dedicated helpers below, so that no generic
// `canTransition(x, "pending")` call can accidentally gain retry/reset rights.

const TRANSITIONS: Record<NodeState, Set<NodeState>> = {
  pending: new Set(["running"]),
  running: new Set(["completed", "failed", "paused", "cancelled"]),
  paused: new Set(["running", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

/** Check if a transition from `from` to `to` is legal. */
export function canTransition(from: NodeState, to: NodeState): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * Transition a node state. Throws if the transition is illegal.
 * Returns the new state.
 */
export function transition(from: NodeState, to: NodeState): NodeState {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal state transition: ${from} → ${to}`);
  }
  return to;
}

/** Check if a state is terminal (no further business-lifecycle transitions). */
export function isTerminal(state: NodeState): boolean {
  return TRANSITIONS[state].size === 0;
}

// ─── Control-plane resets ────────────────────────────────────────
//
// These are NOT business-lifecycle transitions. They are explicit reset
// operations invoked only from dedicated control entry points, so the
// generic state machine never exposes a path back to `pending`.

/** Control-plane reset: operator retry of a failed node (failed → pending). */
export function resetFailedForRetry(from: NodeState): NodeState {
  if (from !== "failed") {
    throw new Error(`Cannot retry node in state '${from}': only failed nodes are retryable`);
  }
  return "pending";
}

/** Control-plane reset: crash recovery of a stale running node (running → pending). */
export function resetRunningForCrashRecovery(from: NodeState): NodeState {
  if (from !== "running") {
    throw new Error(`Cannot recover stale node in state '${from}': only running nodes can be reset`);
  }
  return "pending";
}

/** Create the initial NodeExecutionState for a node. */
export function createInitialNodeState(
  nodeKey: string,
  nodeId: string,
  kind: IrNodeKind
): NodeExecutionState {
  return {
    nodeKey,
    nodeId,
    kind,
    state: "pending",
    attempt: 0
  };
}
