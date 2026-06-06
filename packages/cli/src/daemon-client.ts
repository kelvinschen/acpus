/**
 * DaemonClient — thin HTTP client for the acpus daemon.
 * Used by the CLI to communicate with the daemon process.
 *
 * Node keys are passed as ?key= query parameters since they contain "/"
 * characters that are incompatible with URL path segments.
 */

import type { RunState, NodeExecutionState, RunSummary } from "@acpus/runtime";

export type { RunState, NodeExecutionState, RunSummary };

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
    const res = await fetch(`${this.baseUrl}/runs/${runId}/pause?key=${encodeURIComponent(nodeKey)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to pause node: ${res.status}`);
    return res.json() as Promise<NodeExecutionState>;
  }

  async resumeNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/resume?key=${encodeURIComponent(nodeKey)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to resume node: ${res.status}`);
    return res.json() as Promise<NodeExecutionState>;
  }

  async cancelNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/cancel?key=${encodeURIComponent(nodeKey)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to cancel node: ${res.status}`);
    return res.json() as Promise<NodeExecutionState>;
  }

  async retryNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/retry?key=${encodeURIComponent(nodeKey)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to retry node: ${res.status}`);
    return res.json() as Promise<NodeExecutionState>;
  }

  async getOutput(runId: string): Promise<{ status: string; output: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/output`);
    if (!res.ok) throw new Error(`Failed to get output: ${res.status}`);
    return res.json() as Promise<{ status: string; output: Record<string, unknown> }>;
  }
}
