/**
 * Control actions — map keypresses to daemon node-control calls, guarding
 * client-side by node state so we only attempt actions that can succeed.
 */

import type { DaemonClient, NodeExecutionState, NodeState } from "@acpus/runtime";

export type ControlAction = "pause" | "resume" | "cancel" | "retry";

/** Whether an action is applicable to a node in the given state. */
export function canApply(action: ControlAction, state: NodeState | undefined): boolean {
  switch (action) {
    case "pause":
    case "cancel":
      return state === "running";
    case "resume":
      return state === "paused";
    case "retry":
      return state === "failed";
    default:
      return false;
  }
}

export async function applyControl(
  client: DaemonClient,
  action: ControlAction,
  runId: string,
  nodeKey: string
): Promise<NodeExecutionState> {
  switch (action) {
    case "pause":
      return client.pauseNode(runId, nodeKey);
    case "resume":
      return client.resumeNode(runId, nodeKey);
    case "cancel":
      return client.cancelNode(runId, nodeKey);
    case "retry":
      return client.retryNode(runId, nodeKey);
  }
}
