import type { RunInspectionTargetDocument } from "@acpus/runtime";

export type RunRecord = {
  id: string;
  name: string;
  status: string;
  workflowEntry: string;
  sourceGraphDigest: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDetails = RunRecord & {
  input: unknown;
  output?: unknown;
  eventCount: number;
  nodeCount: number;
  dynamic?: {
    version: number;
    frames: Array<{
      frameKey: string;
      nodeId?: string;
      frameKind?: string;
      status: string;
    } & Record<string, unknown>>;
    nodeInstances: Array<{
      nodeKey: string;
      nodeId: string;
      status: string;
    } & Record<string, unknown>>;
    attempts: unknown[];
    groupMembers: Array<({
      groupKey: string;
      memberKey: string;
      childFrameKey?: string;
      status: string;
    } & (
      | { memberKind: "branch"; branchId: string; itemIndex?: never }
      | { memberKind: "fanout_item"; itemIndex: number; branchId?: never }
    )) & Record<string, unknown>>;
    signalWaits: Array<{
      nodeKey: string;
      nodeId: string;
      status: string;
      renderedPrompt?: string;
    }>;
    executionMetadata: unknown[];
    artifacts?: ArtifactReference[];
  };
};

export type ArtifactReference = {
  id: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
  createdAt?: string;
};

export type WebGraph = {
  workflow: {
    name: string;
    description?: string;
    runId?: string;
    status?: string;
    dynamicVersion?: number;
  };
  mode: "static" | "runtime";
  version?: number;
  nodes: WebGraphNode[];
  containers: WebGraphContainer[];
  edges: WebGraphEdge[];
  selectors: WebGraphSelector[];
  runtimeStates: WebGraphRuntimeState[];
  groups: WebGraphGroup[];
};

// Compact, display-only summary of a node's authored configuration.
export type NodeDetail =
  | { kind: "task"; inputs: string[]; target: "inline" | "module" }
  | { kind: "agent"; agent: string; use?: string; command?: string; model?: string; outputSchema?: string }
  | { kind: "signal"; outputSchema?: string }
  | { kind: "assert"; condition: string; message?: string }
  | { kind: "if"; condition: string }
  | { kind: "switch"; cases: string[]; hasDefault: boolean }
  | { kind: "parallel"; branches: string[]; strategy: "all" | "race"; maxConcurrency?: string }
  | { kind: "fanout"; over: string; strategy: "all" | "quorum"; count?: string; maxConcurrency?: string }
  | { kind: "loop"; state: string };

export type WebGraphNode = {
  id: string;
  nodeId: string;
  kind: string;
  label: string;
  path: string[];
  parentId?: string;
  parentNodeId?: string;
  detail?: NodeDetail;
  status: string;
  dynamic: {
    instances: number;
    frames: number;
    attempts: number;
    signalWaits: number;
  };
};

export type WebGraphContainer = {
  id: string;
  nodeId: string;
  kind: "branch" | "scope";
  label: string;
  path: string[];
  parentId: string;
  status: string;
};

export type WebGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "sequence" | "branch" | "loop";
};

export type WebGraphSelector = {
  nodeId: string;
  kind: "fanout" | "loop";
  targetId: string;
  defaultOptionId?: string;
  options: WebGraphSelectorOption[];
};

type WebGraphSelectorOptionBase = {
  id: string;
  label: string;
  status: string;
  frameKey?: string;
  scopePath: string[];
  parentSelections: WebGraphSelection[];
};

type WebGraphFanoutSelectorOption = WebGraphSelectorOptionBase & { itemIndex: number };
type WebGraphLoopSelectorOption = WebGraphSelectorOptionBase & { iteration: number };
export type WebGraphSelectorOption = WebGraphFanoutSelectorOption | WebGraphLoopSelectorOption;

export type WebGraphRuntimeState = {
  targetId: string;
  nodeId: string;
  status: string;
  frameKey?: string;
  nodeKey?: string;
  selectors: WebGraphSelection[];
};

export type WebGraphSelection =
  | { nodeId: string; kind: "fanout"; itemIndex: number }
  | { nodeId: string; kind: "loop"; iteration: number };

type WebGraphGroup = {
  nodeId: string;
  groupKey: string;
  kind: "parallel" | "fanout";
  status: string;
  strategy?: string;
  quorumCount?: number;
  maxConcurrency?: number;
  members: Array<({
    memberKey: string;
    status: string;
    childFrameKey?: string;
  } & (
    | { memberKind: "branch"; branchId: string; itemIndex?: never }
    | { memberKind: "fanout_item"; itemIndex: number; branchId?: never }
  ))>;
};

export type NodeInspection = RunInspectionTargetDocument;

export type NodeExecutionInspection = {
  target: NodeInspection["target"];
  nodeId?: string;
  nodeKey?: string;
  attemptId?: string;
  available: boolean;
  reason?: string;
  summary: {
    status?: string;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastActiveAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  toolCallCount?: number;
  lastToolCalls: Array<{
    turn: number;
    toolCallId?: string;
    toolName?: string;
    status?: string;
    startedAt?: string;
    updatedAt?: string;
    completedAt?: string;
    durationMs?: number;
    inputPreview?: string;
    outputPreview?: string;
  }>;
};

export type ArtifactPreview = {
  text: string;
  mediaType: string;
  size: number;
  truncated: boolean;
};

export type ProjectWorkflowCatalogEntry = {
  scope: "project";
  name: string;
  packagePath: string;
  entryPath: string;
  status: "available";
  requiresScope: boolean;
};

export type WorkflowFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "workflow";
};

export type WorkflowFiles = {
  cwd: string;
  dir: string;
  entries: WorkflowFileEntry[];
};

export type WorkflowVisualizationSource =
  | { kind: "catalog"; name: string }
  | { kind: "file"; path: string };

export type WorkflowVisualizationResult =
  | {
    status: "ready";
    graph: WebGraph;
    workflow: { name: string; description?: string; irVersion: number; nodeCount: number };
    contract: { inputSchema?: unknown; outputs: Record<string, unknown> };
    diagnostics: unknown[];
    sourceGraphDigest: string;
  }
  | {
    status: "failed";
    phase: "check" | "compile" | "validate";
    message: string;
    diagnostics?: unknown[];
  };

export type HealthReport = {
  ok: boolean;
  phase: string;
  state: string;
  checks: Array<{
    area: string;
    status: "ok" | "warn" | "fail";
    message: string;
    details?: Record<string, unknown>;
  }>;
};

export type ServerConfig = {
  cwd: string;
  access: "open" | "token";
  port: number | null;
};

export type RunRuntimeSnapshot = {
  run: RunDetails;
  graph: WebGraph;
};

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json() as Record<string, any>;
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? `Request failed with ${response.status}.`);
  return body as T;
}

export async function getHealth(): Promise<HealthReport> {
  return unwrap<{ health: HealthReport }>(await fetch("/api/health")).then(v => v.health);
}

export async function listRuns(): Promise<RunRecord[]> {
  return unwrap<{ runs: RunRecord[] }>(await fetch("/api/runs")).then(v => v.runs);
}

export async function getRunRuntimeSnapshot(runId: string): Promise<RunRuntimeSnapshot> {
  return unwrap<RunRuntimeSnapshot>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/runtime-snapshot`),
  );
}

export async function getNodeInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeInspection> {
  return unwrap<{ inspection: NodeInspection }>(
    await fetch(nodeInspectionUrl(runId, target, context)),
  ).then(v => v.inspection);
}

export async function getNodeExecutionInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeExecutionInspection> {
  return unwrap<{ execution: NodeExecutionInspection }>(
    await fetch(nodeInspectionUrl(runId, target, context, "/execution")),
  ).then(v => v.execution);
}

function nodeInspectionUrl(runId: string, target: string, context?: WebGraphSelection[], suffix = ""): string {
  const base = `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(target)}${suffix}`;
  if (!context || context.length === 0) return base;
  return `${base}?context=${encodeURIComponent(encodeContext(context))}`;
}

function encodeContext(context: WebGraphSelection[]): string {
  const json = JSON.stringify(context);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function getArtifactPreview(runId: string, artifactId: string): Promise<ArtifactPreview> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`);
  if (!response.ok) throw new Error(`Artifact preview failed with ${response.status}.`);
  return {
    text: await response.text(),
    mediaType: response.headers.get("content-type") ?? "text/plain",
    size: Number(response.headers.get("x-artifact-size") ?? "0"),
    truncated: response.headers.get("x-artifact-truncated") === "true",
  };
}

export async function submitRunCommand(
  runId: string,
  command: Record<string, unknown>,
): Promise<unknown> {
  return unwrap(await fetch(`/api/runs/${encodeURIComponent(runId)}/controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }));
}

export async function listWorkflowCatalog(): Promise<ProjectWorkflowCatalogEntry[]> {
  return unwrap<{ catalog: ProjectWorkflowCatalogEntry[] }>(await fetch("/api/workflows/catalog")).then(v => v.catalog);
}

export async function listWorkflowFiles(dir = ""): Promise<WorkflowFiles> {
  return unwrap<{ files: WorkflowFiles }>(
    await fetch(`/api/workflows/files?dir=${encodeURIComponent(dir)}`),
  ).then(v => v.files);
}

export async function visualizeWorkflow(source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  return unwrap<{ result: WorkflowVisualizationResult }>(await fetch("/api/workflows/visualize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  })).then(v => v.result);
}

export async function getConfig(): Promise<ServerConfig> {
  return unwrap<{ config: ServerConfig }>(await fetch("/api/config")).then(v => v.config);
}
