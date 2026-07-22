import type { RunInspectionTargetDocument } from "@acpus/runtime";
import type { ExprIR, StaticExprShape } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { WebGraph, WebGraphSelection } from "../graph-types.js";
export type {
  NodeDetail,
  WebGraph,
  WebGraphNode,
  WebGraphSelection,
} from "../graph-types.js";

export type RunRecord = {
  id: string;
  name: string;
  status: string;
};

export type RunDetails = RunRecord & {
  input: unknown;
  output?: unknown;
  createdAt: string;
  updatedAt: string;
  dynamic?: {
    version: number;
    frames: Array<{
      frameKey: string;
      nodeId?: string;
      frameKind?: string;
      status: string;
    }>;
    nodeInstances: Array<{
      nodeKey: string;
      nodeId: string;
      status: string;
    }>;
    groupMembers: Array<{
      memberKey: string;
      status: string;
    } & (
      | { memberKind: "branch"; branchId: string; itemIndex?: never }
      | { memberKind: "fanout_item"; itemIndex: number; branchId?: never }
    )>;
  };
};

export type ArtifactReference = {
  id: string;
  nodeKey: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  path: string;
  createdAt?: string;
};

export type NodeInspection = RunInspectionTargetDocument;

export type NodeExecutionInspection = {
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
    durationMs?: number;
    inputPreview?: string;
  }>;
};

export type ArtifactPreview = {
  text: string;
  mediaType: string;
};

export type ProjectWorkflowCatalogEntry = {
  name: string;
  entryPath: string;
};

export type WorkflowFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "workflow";
};

export type WorkflowFiles = {
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
    contract: { inputSchema?: unknown; output: ExprIR; outputShape: StaticExprShape };
    sourceGraphDigest: string;
  }
  | {
    status: "failed";
    phase: "check" | "compile" | "lock" | "validate";
    message: string;
  };

export type HealthReport = {
  checks: Array<{
    area: string;
    status: "ok" | "warn" | "fail";
    message: string;
  }>;
};

export type ServerConfig = {
  cwd: string;
  access: "open" | "token";
};

export type RunRuntimeSnapshot = {
  run: RunDetails;
  graph: WebGraph;
};

export type WebApiFailure =
  | { type: "network-failed"; message: string }
  | { type: "response-invalid-json"; status: number; message: string }
  | { type: "response-invalid-envelope"; status: number; message: string }
  | { type: "request-failed"; status: number; code: string; message: string };

export class WebApiError extends Error {
  constructor(readonly failure: WebApiFailure) {
    super(failure.message);
  }
}

type JsonRecord = Record<string, unknown>;

function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  validate: (body: JsonRecord) => boolean,
): ResultAsync<T, WebApiFailure> {
  return ResultAsync.fromPromise(fetch(input, init), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Network request failed."),
  })).andThen(response => ResultAsync.fromPromise(response.text(), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Response body could not be read."),
  })).andThen(text => {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return err({
        type: "response-invalid-json" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not valid JSON.`,
      });
    }
    if (!isRecord(body)) {
      return err({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not an object envelope.`,
      });
    }
    if (!response.ok || body.ok !== true) {
      const failure = isRecord(body.error) ? body.error : undefined;
      if (body.ok === false && typeof failure?.code === "string" && typeof failure.message === "string") {
        return err({ type: "request-failed" as const, status: response.status, code: failure.code, message: failure.message });
      }
      return err({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} did not contain a valid error envelope.`,
      });
    }
    return validate(body)
      ? ok(body as T)
      : err({
          type: "response-invalid-envelope" as const,
          status: response.status,
          message: `Response from ${requestLabel(input)} did not contain the expected result.`,
        });
  }));
}

function queryPromise<T>(result: ResultAsync<T, WebApiFailure>): Promise<T> {
  return result.match(
    value => value,
    failure => { throw new WebApiError(failure); },
  );
}

export async function getHealth(): Promise<HealthReport> {
  return queryPromise(requestJson<{ health: HealthReport }>("/api/health", undefined, hasField("health", isRecord))).then(value => value.health);
}

export async function listRuns(): Promise<RunRecord[]> {
  return queryPromise(requestJson<{ runs: RunRecord[] }>("/api/runs", undefined, hasField("runs", Array.isArray))).then(value => value.runs);
}

export async function getRunRuntimeSnapshot(runId: string): Promise<RunRuntimeSnapshot> {
  return queryPromise(requestJson<RunRuntimeSnapshot>(
    `/api/runs/${encodeURIComponent(runId)}/runtime-snapshot`,
    undefined,
    body => isRecord(body.run) && isRecord(body.graph),
  ));
}

export async function getNodeInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeInspection> {
  return queryPromise(requestJson<{ inspection: NodeInspection }>(nodeInspectionUrl(runId, target, context), undefined, hasField("inspection", isRecord)))
    .then(value => value.inspection);
}

export async function getNodeExecutionInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeExecutionInspection> {
  return queryPromise(requestJson<{ execution: NodeExecutionInspection }>(nodeInspectionUrl(runId, target, context, "/execution"), undefined, hasField("execution", isRecord)))
    .then(value => value.execution);
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
  const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`;
  return queryPromise(new ResultAsync((async (): Promise<Result<ArtifactPreview, WebApiFailure>> => {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview request failed.") });
    }
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview error body could not be read.") });
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return err({ type: "response-invalid-json", status: response.status, message: "Artifact preview error response was not valid JSON." });
      }
      const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
      if (typeof failure?.code === "string" && typeof failure.message === "string") {
        return err({ type: "request-failed", status: response.status, code: failure.code, message: failure.message });
      }
      return err({ type: "response-invalid-envelope", status: response.status, message: "Artifact preview error response did not contain a valid error envelope." });
    }
    try {
      return ok({ text: await response.text(), mediaType: response.headers.get("content-type") ?? "text/plain" });
    } catch (cause) {
      return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview body could not be read.") });
    }
  })()));
}

export async function submitRunCommand(
  runId: string,
  command: Record<string, unknown>,
): Promise<void> {
  await queryPromise(requestJson<{ ok: true }>(`/api/runs/${encodeURIComponent(runId)}/controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }, body => body.ok === true));
}

export async function listWorkflowCatalog(): Promise<ProjectWorkflowCatalogEntry[]> {
  return queryPromise(requestJson<{ catalog: ProjectWorkflowCatalogEntry[] }>("/api/workflows/catalog", undefined, hasField("catalog", Array.isArray)))
    .then(value => value.catalog);
}

export async function listWorkflowFiles(dir = ""): Promise<WorkflowFiles> {
  return queryPromise(requestJson<{ files: WorkflowFiles }>(`/api/workflows/files?dir=${encodeURIComponent(dir)}`, undefined, hasField("files", isRecord)))
    .then(value => value.files);
}

export async function visualizeWorkflow(source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  return queryPromise(requestJson<{ result: WorkflowVisualizationResult }>("/api/workflows/visualize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  }, hasField("result", isRecord))).then(value => value.result);
}

export async function getConfig(): Promise<ServerConfig> {
  return queryPromise(requestJson<{ config: ServerConfig }>("/api/config", undefined, hasField("config", isRecord))).then(value => value.config);
}

function hasField(key: string, predicate: (value: unknown) => boolean): (body: JsonRecord) => boolean {
  return body => Object.hasOwn(body, key) && predicate(body[key]);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestLabel(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
