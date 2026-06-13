/**
 * Polling data layer. The supervisor is poll-only (no event stream), so the TUI
 * repeatedly fetches run status + node states. The frozen IR is immutable, so
 * it is fetched once and cached.
 */

import { useEffect, useRef, useState } from "react";
import type { AcpusIr } from "@acpus/core";
import type { RunSupervisorClient, NodeExecutionState, RunState } from "@acpus/runtime";

export interface RunSnapshot {
  ir?: AcpusIr;
  input?: Record<string, unknown>;
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
  client: RunSupervisorClient,
  runId: string,
  intervalMs = 400,
  refreshNonce = 0
): RunSnapshot {
  const [snapshot, setSnapshot] = useState<RunSnapshot>({ nodes: [], loaded: false });
  const irRef = useRef<AcpusIr | undefined>(undefined);
  const inputRef = useRef<Record<string, unknown> | undefined>(undefined);
  const cachedRunIdRef = useRef<string | undefined>(undefined);
  const fingerprintRef = useRef<string | undefined>(undefined);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    if (cachedRunIdRef.current !== runId) {
      cachedRunIdRef.current = runId;
      irRef.current = undefined;
      inputRef.current = undefined;
    }
    fingerprintRef.current = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        if (!irRef.current) {
          irRef.current = await client.getIr(runId);
        }
        if (!inputRef.current) {
          inputRef.current = await client.getInput(runId);
        }
        const [run, nodes] = await Promise.all([
          client.getRun(runId),
          client.getNodeStates(runId)
        ]);
        if (stopped.current) return;
        const fingerprint = snapshotFingerprint(run, nodes);
        if (fingerprint !== fingerprintRef.current) {
          fingerprintRef.current = fingerprint;
          setSnapshot({ ir: irRef.current, input: inputRef.current, run, nodes, loaded: true });
        } else {
          setSnapshot((prev) => prev.loaded && prev.error === undefined
            ? prev
            : { ir: irRef.current, input: inputRef.current, run, nodes, loaded: true });
        }
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

export function snapshotFingerprint(run: RunState, nodes: NodeExecutionState[]): string {
  return JSON.stringify({
    run: {
      runId: run.runId,
      status: run.status,
      updatedAt: run.updatedAt,
      runAttempt: run.runAttempt,
      output: run.output,
      error: run.error
    },
    nodes: nodes.map((node) => ({
      nodeKey: node.nodeKey,
      state: node.state,
      attempt: node.attempt,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      error: node.error,
      output: node.output,
      artifactRefs: node.artifactRefs,
      agentTelemetry: node.agentTelemetry
    }))
  });
}
