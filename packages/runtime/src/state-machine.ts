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
  running: new Set(["awaiting", "completed", "failed", "paused", "cancelled"]),
  // `awaiting` is a human-in-the-loop wait (e.g. an Approval Gate blocked on an
  // operator decision). It is distinct from `paused` (an operator-initiated
  // pause): a decision resolves it to `completed`, a cancel to `cancelled`.
  awaiting: new Set(["completed", "cancelled"]),
  // A paused Node is resumed by a Run-level control-plane reset back to
  // `pending`, not by a direct lifecycle transition to `running`.
  paused: new Set(["cancelled"]),
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

/** Control-plane reset: Run-level retry of a cancelled node in a failed Run (cancelled → pending). */
export function resetCancelledForRunRetry(from: NodeState): NodeState {
  if (from !== "cancelled") {
    throw new Error(`Cannot retry cancelled node from state '${from}': only cancelled nodes use Run-level cancelled reset`);
  }
  return "pending";
}

/** Control-plane reset: Run-level resume of a paused node (paused → pending). */
export function resetPausedForRunResume(from: NodeState): NodeState {
  if (from !== "paused") {
    throw new Error(`Cannot reset node in state '${from}': only paused nodes can be reset`);
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

/**
 * Control-plane reset: crash recovery of a stale awaiting node (awaiting → pending).
 * The in-memory approval resolver does not survive a supervisor restart, so a node
 * left in `awaiting` must be re-executed from scratch to re-register its resolver and
 * wait for a fresh human decision.
 */
export function resetAwaitingForCrashRecovery(from: NodeState): NodeState {
  if (from !== "awaiting") {
    throw new Error(`Cannot recover stale node in state '${from}': only awaiting nodes can be reset`);
  }
  return "pending";
}

/** Control-plane cancellation: Run-level cancel of a materialized pending node (pending → cancelled). */
export function cancelPendingForRunCancel(from: NodeState): NodeState {
  if (from !== "pending") {
    throw new Error(`Cannot cancel pending node from state '${from}': only pending nodes use Run-level pending cancel`);
  }
  return "cancelled";
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
