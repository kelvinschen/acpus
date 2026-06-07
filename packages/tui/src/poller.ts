/**
 * Polling data layer. The daemon is poll-only (no event stream), so the TUI
 * repeatedly fetches run status + node states. The frozen IR is immutable, so
 * it is fetched once and cached.
 */

import { useEffect, useRef, useState } from "react";
import type { AcpusIr } from "@acpus/core";
import type { DaemonClient, NodeExecutionState, RunState } from "@acpus/runtime";

export interface RunSnapshot {
  ir?: AcpusIr;
  run?: RunState;
  nodes: NodeExecutionState[];
  /** Connection / fetch error message, if the last poll failed. */
  error?: string;
  /** True once the first successful poll has landed. */
  loaded: boolean;
}

const TERMINAL = new Set(["completed", "failed", "paused", "cancelled"]);

export function isTerminal(status?: string): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/**
 * Poll a run on an interval. Stops polling once the run reaches a terminal
 * status (keeping the last frame). `refreshNonce` forces an immediate refetch
 * (used right after a control action).
 */
export function useRunPoller(
  client: DaemonClient,
  runId: string,
  intervalMs = 400,
  refreshNonce = 0
): RunSnapshot {
  const [snapshot, setSnapshot] = useState<RunSnapshot>({ nodes: [], loaded: false });
  const irRef = useRef<AcpusIr | undefined>(undefined);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        if (!irRef.current) {
          irRef.current = await client.getIr(runId);
        }
        const [run, nodes] = await Promise.all([
          client.getRun(runId),
          client.getNodeStates(runId)
        ]);
        if (stopped.current) return;
        setSnapshot({ ir: irRef.current, run, nodes, loaded: true });
        if (isTerminal(run.status)) return; // stop polling; keep last frame
      } catch (err) {
        if (stopped.current) return;
        setSnapshot((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err)
        }));
      }
      if (!stopped.current) timer = setTimeout(poll, intervalMs);
    };

    void poll();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, runId, intervalMs, refreshNonce]);

  return snapshot;
}
