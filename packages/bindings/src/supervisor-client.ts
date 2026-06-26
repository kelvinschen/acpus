import createClient from "openapi-fetch";

import type { paths } from "./generated/openapi.js";
import type {
  AcpusIr,
  AgentOverrideWarning,
  AgentOverrides,
  ApiErrorBody,
  ForkPlan,
  JsonObject,
  NodeExecutionState,
  ReplayResult,
  RunCleanResult,
  RunState,
  RunSummary,
  SupervisorHealth
} from "./generated/types.js";

type OpenApiClient = ReturnType<typeof createClient<paths>>;

export interface SupervisorErrorBody extends ApiErrorBody {
  validationErrors?: unknown;
}

export class SupervisorHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body?: SupervisorErrorBody) {
    super(message);
    this.name = "SupervisorHttpError";
  }
}

export class ForkRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkRejectedError";
  }
}

export class RunSupervisorClient {
  readonly endpoint: string;
  readonly clientId: string;
  clientKind?: "follow" | "visualize";

  private readonly client: OpenApiClient;

  constructor(baseUrl: string) {
    this.endpoint = baseUrl.replace(/\/+$/u, "");
    this.clientId = randomClientId();
    this.client = createClient<paths>({ baseUrl: this.endpoint });
  }

  async health(): Promise<SupervisorHealth> {
    const result = await this.client.GET("/health", { headers: this.headers() });
    return this.unwrap<SupervisorHealth>(result, "Health check failed");
  }

  async listRuns(): Promise<RunSummary[]> {
    const result = await this.client.GET("/runs", { headers: this.headers() });
    return this.unwrap<RunSummary[]>(result, "Failed to list runs");
  }

  async cleanRuns(options: { dryRun?: boolean } = {}): Promise<RunCleanResult> {
    const result = await this.client.POST("/runs/clean", {
      body: { dryRun: Boolean(options.dryRun) },
      headers: this.headers()
    });
    return this.unwrap<RunCleanResult>(result, "Failed to clean runs");
  }

  async getRun(runId: string): Promise<RunState> {
    const result = await this.client.GET("/runs/{run_id}", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<RunState>(result, `Run not found: ${runId}`);
  }

  async getIr(runId: string): Promise<AcpusIr> {
    const result = await this.client.GET("/runs/{run_id}/ir", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<AcpusIr>(result, `IR not found: ${runId}`);
  }

  async getInput(runId: string): Promise<JsonObject> {
    const result = await this.client.GET("/runs/{run_id}/input", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    const body = await this.unwrap<{ input: JsonObject }>(result, `Input not found: ${runId}`);
    return body.input;
  }

  async getNodeStates(runId: string): Promise<NodeExecutionState[]> {
    const result = await this.client.GET("/runs/{run_id}/nodes", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<NodeExecutionState[]>(result, "Failed to get node states");
  }

  async getNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const result = await this.client.GET("/runs/{run_id}/node", {
      params: { path: { run_id: runId }, query: { key: nodeKey } },
      headers: this.headers()
    });
    return this.unwrap<NodeExecutionState>(result, `Node not found: ${nodeKey}`);
  }

  async getArtifactPath(runId: string, uri: string): Promise<string> {
    const result = await this.client.GET("/runs/{run_id}/artifact-path", {
      params: { path: { run_id: runId }, query: { uri } },
      headers: this.headers()
    });
    const body = await this.unwrap<{ absPath: string }>(result, "Failed to resolve artifact path");
    return body.absPath;
  }

  async retryNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    const result = await this.client.POST("/runs/{run_id}/retry", {
      params: { path: { run_id: runId }, query: { key: nodeKey } },
      headers: this.headers()
    });
    return this.unwrap<NodeExecutionState>(result, "Failed to retry node");
  }

  async signalNode(runId: string, nodeKey: string, payload: JsonObject): Promise<NodeExecutionState> {
    const result = await this.client.POST("/runs/{run_id}/signal", {
      params: { path: { run_id: runId }, query: { key: nodeKey } },
      body: payload as Record<string, never>,
      headers: this.headers()
    });
    return this.unwrap<NodeExecutionState>(result, "Failed to signal node");
  }

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

  async getOutput(runId: string): Promise<{ status: string; output: JsonObject; error?: string }> {
    const result = await this.client.GET("/runs/{run_id}/output", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<{ status: string; output: JsonObject; error?: string }>(
      result,
      "Failed to get output"
    );
  }

  async replay(runId: string): Promise<ReplayResult> {
    const result = await this.client.POST("/runs/{run_id}/replay", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<ReplayResult>(result, "Failed to replay run");
  }

  async forkRun(
    sourceRunId: string,
    spec: string,
    options: {
      sourcePath?: string;
      workflowRef?: string;
      input?: JsonObject;
      overrideOriginNodeKey?: string;
      dryRun?: boolean;
      agentOverrides?: AgentOverrides;
    } = {}
  ): Promise<{
    run?: RunState;
    plan: ForkPlan;
    dryRun?: boolean;
    agentOverrides?: AgentOverrides;
    submissionWarnings?: AgentOverrideWarning[];
  }> {
    const result = await this.client.POST("/runs/{run_id}/fork", {
      params: { path: { run_id: sourceRunId } },
      body: { spec, ...options } as never,
      headers: this.headers()
    });
    try {
      return await this.unwrap(result, "Failed to fork run");
    } catch (error) {
      if (error instanceof SupervisorHttpError && error.body?.kind === "fork-rejected") {
        throw new ForkRejectedError(error.message);
      }
      throw error;
    }
  }

  private async controlRun(runId: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<RunState> {
    const result = await this.client.POST(`/runs/{run_id}/${action}` as "/runs/{run_id}/pause", {
      params: { path: { run_id: runId } },
      headers: this.headers()
    });
    return this.unwrap<RunState>(result, `Failed to ${action} run`);
  }

  private async unwrap<T>(
    result: { data?: unknown; error?: unknown; response: { status: number } },
    message: string
  ): Promise<T> {
    if (result.error !== undefined) {
      const body = result.error as SupervisorErrorBody | undefined;
      throw new SupervisorHttpError(
        body?.error ?? `${message}: ${result.response.status}`,
        result.response.status,
        body
      );
    }
    return result.data as T;
  }

  private headers(): Record<string, string> {
    return this.clientKind
      ? { "x-acpus-client-id": this.clientId, "x-acpus-client-kind": this.clientKind }
      : { "x-acpus-client-id": this.clientId };
  }
}

function randomClientId(): string {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
