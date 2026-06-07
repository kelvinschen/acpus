/**
 * Control actions — map keypresses to supervisor control calls, guarding
 * client-side by state so we only attempt actions that can succeed.
 */

import type { RunSupervisorClient, NodeExecutionState, NodeState, RunStatus } from "@acpus/runtime";

export type ControlAction = "pause" | "resume" | "cancel" | "retry";

/** Whether a node-level action is applicable to a node in the given state. */
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

/** Whether a Run-level action is applicable to a Run in the given status. */
export function canApplyRun(action: ControlAction, status: RunStatus | undefined): boolean {
  switch (action) {
    case "pause":
    case "cancel":
      return status === "running";
    case "resume":
      return status === "paused";
    case "retry":
      return status === "failed";
    default:
      return false;
  }
}

/** Apply a Node-level control action. */
export async function applyControl(
  client: RunSupervisorClient,
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

/** Apply a Run-level control action. */
export async function applyRunControl(
  client: RunSupervisorClient,
  action: ControlAction,
  runId: string
): Promise<import("@acpus/runtime").RunState> {
  switch (action) {
    case "pause":
      return client.pauseRun(runId);
    case "resume":
      return client.resumeRun(runId);
    case "cancel":
      return client.cancelRun(runId);
    case "retry":
      return client.retryRun(runId);
  }
}
