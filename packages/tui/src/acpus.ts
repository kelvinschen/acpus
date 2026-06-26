import { randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export type IrNodeKind =
  | "pipeline"
  | "run.agent"
  | "run.program"
  | "run.signal"
  | "parallel"
  | "fanout"
  | "if"
  | "switch"
  | "loop"
  | "guard"
  | "subworkflow";

export interface NodeKeyTemplate {
  astVersion: number;
  nodePath: string;
  loopRound?: boolean;
  fanoutItemId?: boolean;
  laneId?: boolean;
  parallelBranchId?: boolean;
}

export interface IrBranch {
  id: string;
  when?: string;
  whenPath?: string;
  child: IrNode;
}

export interface IrNode {
  id: string;
  kind: IrNodeKind;
  nodePath: string[];
  keyTemplate: NodeKeyTemplate;
  outputMerge?: "map" | "array" | "selected" | "last";
  children?: IrNode[];
  branches?: IrBranch[];
  metadata: JsonObject;
}

export interface AcpusIr {
  irVersion: number;
  astVersion: number;
  source: { path?: string; digest: string };
  name: string;
  description?: string;
  input: unknown;
  agents: JsonObject;
  root: IrNode;
  outputs: unknown;
  expressions: unknown[];
  runtimeInput?: unknown;
}

export type NodeState = "pending" | "running" | "awaiting" | "completed" | "failed" | "paused" | "cancelled";
export type RunStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface NodeKeyDynamic {
  loopRound?: number;
  fanoutItemId?: string;
  laneId?: string;
  parallelBranchId?: string;
}

export interface ParsedNodeKey {
  nodeKey: string;
  staticPath: string;
  staticSegments: string[];
  dynamic: NodeKeyDynamic;
  dynamicFrames: NodeKeyDynamic[];
}

export interface NodeDynamicContext {
  item?: unknown;
  item_id?: string;
  item_index?: number;
  loop?: { iter: number; last?: unknown };
}

export interface AgentContextUsage {
  used: number;
  size: number;
  updatedAt: string;
}

export interface AgentTokenUsage {
  source: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AgentIoPreview {
  preview: string;
  truncated: boolean;
  originalBytes: number;
  headBytes: number;
  tailBytes?: number;
  artifactRef?: string;
}

export interface AgentToolCallTelemetry {
  toolCallId: string;
  title?: string;
  status?: string;
  kind?: string;
  toolName?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentToolsTelemetry {
  totalToolCallCount: number;
  droppedToolCallCount: number;
  recentCalls: AgentToolCallTelemetry[];
}

export type AgentAttemptTelemetryState = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface AgentAttemptTelemetry {
  attempt: number;
  state: AgentAttemptTelemetryState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  context?: AgentContextUsage;
  tokenUsage?: AgentTokenUsage;
  input?: AgentIoPreview;
  output?: AgentIoPreview;
  tools: AgentToolsTelemetry;
  acpxRecordId?: string;
  cwd?: string;
}

export interface AgentTelemetry {
  currentAttempt: number;
  attempts: AgentAttemptTelemetry[];
}

export interface NodeExecutionState {
  nodeKey: string;
  nodeId: string;
  kind: IrNodeKind;
  definitionHash?: string;
  state: NodeState;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  failureKind?: string;
  input?: JsonObject;
  output?: unknown;
  artifactRefs?: string[];
  renderedPrompt?: string;
  renderedSessionKey?: string;
  dynamicContext?: NodeDynamicContext;
  agentTelemetry?: AgentTelemetry;
}

export interface RunLineage {
  sourceRunId: string;
  forkOriginNodeKey: string;
  inheritedNodeCount: number;
}

export type AgentOverrides = JsonObject;
export type AgentOverrideWarning = JsonObject;

export interface RunState {
  runId: string;
  workflowName: string;
  workflowRef?: string;
  workflowSourcePath?: string;
  status: RunStatus;
  irDigest: string;
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
  runAttempt: number;
  output?: JsonObject;
  error?: string;
  lineage?: RunLineage;
  agentOverrides?: AgentOverrides;
  submissionWarnings?: AgentOverrideWarning[];
  hookConfigHash?: string;
  skipHooks?: boolean;
  nodes?: NodeExecutionState[];
}

export interface RunSummary {
  runId: string;
  workflowName: string;
  workflowRef?: string;
  workflowSourcePath?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  lineage?: RunLineage;
}

export interface SupervisorHealth {
  ok: true;
  schemaVersion: number;
  workspace: string;
  pid: number;
  endpoint: string;
  startedAt: string;
  version: string;
  runningCount: number;
  activeClients: number;
}

export interface RunCleanItem {
  runId: string;
  status?: RunStatus;
  bytes: number;
  reason?: string;
}

export interface RunCleanResult {
  dryRun: boolean;
  deletedCount: number;
  skippedCount: number;
  bytesReclaimed: number;
  deleted: RunCleanItem[];
  skipped: RunCleanItem[];
}

export interface ReplayResult {
  runId: string;
  ok: boolean;
  mismatches: {
    nodeKey: string;
    kind: "state" | "missing-in-replay" | "unexpected-in-replay";
    expected?: NodeState;
    actual?: NodeState;
  }[];
}

export interface ForkPlan {
  [key: string]: unknown;
}

const DYNAMIC_SEGMENT = /^(item|lane|round|branch):/u;

export function parseNodeKey(nodeKey: string): ParsedNodeKey {
  const segments = nodeKey.split("/");
  const staticSegments: string[] = [];
  const dynamicSegments: string[] = [];

  for (const segment of segments) {
    if (DYNAMIC_SEGMENT.test(segment)) {
      dynamicSegments.push(segment);
    } else {
      staticSegments.push(segment);
    }
  }

  return {
    nodeKey,
    staticPath: staticSegments.join("/"),
    staticSegments,
    dynamic: dynamicFromSegments(dynamicSegments),
    dynamicFrames: dynamicFramesFromSegments(dynamicSegments)
  };
}

function dynamicFromSegments(segments: string[]): NodeKeyDynamic {
  const dynamic: NodeKeyDynamic = {};
  for (const segment of segments) {
    addDynamicSegment(dynamic, segment);
  }
  return dynamic;
}

function dynamicFramesFromSegments(segments: string[]): NodeKeyDynamic[] {
  const frames: NodeKeyDynamic[] = [];
  let current: NodeKeyDynamic = {};

  for (const segment of segments) {
    const [kind] = segment.split(":");
    if ((kind === "item" || kind === "branch" || kind === "round") && !isEmptyDynamic(current)) {
      frames.push(current);
      current = {};
    }
    addDynamicSegment(current, segment);
  }

  if (!isEmptyDynamic(current)) frames.push(current);
  return frames;
}

function addDynamicSegment(dynamic: NodeKeyDynamic, segment: string): void {
  const [kind, ...rest] = segment.split(":");
  const value = rest.join(":");
  if (kind === "item") dynamic.fanoutItemId = value;
  if (kind === "lane") dynamic.laneId = value;
  if (kind === "branch") dynamic.parallelBranchId = value;
  if (kind === "round") dynamic.loopRound = Number(value);
}

function isEmptyDynamic(dynamic: NodeKeyDynamic): boolean {
  return (
    dynamic.fanoutItemId === undefined &&
    dynamic.laneId === undefined &&
    dynamic.parallelBranchId === undefined &&
    dynamic.loopRound === undefined
  );
}

export class RunSupervisorClient {
  readonly endpoint: string;
  readonly clientId: string;
  clientKind?: "follow" | "visualize";

  constructor(baseUrl: string) {
    this.endpoint = baseUrl.replace(/\/+$/u, "");
    this.clientId = randomUUID();
  }

  async health(): Promise<SupervisorHealth> {
    return this.getJson("/health", "Health check failed");
  }

  async listRuns(): Promise<RunSummary[]> {
    return this.getJson("/runs", "Failed to list runs");
  }

  async cleanRuns(options: { dryRun?: boolean } = {}): Promise<RunCleanResult> {
    return this.postJson("/runs/clean", { dryRun: Boolean(options.dryRun) }, "Failed to clean runs");
  }

  async getRun(runId: string): Promise<RunState> {
    return this.getJson(`/runs/${encodeURIComponent(runId)}`, `Run not found: ${runId}`);
  }

  async getIr(runId: string): Promise<AcpusIr> {
    return this.getJson(`/runs/${encodeURIComponent(runId)}/ir`, `IR not found: ${runId}`);
  }

  async getInput(runId: string): Promise<JsonObject> {
    const body = await this.getJson<{ input: JsonObject }>(`/runs/${encodeURIComponent(runId)}/input`, `Input not found: ${runId}`);
    return body.input;
  }

  async getNodeStates(runId: string): Promise<NodeExecutionState[]> {
    return this.getJson(`/runs/${encodeURIComponent(runId)}/nodes`, "Failed to get node states");
  }

  async getNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.getJson(
      `/runs/${encodeURIComponent(runId)}/node?key=${encodeURIComponent(nodeKey)}`,
      `Node not found: ${nodeKey}`
    );
  }

  async getArtifactPath(runId: string, uri: string): Promise<string> {
    const body = await this.getJson<{ absPath: string }>(
      `/runs/${encodeURIComponent(runId)}/artifact-path?uri=${encodeURIComponent(uri)}`,
      "Failed to resolve artifact path"
    );
    return body.absPath;
  }

  async retryNode(runId: string, nodeKey: string): Promise<NodeExecutionState> {
    return this.postJson(
      `/runs/${encodeURIComponent(runId)}/retry?key=${encodeURIComponent(nodeKey)}`,
      undefined,
      "Failed to retry node"
    );
  }

  async signalNode(runId: string, nodeKey: string, payload: JsonObject): Promise<NodeExecutionState> {
    return this.postJson(
      `/runs/${encodeURIComponent(runId)}/signal?key=${encodeURIComponent(nodeKey)}`,
      payload,
      "Failed to signal node"
    );
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

  async getOutput(runId: string): Promise<{ status: string; output: JsonObject }> {
    return this.getJson(`/runs/${encodeURIComponent(runId)}/output`, "Failed to get output");
  }

  async replay(runId: string): Promise<ReplayResult> {
    return this.postJson(`/runs/${encodeURIComponent(runId)}/replay`, undefined, "Failed to replay run");
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
  ): Promise<{ run?: RunState; plan: ForkPlan; dryRun?: boolean; agentOverrides?: AgentOverrides; submissionWarnings?: AgentOverrideWarning[] }> {
    try {
      return await this.postJson(`/runs/${encodeURIComponent(sourceRunId)}/fork`, { spec, ...options }, "Failed to fork run");
    } catch (error) {
      if (error instanceof SupervisorHttpError && error.body?.kind === "fork-rejected") {
        throw new ForkRejectedError(error.message);
      }
      throw error;
    }
  }

  private controlRun(runId: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<RunState> {
    return this.postJson(`/runs/${encodeURIComponent(runId)}/${action}`, undefined, `Failed to ${action} run`);
  }

  private getJson<T>(path: string, message: string): Promise<T> {
    return this.requestJson(path, { method: "GET" }, message);
  }

  private postJson<T>(path: string, body: unknown, message: string): Promise<T> {
    return this.requestJson(
      path,
      {
        method: "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      message
    );
  }

  private async requestJson<T>(path: string, init: RequestInit, message: string): Promise<T> {
    const res = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init.headers }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined) as SupervisorErrorBody | undefined;
      throw new SupervisorHttpError(body?.error ?? `${message}: ${res.status}`, body);
    }
    return res.json() as Promise<T>;
  }

  private headers(): Record<string, string> {
    return this.clientKind
      ? { "x-acpus-client-id": this.clientId, "x-acpus-client-kind": this.clientKind }
      : { "x-acpus-client-id": this.clientId };
  }
}

interface SupervisorErrorBody {
  error?: string;
  kind?: string;
}

class SupervisorHttpError extends Error {
  constructor(message: string, readonly body?: SupervisorErrorBody) {
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
