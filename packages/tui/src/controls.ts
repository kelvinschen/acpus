/**
 * Control actions — map keypresses to supervisor control calls, guarding
 * client-side by state so we only attempt actions that can succeed.
 */

import type { RunSupervisorClient, NodeExecutionState, NodeState, RunStatus } from "@acpus/runtime";

export type ControlAction = "pause" | "resume" | "cancel" | "retry" | "approve" | "reject";

/** Whether a node-addressed action is applicable to a node in the given state. */
export function canApply(action: ControlAction, state: NodeState | undefined): boolean {
  switch (action) {
    case "retry":
      return state === "failed";
    case "approve":
    case "reject":
      return state === "awaiting";
    default:
      return false;
  }
}

/** Whether a Run-level action is applicable to a Run in the given status. */
export function canApplyRun(action: ControlAction, status: RunStatus | undefined): boolean {
  switch (action) {
    case "pause":
      return status === "running";
    case "cancel":
      return status === "running" || status === "paused";
    case "resume":
      return status === "paused";
    case "retry":
      return status === "failed";
    // approve/reject are node-level only; there is no Run-level decision.
    case "approve":
    case "reject":
      return false;
    default:
      return false;
  }
}

/** Apply a node-addressed action. */
export async function applyControl(
  client: RunSupervisorClient,
  action: ControlAction,
  runId: string,
  nodeKey: string
): Promise<NodeExecutionState> {
  switch (action) {
    case "retry":
      return client.retryNode(runId, nodeKey);
    case "approve":
      return client.signalApproval(runId, nodeKey, true);
    case "reject":
      return client.signalApproval(runId, nodeKey, false);
    case "pause":
    case "resume":
    case "cancel":
      throw new Error(`'${action}' is not a Node-level action`);
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
    case "approve":
    case "reject":
      // Guarded out by canApplyRun; approve/reject are node-level only.
      throw new Error(`'${action}' is not a Run-level action`);
  }
}
