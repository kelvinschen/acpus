import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type {
  ArtifactRecord,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunExecutionMetadata,
  RunNodeProgress,
  RunStatus,
} from "../store/store.js";

export type RunInspectionContext = Array<
  | { kind: "fanout"; nodeId: string; itemIndex: number }
  | { kind: "loop"; nodeId: string; iteration: number }
>;

export type RunInspectionQuery =
  | { runId: string; mode: "overview" }
  | { runId: string; mode: "all" }
  | { runId: string; mode: "target"; target: string; context?: RunInspectionContext }
  | { runId: string; mode: "raw" };

export type FollowRunInspectionQuery = (
  | Extract<RunInspectionQuery, { mode: "overview" | "all" }>
  | Extract<RunInspectionQuery, { mode: "target" }>
) & {
  intervalMs?: number;
  signal?: AbortSignal;
};

export type RunInspectionCursor = {
  eventSequence: number;
  progressVersion: number;
};

export type RunInspectionRunSummary = {
  id: string;
  name: string;
  status: RunStatus;
  workflowEntry: string;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  execution: RunDetails["execution"];
};

export type RunInspectionStatus =
  | "not_started"
  | "not_selected"
  | "pending"
  | "starting"
  | "ready"
  | "running"
  | "awaiting"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "mixed";

export type RunInspectionStatusCounts = {
  total: number;
  notStarted?: number;
  notSelected?: number;
  pending?: number;
  starting?: number;
  ready?: number;
  running?: number;
  awaiting?: number;
  completed?: number;
  failed?: number;
  timedOut?: number;
  cancelled?: number;
  mixed?: number;
};

export type RunInspectionFailure = {
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
  };
};

export type RunInspectionDetailedFailure = RunInspectionFailure & {
  upstream?: NonNullable<RunInspectionFailure["upstream"]> & { data?: JsonValue };
};

export type AgentInspectionState = {
  key: string;
  backend?: { kind: "use"; name: string } | { kind: "command" };
  model?: string;
  turnCount?: number;
  lastActivityAt?: string;
  context?: {
    used: number;
    size: number;
  };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  tools?: {
    totalCallCount: number;
    recent: Array<{
      command: string;
      status?: string;
    }>;
  };
  stopReason?: string;
};

export type RunInspectionItem = {
  key: string;
  role: "static" | "context" | "instance" | "frame" | "fold";
  parentKey?: string;
  path: string[];
  label: string;
  kind: string;
  status: RunInspectionStatus;
  nodeId?: string;
  nodeKey?: string;
  frameKey?: string;
  attemptId?: string;
  attemptNo?: number;
  statusReason?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  failure?: RunInspectionFailure;
  agent?: AgentInspectionState;
  task?: {
    target?: "inline" | "module";
  };
  signal?: {
    target: string;
    deadlineAt?: string;
    promptPreview?: string;
    schemaSummary?: string;
    outputSchema?: SchemaIR;
  };
  composite?: {
    strategy?: string;
    quorumCount?: number;
    maxConcurrency?: number;
    currentIteration?: number;
    counts?: RunInspectionStatusCounts;
  };
  fold?: {
    count: number;
    counts: RunInspectionStatusCounts;
  };
};

export type RunInspectionAction =
  | { kind: "inspect-all"; omitted: number }
  | { kind: "inspect-target"; target: string }
  | { kind: "signal"; target: string; schemaSummary?: string }
  | { kind: "retry"; target: string }
  | { kind: "fork" };

export type RunInspectionOmitted = {
  reason: "context-limit";
  limit: number;
  dynamicContexts: number;
  counts: RunInspectionStatusCounts;
  agentProgress?: {
    tracked: number;
  };
};

export type RunInspectionStaticNode = {
  nodeId: string;
  kind: NodeIR["kind"];
  order: number;
  path: string[];
  parentNodeId?: string;
  input?: Record<string, ExprIR>;
  prompt?: ExprIR;
  outputSchema?: SchemaIR;
  agent?: string;
  agentDefinition?: AgentDefinitionIR;
};

export type RunInspectionSnapshot = {
  schemaVersion: 1;
  kind: "snapshot";
  cursor: RunInspectionCursor;
  run: RunInspectionRunSummary;
  counts: RunInspectionStatusCounts;
  items: RunInspectionItem[];
  actions: RunInspectionAction[];
  omitted?: RunInspectionOmitted;
  hooks?: RunDetails["hooks"];
  output?: JsonValue;
};

export type RunInspectionTarget = {
  kind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
};

export type RunInspectionTargetSummary = {
  targetKind: RunInspectionTarget["kind"];
  targetId: string;
  runStatus: RunStatus;
  runStartedAt: string;
  runFinishedAt?: string;
  runDurationMs?: number;
  nodeId?: string;
  nodeKey?: string;
  frameKey?: string;
  nodeStatus?: string;
  staticKind?: string;
  staticOrder?: number;
  input?: { kind: "runtime" | "authored"; value: unknown };
  output?: unknown;
  failure?: RunInspectionDetailedFailure;
  prompt?: {
    kind: "signal" | "artifact" | "authored";
    text?: string;
    artifactId?: string;
    path?: string;
    mediaType?: string;
    field?: "prompt";
  };
  latestAttempt?: {
    attemptId: string;
    attemptNo: number;
    status: string;
    startedAt: string;
    finishedAt?: string;
    error?: unknown;
    result?: unknown;
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
  agent?: RunInspectionItem["agent"];
  agentDefinition?: AgentDefinitionIR;
  signal?: RunInspectionItem["signal"];
  artifacts: ArtifactRecord[];
};

export type RunInspectionTargetDocument = {
  schemaVersion: 1;
  kind: "target";
  cursor: RunInspectionCursor;
  run: RunInspectionRunSummary;
  target: RunInspectionTarget;
  staticNode?: RunInspectionStaticNode;
  summary: RunInspectionTargetSummary;
  items: RunInspectionItem[];
  instances: RunDynamicNodeInstance[];
  frames: RunDynamicFrame[];
  attempts: RunDynamicAttempt[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
  progress: RunNodeProgress[];
  artifacts: ArtifactRecord[];
};

export type RunInspectionRaw = {
  schemaVersion: 1;
  kind: "raw";
  cursor: RunInspectionCursor;
  run: RunDetails;
  workflow: WorkflowIR;
  artifacts: ArtifactRecord[];
};

export type RunInspectionDocument = RunInspectionSnapshot | RunInspectionTargetDocument | RunInspectionRaw;

export type RunInspectionChange = {
  sequence?: number;
  at: string;
  entity: {
    kind: "run" | "node" | "frame" | "attempt" | "group" | "group-member" | "signal" | "control" | "progress";
    id: string;
    nodeId?: string;
  };
  subject: string;
  action:
    | "admitted"
    | "ready"
    | "started"
    | "awaiting"
    | "requeued"
    | "retrying"
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "paused"
    | "resumed"
    | "consumed"
    | "advanced"
    | "progress"
    | "updated";
  status?: RunInspectionStatus;
  attemptNo?: number;
  progressVersion?: number;
  itemKey?: string;
  message?: string;
  summary?: {
    kind: "omitted-agent-progress";
    changed: number;
    tracked: number;
  };
};

export type RunInspectionPatch = {
  upsertItems: RunInspectionItem[];
  removeItemKeys: string[];
  itemOrder?: string[];
  counts?: RunInspectionStatusCounts;
  actions?: RunInspectionAction[];
  omitted?: RunInspectionOmitted | null;
  hooks?: RunDetails["hooks"];
};

export type RunInspectionEmission =
  | {
      schemaVersion: 1;
      kind: "snapshot";
      cursor: RunInspectionCursor;
      document: RunInspectionSnapshot | RunInspectionTargetDocument;
    }
  | {
      schemaVersion: 1;
      kind: "update";
      cursor: RunInspectionCursor;
      run: RunInspectionRunSummary;
      changes: RunInspectionChange[];
      patch: RunInspectionPatch;
    }
  | {
      schemaVersion: 1;
      kind: "resync";
      cursor: RunInspectionCursor;
      reason: "cursor-gap" | "projection-drift";
      document: RunInspectionSnapshot | RunInspectionTargetDocument;
    }
  | {
      schemaVersion: 1;
      kind: "done";
      cursor: RunInspectionCursor;
      run: RunInspectionRunSummary;
      output?: JsonValue;
    };

export type RunInspectionError =
  | { type: "runtime-store-not-found"; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "target-not-found"; runId: string; target: string; message: string }
  | { type: "invalid-query"; message: string }
  | { type: "inspection-read-failed"; runId: string; message: string; cause?: unknown };
