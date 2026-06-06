import type { IrNodeKind } from "@acpus/core";
import type { NodeExecutionState, NodeState } from "./types.js";

// ─── Legal transitions ───────────────────────────────────────────

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

/** Check if a state is terminal (no further transitions possible). */
export function isTerminal(state: NodeState): boolean {
  return TRANSITIONS[state].size === 0;
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
