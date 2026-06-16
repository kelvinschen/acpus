/**
 * Control actions — map keypresses to supervisor control calls, guarding
 * client-side by state so we only attempt actions that can succeed.
 */

import type { RunSupervisorClient, NodeExecutionState, NodeState, RunStatus } from "@acpus/runtime";

export type ControlAction = "pause" | "resume" | "cancel" | "retry" | "signal";

export const CONTROL_KEY_TO_ACTION: Readonly<Record<string, ControlAction>> = {
  p: "pause",
  r: "resume",
  c: "cancel",
  R: "retry",
  s: "signal"
};

export const READ_ONLY_DISABLED_CONTROL_KEYS = new Set(Object.keys(CONTROL_KEY_TO_ACTION));

export function isReadOnlyControlKey(input: string): boolean {
  return READ_ONLY_DISABLED_CONTROL_KEYS.has(input);
}

/** Whether a node-addressed action is applicable to a node in the given state. */
export function canApply(action: ControlAction, state: NodeState | undefined): boolean {
  switch (action) {
    case "retry":
      return state === "failed";
    case "signal":
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
    // signal is node-level only; there is no Run-level decision.
    case "signal":
      return false;
    default:
      return false;
  }
}

/** Apply a node-addressed action. Signal delivery requires a payload object. */
export async function applyControl(
  client: RunSupervisorClient,
  action: ControlAction,
  runId: string,
  nodeKey: string,
  payload?: Record<string, unknown>
): Promise<NodeExecutionState> {
  switch (action) {
    case "retry":
      return client.retryNode(runId, nodeKey);
    case "signal":
      return client.signalNode(runId, nodeKey, payload ?? {});
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
    case "signal":
      // Guarded out by canApplyRun; signal is node-level only.
      throw new Error(`'${action}' is not a Run-level action`);
  }
}
