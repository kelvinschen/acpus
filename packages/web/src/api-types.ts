import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue, StaticExprShape } from "@acpus/expression/ir";
import type { RunInspectionStatus } from "@acpus/runtime";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import type { WebGraph } from "./graph-types.js";

export type WorkflowVisualizationSource =
  | { kind: "catalog"; name: string }
  | { kind: "file"; path: string };

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

export type WebControlCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry"; target: string }
  | { type: "cancel"; target?: string }
  | { type: "signal"; target: string; payload: JsonValue };

export type WorkflowContext = Pick<WorkflowIR, "name" | "description" | "agents">;

export type WorkflowVisualizationResult =
  | {
    status: "ready";
    graph: WebGraph;
    workflow: WorkflowContext & { irVersion: number; nodeCount: number };
    contract: {
      inputSchema?: WorkflowIR["inputSchema"];
      output: WorkflowIR["root"]["output"];
      outputShape: StaticExprShape;
    };
    sourceGraphDigest: string;
  }
  | {
    status: "failed";
    phase: WorkflowPreparationFailure["phase"];
    message: string;
  };

export type NodeInspectionFailure = {
  origin: "provider" | "runtime" | "scheduler" | "task" | "signal" | "unknown";
  code?: string;
  message: string;
  upstream?: {
    source: "acpx";
    operation?: string;
    exitCode?: number;
    code?: string;
    origin?: string;
    protocol?: {
      name: "json-rpc";
      code?: string | number;
      message?: string;
    };
    data?: JsonValue;
  };
};

export type NodeInspection = {
  nodeId?: string;
  nodeKey?: string;
  frameKey?: string;
  cancelTarget?: string;
  staticKind?: string;
  runStartedAt: string;
  runDurationMs?: number;
  latestAttempt?: {
    attemptNo: number;
    status: string;
  };
  agent?: {
    key: string;
    model?: string;
    lastObservedAt?: string;
  };
  input?: {
    kind: "runtime" | "authored";
    value: unknown;
  };
  prompt?: {
    kind: "signal" | "artifact" | "authored";
    text?: string;
    artifactId?: string;
    mediaType?: string;
  };
  loopProgress?: {
    frameKey: string;
    index: number;
    round: number;
    state?: unknown;
    stop?: boolean;
    transition?: unknown;
    activeIterationFrameKey?: string;
    activeChildNodeKeys: string[];
  };
  output?: unknown;
  failure?: NodeInspectionFailure;
  artifacts: Array<{
    id: string;
    path: string;
    size: number;
    mediaType?: string;
  }>;
  awaitingSignal?: {
    target: string;
    prompt?: string;
  };
};

export type NodeExecutionInspection = ({
  available: true;
  reason?: never;
} | {
  available: false;
  reason: string;
}) & {
  summary: {
    status: RunInspectionStatus;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastObservedAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: "prompt_response" | "usage_update";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  recentTools: Array<{
    turn: number;
    toolCallId?: string;
    toolName?: string;
    status?: string;
    durationMs?: number;
    inputPreview?: string;
  }>;
};

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
  runtimeVersion?: number;
};

export type RunControlTarget = {
  target: string;
  kind: "node" | "frame";
  nodeId?: string;
};

export type RunRuntimeControls = {
  canCancelRun: boolean;
  retryTargets: RunControlTarget[];
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
  workflow: WorkflowContext;
  graph: WebGraph;
  controls: RunRuntimeControls;
};
