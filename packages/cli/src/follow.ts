/**
 * FollowLoop — polls a running Run and emits observations to stdout.
 *
 * Used by `acpus workflows run <spec>` (foreground follow mode) and
 * `acpus workflows run <spec> --json`.
 * Tracks node state changes and deduplicates: only emits when a node is first
 * observed or when its state changes.
 *
 * Ctrl-C detaches (exit 0) without cancelling the Run.
 */

import type { AgentTelemetry, RunSupervisorClient, RunState, NodeExecutionState, RunStatus } from "@acpus/runtime";
import { formatObservation, formatTerminalSummary, type ObservationEvent } from "./observations.js";
import { computeRunDurationMs, shouldShowNode } from "./runs-show.js";

export interface FollowOptions {
  /** Emit JSONL observations instead of human-readable glyphs */
  json?: boolean;
  /** Polling interval in milliseconds (default 10000 = 10s). Parsed from --poll duration string. */
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
  const intervalMs = options.intervalMs ?? 10_000;

  // Pin the supervisor alive while following
  client.clientKind = "follow";

  const lastObserved = new Map<string, NodeExecutionState>();
  let lastRunStatus: RunStatus | undefined;
  let runName = "";
  // Activity dedup: maps nodeKey → last emitted activity string
  const lastActivity = new Map<string, string>();

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

      // Emit Run-level observation on first poll or status change.
      // Terminal states are handled by formatTerminalSummary below; skip here
      // to avoid duplicate "Run ... completed" lines with different glyphs.
      if (lastRunStatus === undefined || run.status !== lastRunStatus) {
        if (!isTerminal(run.status)) {
          const event: ObservationEvent = {
            type: "run",
            runId,
            status: run.status,
            workflowName: run.workflowName,
            workflowRef: run.workflowRef,
            createdAt: run.createdAt,
          };
          emit(formatObservation(event, runName, options.json));
        }
        lastRunStatus = run.status;
      }

      const visibleNodes = nodes.filter((node) => shouldShowNode(node, nodes));

      // Emit Node-level observations for new/changed nodes
      for (const node of visibleNodes) {
        const prev = lastObserved.get(node.nodeKey);
        if (!prev || prev.state !== node.state) {
          // State change — always emit
          const event = buildNodeEvent(node);
          emit(formatObservation(event, undefined, options.json));
          // Update activity dedup for running agents
          if (node.kind === "run.agent" && node.state === "running" && node.agentTelemetry) {
            lastActivity.set(node.nodeKey, summarizeActivity(node.agentTelemetry));
          } else {
            lastActivity.delete(node.nodeKey);
          }
        } else if (node.kind === "run.agent" && node.state === "running" && node.agentTelemetry) {
          // No state change, but check if activity content changed (dedup)
          const currentActivity = summarizeActivity(node.agentTelemetry);
          const prevActivity = lastActivity.get(node.nodeKey);
          if (currentActivity !== prevActivity) {
            const event = buildNodeEvent(node);
            emit(formatObservation(event, undefined, options.json));
            lastActivity.set(node.nodeKey, currentActivity);
          }
        }
        lastObserved.set(node.nodeKey, node);
      }

      // Check if Run is terminal
      if (isTerminal(run.status)) {
        const runDuration = computeRunDurationMs(run);
        const summary = formatTerminalSummary(runId, run.status, runName, options.json, {
          runDuration,
          output: run.status === "completed" ? run.output : undefined,
        });
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
  return status === "completed" || status === "failed" || status === "cancelled" || status === "paused";
}

/**
 * Build an ObservationEvent for a node with all available fields.
 */
function buildNodeEvent(node: NodeExecutionState): ObservationEvent {
  const event: ObservationEvent = {
    type: "node",
    nodeKey: node.nodeKey,
    state: node.state,
    kind: node.kind,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    error: node.error,
    attempt: node.attempt,
  };

  // Attach rich fields for JSON mode
  if (node.agentTelemetry) event.agentTelemetry = node.agentTelemetry;
  if (node.artifactRefs) event.artifactRefs = node.artifactRefs;
  if (node.state === "completed" && node.output !== undefined && typeof node.output === "object" && node.output !== null) {
    event.output = node.output as Record<string, unknown>;
  }

  return event;
}

/**
 * Derive a concise activity fingerprint string from agent telemetry for dedup.
 * Uses the same summary format as the human-readable output.
 */
function summarizeActivity(telemetry: AgentTelemetry): string {
  const attempt = telemetry.attempts.find((a) => a.attempt === telemetry.currentAttempt)
    ?? telemetry.attempts[telemetry.attempts.length - 1];
  if (!attempt) return "";
  // Key fields that change over time — compare these for dedup
  return `${attempt.updatedAt}|${attempt.tools.totalToolCallCount}|${attempt.tools.recentCalls.map(c => c.toolCallId).join(",")}`;
}
