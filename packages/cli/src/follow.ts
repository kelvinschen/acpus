/**
 * FollowLoop — polls a running Run and emits observations to stdout.
 *
 * Used by `acpus run <spec>` (foreground follow mode) and `acpus run <spec> --json`.
 * Tracks node state changes and deduplicates: only emits when a node is first
 * observed or when its state changes.
 *
 * Ctrl-C detaches (exit 0) without cancelling the Run.
 */

import type { RunSupervisorClient, RunState, NodeExecutionState, RunStatus } from "@acpus/runtime";
import { formatObservation, formatTerminalSummary, type ObservationEvent } from "./observations.js";

export interface FollowOptions {
  /** Emit JSONL observations instead of human-readable glyphs */
  json?: boolean;
  /** Polling interval in milliseconds (default 400) */
  intervalMs?: number;
}

/**
 * Run a follow loop until the Run reaches a terminal state.
 * Returns the terminal RunStatus for exit-code mapping.
 */
export async function followRun(
  client: RunSupervisorClient,
  runId: string,
  options: FollowOptions = {}
): Promise<RunStatus> {
  const intervalMs = options.intervalMs ?? 400;

  // Pin the supervisor alive while following
  client.clientKind = "follow";

  const lastObserved = new Map<string, NodeExecutionState>();
  let lastRunStatus: RunStatus | undefined;
  let runName = "";

  // Register Ctrl-C handler: detach (exit 0) without cancelling
  let detached = false;
  const onSigint = () => {
    detached = true;
    process.off("SIGINT", onSigint);
    // Don't call process.exit(0) here — it skips the finally block and
    // prevents cleanup. Instead, set the flag and let the loop exit naturally.
  };
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      if (detached) {
        // Ctrl-C detach: the Run continues in the background supervisor.
        // Return a non-terminal status so the caller maps to exit 0.
        return "running";
      }

      let run: RunState;
      let nodes: NodeExecutionState[];
      try {
        [run, nodes] = await Promise.all([
          client.getRun(runId),
          client.getNodeStates(runId)
        ]);
      } catch (err) {
        // Transient fetch error — retry after interval
        if (!options.json) {
          process.stderr.write(`⚠ poll error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      runName = run.workflowName;

      // Emit Run-level observation on first poll or status change
      if (lastRunStatus === undefined || run.status !== lastRunStatus) {
        const event: ObservationEvent = { type: "run", runId, status: run.status };
        if (lastRunStatus === undefined) {
          // First observation
          emit(formatObservation(event, runName, options.json));
        } else if (run.status !== lastRunStatus) {
          emit(formatObservation(event, runName, options.json));
        }
        lastRunStatus = run.status;
      }

      // Emit Node-level observations for new/changed nodes
      for (const node of nodes) {
        const prev = lastObserved.get(node.nodeKey);
        if (!prev || prev.state !== node.state) {
          const duration = computeDuration(node);
          const event: ObservationEvent = {
            type: "node",
            nodeKey: node.nodeKey,
            state: node.state,
            duration,
            error: node.error
          };
          emit(formatObservation(event, undefined, options.json));
        }
        lastObserved.set(node.nodeKey, node);
      }

      // Check if Run is terminal
      if (isTerminal(run.status)) {
        const summary = formatTerminalSummary(runId, run.status, runName, options.json);
        emit(summary);
        return run.status;
      }

      // Wait before next poll
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function emit(line: string): void {
  process.stdout.write(line + "\n");
}

function isTerminal(status: RunStatus): boolean {
  // 'paused' is NOT terminal — a paused Run may be resumed, so the follow
  // loop must keep polling. Only truly terminal states exit the loop.
  return status === "completed" || status === "failed" || status === "cancelled";
}

function computeDuration(node: NodeExecutionState): number | undefined {
  if (!node.startedAt) return undefined;
  const start = Date.parse(node.startedAt);
  const end = node.completedAt ? Date.parse(node.completedAt) : Date.now();
  return end - start;
}
