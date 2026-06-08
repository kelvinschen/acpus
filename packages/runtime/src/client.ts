/**
 * RunSupervisorClient — thin HTTP client for the acpus Run Supervisor.
 *
 * Lives in @acpus/runtime so both the CLI and the TUI can share one client
 * without a package cycle.
 *
 * Node keys are passed as ?key= query parameters since they contain "/"
 * characters that are incompatible with URL path segments.
 */

import type { AcpusIr } from "@acpus/core";
import type { RunState, NodeExecutionState, RunSummary, ReplayResult, SupervisorHealth } from "./types.js";
import { randomUUID } from "node:crypto";

export class RunSupervisorClient {
  private readonly baseUrl: string;
  /** Client identity for lease tracking on the supervisor. */
  readonly clientId: string;
  /** When set, includes x-acpus-client-kind header to pin the supervisor alive. */
  clientKind?: "follow" | "visualize";

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.clientId = randomUUID();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "x-acpus-client-id": this.clientId
    };
    if (this.clientKind) {
      h["x-acpus-client-kind"] = this.clientKind;
    }
    return h;
  }

  async health(): Promise<SupervisorHealth> {
    const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json() as Promise<SupervisorHealth>;
  }

  async startRun(spec: string, input?: Record<string, unknown>, sourcePath?: string): Promise<RunState> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify({ spec, input, sourcePath })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Failed to start run: ${res.status} ${JSON.stringify(body)}`);
    }
    return res.json() as Promise<RunState>;
  }

  async listRuns(): Promise<RunSummary[]> {
    const res = await fetch(`${this.baseUrl}/runs`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`);
    return res.json() as Promise<RunSummary[]>;
  }

  async getRun(runId: string): Promise<RunState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Run not found: ${runId}`);
    return res.json() as Promise<RunState>;
  }

  async getIr(runId: string): Promise<AcpusIr> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/ir`, { headers: this.headers() });
    if (!res.ok) throw new Error(`IR not found: ${runId}`);
    return res.json() as Promise<AcpusIr>;
  }

  /** Resolve an artifact:// URI to its absolute filesystem path on the supervisor host. */
  async getArtifactPath(runId: string, uri: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/artifact-path?uri=${encodeURIComponent(uri)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to resolve artifact path: ${res.status}`);
    const body = (await res.json()) as { absPath: string };
    return body.absPath;
  }

  async getNodeStates(runId: string): Promise<NodeExecutionState[]> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/nodes`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to get node states: ${res.status}`);
    return res.json() as Promise<NodeExecutionState[]>;
  }

  async getNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/node?key=${encodeURIComponent(nodeKey)}`, { headers: this.headers() });
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

  /**
   * Deliver a human-in-the-loop approval decision to an Approval Gate that is
   * currently `awaiting`. Node-level only. On a non-2xx response the
   * supervisor's error message (e.g. 409 "not awaiting") is surfaced.
   */
  async signalApproval(runId: string, nodeKey: string, approved: boolean): Promise<NodeExecutionState> {
    const res = await fetch(
      `${this.baseUrl}/runs/${runId}/signal?key=${encodeURIComponent(nodeKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers() },
        body: JSON.stringify({ kind: "approval", approved })
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Failed to signal approval: ${res.status}`);
    }
    return res.json() as Promise<NodeExecutionState>;
  }

  // ─── Run-level controls ────────────────────────────────────────

  async pauseRun(runId: string): Promise<RunState> {
    return this.controlRun(runId, "pause");
  }

  async resumeRun(runId: string): Promise<RunState> {
    return this.controlRun(runId, "resume");
  }

  async cancelRun(runId: string): Promise<RunState> {
    return this.controlRun(runId, "cancel");
  }

  async retryRun(runId: string): Promise<RunState> {
    return this.controlRun(runId, "retry");
  }

  async getOutput(runId: string): Promise<{ status: string; output: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/output`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to get output: ${res.status}`);
    return res.json() as Promise<{ status: string; output: Record<string, unknown> }>;
  }

  async replay(runId: string): Promise<ReplayResult> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/replay`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to replay run: ${res.status}`);
    return res.json() as Promise<ReplayResult>;
  }

  /**
   * Issue a node-control action. On a non-2xx response the supervisor's error
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
      { method: "POST", headers: this.headers() }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Failed to ${action} node: ${res.status}`);
    }
    return res.json() as Promise<NodeExecutionState>;
  }

  /**
   * Issue a Run-level control action. No ?key= parameter — the action applies
   * to the entire Run.
   */
  private async controlRun(
    runId: string,
    action: "pause" | "resume" | "cancel" | "retry"
  ): Promise<RunState> {
    const res = await fetch(
      `${this.baseUrl}/runs/${runId}/${action}`,
      { method: "POST", headers: this.headers() }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Failed to ${action} run: ${res.status}`);
    }
    return res.json() as Promise<RunState>;
  }
}
