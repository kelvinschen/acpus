/**
 * DaemonClient — thin HTTP client for the acpus daemon.
 *
 * Lives in @acpus/runtime so both the CLI and the TUI can share one client
 * without a package cycle.
 *
 * Node keys are passed as ?key= query parameters since they contain "/"
 * characters that are incompatible with URL path segments.
 */

import type { AcpusIr } from "@acpus/core";
import type { RunState, NodeExecutionState, RunSummary, ReplayResult } from "./types.js";

export class DaemonClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? "http://127.0.0.1:3839";
  }

  async startRun(spec: string, input?: Record<string, unknown>): Promise<RunState> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, input })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Failed to start run: ${res.status} ${JSON.stringify(body)}`);
    }
    return res.json() as Promise<RunState>;
  }

  async listRuns(): Promise<RunSummary[]> {
    const res = await fetch(`${this.baseUrl}/runs`);
    if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`);
    return res.json() as Promise<RunSummary[]>;
  }

  async getRun(runId: string): Promise<RunState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}`);
    if (!res.ok) throw new Error(`Run not found: ${runId}`);
    return res.json() as Promise<RunState>;
  }

  async getIr(runId: string): Promise<AcpusIr> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/ir`);
    if (!res.ok) throw new Error(`IR not found: ${runId}`);
    return res.json() as Promise<AcpusIr>;
  }

  /** Resolve an artifact:// URI to its absolute filesystem path on the daemon host. */
  async getArtifactPath(runId: string, uri: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/artifact-path?uri=${encodeURIComponent(uri)}`);
    if (!res.ok) throw new Error(`Failed to resolve artifact path: ${res.status}`);
    const body = (await res.json()) as { absPath: string };
    return body.absPath;
  }

  async getNodeStates(runId: string): Promise<NodeExecutionState[]> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/nodes`);
    if (!res.ok) throw new Error(`Failed to get node states: ${res.status}`);
    return res.json() as Promise<NodeExecutionState[]>;
  }

  async getNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/node?key=${encodeURIComponent(nodeKey)}`);
    if (!res.ok) throw new Error(`Node not found: ${nodeKey}`);
    return res.json() as Promise<NodeExecutionState>;
  }

  async pauseNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.controlNode(runId, nodeKey, "pause");
  }

  async resumeNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.controlNode(runId, nodeKey, "resume");
  }

  async cancelNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.controlNode(runId, nodeKey, "cancel");
  }

  async retryNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.controlNode(runId, nodeKey, "retry");
  }

  async getOutput(runId: string): Promise<{ status: string; output: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/output`);
    if (!res.ok) throw new Error(`Failed to get output: ${res.status}`);
    return res.json() as Promise<{ status: string; output: Record<string, unknown> }>;
  }

  async replay(runId: string): Promise<ReplayResult> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/replay`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to replay run: ${res.status}`);
    return res.json() as Promise<ReplayResult>;
  }

  /**
   * Issue a node-control action. On a non-2xx response the daemon's error
   * message (e.g. the 409 "not actively executing" guard) is surfaced so
   * callers can show it inline.
   */
  private async controlNode(
    runId: string,
    nodeKey: string,
    action: "pause" | "resume" | "cancel" | "retry"
  ): Promise<NodeExecutionState> {
    const res = await fetch(
      `${this.baseUrl}/runs/${runId}/${action}?key=${encodeURIComponent(nodeKey)}`,
      { method: "POST" }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Failed to ${action} node: ${res.status}`);
    }
    return res.json() as Promise<NodeExecutionState>;
  }
}
