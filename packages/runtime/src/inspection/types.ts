import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTelemetryAvailability } from "@acpus/agent-executor";
import type {
  ArtifactRecord,
  RunDetails,
  RunForkInfo,
  RunStatus,
} from "../store/store.js";

/** Agent-facing inspection jobs. Each job owns only the inputs it needs. */
export type InspectRunQuery = {
  runId: string;
  includeAllTopology?: boolean;
  includeControls?: boolean;
};

export type InspectTargetQuery = {
  runId: string;
  target: string;
  includeAllTopology?: boolean;
  includeControls?: boolean;
  page?: number;
  limit?: number;
};

export type InspectTimelineQuery = {
  runId: string;
  target: string;
  page?: number;
  limit?: number;
};

export type InspectEvidenceQuery = {
  runId: string;
  target: string;
  page?: number;
  limit?: number;
};

export type InspectRawQuery = { runId: string };

export type InspectNodeQuery = { runId: string; target: string };
export type InspectAgentExecutionQuery = { runId: string; target: string };
export type InspectTargetArtifactsQuery = { runId: string; target: string };

export type WatchInspectionView =
  | { kind: "run"; runId: string; includeAllTopology?: boolean; includeControls?: boolean }
  | { kind: "target"; runId: string; target: string; includeAllTopology?: boolean; includeControls?: boolean }
  | { kind: "timeline"; runId: string; target: string; limit?: number };

export type WatchInspectionQuery = {
  view: WatchInspectionView;
  signal?: AbortSignal;
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
  failure?: RunInspectionFailure;
  fork?: RunForkInfo;
  agentUsage?: {
    instances: number;
    attempts: number;
    turns: number;
  };
};

export type RunInspectionDecisionRunSummary = Omit<RunInspectionRunSummary, "agentUsage">;

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
  availability: AgentTelemetryAvailability;
  backend?: { kind: "use"; name: string } | { kind: "command" };
  model?: string;
  turnCount?: number;
  lastObservedAt?: string;
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
  stopReason?: string;
};

export type AgentDecisionState = {
  key: string;
  turn?: number;
  activeTool?: {
    command: string;
    status?: string;
  };
};

export type RunInspectionScopeState =
  | {
      kind: "branch";
      ownerKind: "if" | "switch";
      branchId: string;
      selection: "undecided" | "selected" | "not_selected";
      empty: boolean;
    }
  | {
      kind: "branch";
      ownerKind: "parallel";
      branchId: string;
      empty: boolean;
    }
  | { kind: "fanout_item"; itemIndex: number; empty: boolean }
  | { kind: "loop_iteration"; iteration: number; round: number; empty: boolean };

export type RunInspectionItem<AgentState extends { key: string } = AgentDecisionState> = {
  key: string;
  role: "static" | "context" | "instance" | "frame" | "fold";
  parentKey?: string;
  path: string[];
  label: string;
  kind: string;
  status: RunInspectionStatus;
  nodeId?: string;
  ref?: string;
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
  agent?: AgentState;
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
  scope?: RunInspectionScopeState;
  fold?: {
    count: number;
    counts: RunInspectionStatusCounts;
  };
};

export type RunInspectionOverviewAction =
  | { kind: "signal"; target: string; itemKey: string; schemaSummary?: string }
  | { kind: "retry"; target: string; itemKey: string }
  | { kind: "cancel"; target?: string; itemKey?: string }
  | { kind: "steer"; target: string; itemKey: string };

export type RunInspectionAction =
  | { kind: "inspect-timeline"; target: string }
  | { kind: "follow-target"; target: string }
  | { kind: "steer"; target: string }
  | { kind: "signal"; target: string; schemaSummary?: string }
  | { kind: "retry"; target?: string }
  | { kind: "cancel"; target?: string };

export type RunInspectionStaticNode = {
  nodeId: string;
  kind: NodeIR["kind"];
  order: number;
  path: string[];
  parentNodeId?: string;
  prompt?: ExprIR;
  outputSchema?: SchemaIR;
  agent?: string;
  agentDefinition?: AgentDefinitionIR;
};

export type RunInspectionSnapshot = {
  schemaVersion: 2;
  kind: "snapshot";
  run: RunInspectionDecisionRunSummary;
  counts: RunInspectionStatusCounts;
  items: RunInspectionItem[];
  availableActions: RunInspectionOverviewAction[];
  hooks?: RunDetails["hooks"];
  output?: JsonValue;
  all?: true;
  scope?: {
    ref: string;
  };
};

export type RunInspectionTarget = {
  kind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
  ref?: string;
};

export type RunInspectionCandidate = {
  ref: string;
  status: RunInspectionStatus;
  breadcrumb: string;
  kind: "dynamic-node" | "frame";
  nodeId?: string;
};

export type InspectTargetResult =
  | RunInspectionTargetSummaryDocument
  | RunInspectionCandidatesDocument
  | RunInspectionSnapshot;

export type RunInspectionCandidatesDocument = {
  schemaVersion: 2;
  kind: "candidates";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  target: string;
  candidates: {
    entries: RunInspectionCandidate[];
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
    nextPage?: number;
  };
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
  counts?: RunInspectionStatusCounts;
  staticKind?: string;
  staticOrder?: number;
  input?: { kind: "runtime"; value: JsonValue } | { kind: "authored"; value: string };
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
  agent?: AgentInspectionState;
  agentDefinition?: AgentDefinitionIR;
  signal?: RunInspectionItem["signal"];
  artifacts: ArtifactRecord[];
};

export type RunInspectionControl =
  | { type: "retry" | "steer"; target: string }
  | { type: "cancel"; target?: string };

/** Web's one-target read. The resolved dossier remains private to Runtime. */
export type RunInspectionNodeDocument = {
  schemaVersion: 2;
  kind: "node";
  run: RunInspectionRunSummary;
  subject: RunInspectionSubject;
  summary: RunInspectionTargetSummary;
  availableControls: RunInspectionControl[];
  artifacts: ArtifactRecord[];
};

/** CLI's one-target artifact read. */
export type RunInspectionTargetArtifactsDocument = {
  schemaVersion: 2;
  kind: "artifacts";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
  artifacts: ArtifactRecord[];
};

export type RunInspectionSubject = {
  targetKind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
  ref?: string;
  label: string;
  kind: string;
  nodeId?: string;
  attemptNo?: number;
};

export type RunInspectionTargetState = {
  status: RunInspectionStatus;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  durationMs?: number;
};

export type RunInspectionAgentExecutionToolCall = {
  turn: number;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  durationMs?: number;
  inputPreview?: string;
};

export type RunInspectionAgentExecutionDocument = ({
  available: true;
  reason?: never;
} | {
  available: false;
  reason: "not-agent" | "not-started";
}) & {
  schemaVersion: 2;
  kind: "execution";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
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
  visibility?: RunInspectionVisibility;
  recentTools: RunInspectionAgentExecutionToolCall[];
};

export type RunInspectionPulse = {
  phase: "starting" | "responding" | "reported-thought" | "planning" | "tool" | "output-repair" | "settling" | "settled";
  headline?: string;
  turn?: number;
  updatedAt: string;
};

export type RunInspectionAttention = {
  code: "terminal_failure" | "timed_out" | "awaiting_input";
  summary: string;
};

export type RunInspectionVisibility = {
  state: "degraded";
  reason:
    | "boundary-evidence-unavailable"
    | "observation-gap"
    | "unrecognized-provider-activity";
};

type EvidenceMetadata = {
  directory: string;
  state: "recording" | "sealed" | "partial";
  completeness: "complete" | "degraded";
  turnCount: number;
  omittedTurns: number;
  gapCount: number;
  providerOutcome?: "completed" | "failed" | "cancelled" | "timed_out";
  schedulerDisposition: "pending" | "committed" | "discarded";
  dispositionReason?: string;
  records: Array<{
    turn: number;
    file: string;
    prompt: {
      kind: "task" | "continuation" | "steer" | "repair";
      bytes: number;
      digest: string;
    };
    lastDurableResponseBytes: number;
    responseAtFenceBytes?: number;
    finalObservedResponseBytes?: number;
    trace?: {
      state: "recording" | "sealed" | "partial" | "published";
      file?: string;
      bytes?: number;
      digest?: string;
    };
  }>;
};

export type RunInspectionEvidenceRecord = EvidenceMetadata["records"][number];

export type RunInspectionEvidenceDocument = {
  schemaVersion: 2;
  kind: "evidence";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
  visibility?: RunInspectionVisibility;
  evidence: Omit<EvidenceMetadata, "records" | "omittedTurns"> & {
    records: {
      entries: RunInspectionEvidenceRecord[];
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
      nextPage?: number;
    };
  };
};

export type RunInspectionEvidenceCandidate = {
  target: string;
  attemptNo: number;
  status: RunInspectionStatus;
  breadcrumb: string;
};

export type RunInspectionEvidenceCandidatesDocument = {
  schemaVersion: 2;
  kind: "evidence-candidates";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  target: string;
  candidates: {
    entries: RunInspectionEvidenceCandidate[];
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
    nextPage?: number;
  };
};

export type RunInspectionTargetSummaryDocument = {
  schemaVersion: 2;
  kind: "target";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
  state: RunInspectionTargetState;
  pulse?: RunInspectionPulse;
  attention?: RunInspectionAttention;
  visibility?: RunInspectionVisibility;
  availableActions: RunInspectionAction[];
  occurrence?: {
    total: number;
    counts: RunInspectionStatusCounts;
  };
};

export type RunInspectionExcerpt = {
  text: string;
  originalBytes: number;
  truncated: boolean;
};

export type RunInspectionToolActivity = {
  toolCallId?: string;
  name: string;
  status?: string;
  input?: RunInspectionExcerpt;
  output?: RunInspectionExcerpt;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
};

export type AgentCurrentActivity = {
  kind: "agent";
  attemptId: string;
  attemptNo?: number;
  postFence?: true;
  turn?: number;
  turnKind?: "task" | "continuation" | "steer" | "repair";
  phase: RunInspectionPulse["phase"];
  updatedAt: string;
  response?: RunInspectionExcerpt;
  intent?: {
    kind: "plan" | "reported-thought";
    excerpt: RunInspectionExcerpt;
  };
  tools?: {
    active: RunInspectionToolActivity[];
    omittedActive: number;
  };
};

export type RunInspectionCurrentActivity =
  | AgentCurrentActivity
  | {
      kind: "task" | "composite";
      phase: "starting" | "running" | "settling";
      updatedAt: string;
      message?: string;
    }
  | {
      kind: "signal";
      phase: "awaiting";
      updatedAt: string;
      deadlineAt?: string;
      prompt?: RunInspectionExcerpt;
      schemaSummary?: string;
    };

export type RunInspectionTimelineEntry =
  | {
      id: string;
      kind: "transition";
      at: string;
      action: RunInspectionChange["action"];
      status?: RunInspectionStatus;
      attemptId?: string;
      attemptNo?: number;
      summary?: RunInspectionExcerpt;
    }
  | {
      id: string;
      kind: "activity";
      at: string;
      attemptId?: string;
      attemptNo?: number;
      postFence?: true;
      turn?: number;
      channel: "response" | "reported-thought" | "plan" | "tool";
      summary: RunInspectionExcerpt;
      tool?: RunInspectionToolActivity;
    }
  | {
      id: string;
      kind: "control";
      at: string;
      action: "steered" | "paused" | "resumed" | "retried" | "cancelled";
      attemptId?: string;
      attemptNo?: number;
      responseAtFenceBytes?: number;
    }
  | {
      id: string;
      kind: "phase";
      at: string;
      attemptId?: string;
      attemptNo?: number;
      turn?: number;
      phase: Exclude<RunInspectionCurrentActivity["phase"], "awaiting">;
    }
  | {
      id: string;
      kind: "visibility";
      at: string;
      state: "degraded" | "restored";
      reason?: RunInspectionVisibility["reason"];
    }
  | {
      id: string;
      kind: "gap";
      at: string;
      dropped: number;
      reason: string;
    };

export type RunInspectionTimelineDocument = {
  schemaVersion: 2;
  kind: "timeline";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
  state: RunInspectionTargetState;
  visibility?: RunInspectionVisibility;
  current?: RunInspectionCurrentActivity;
  recent: {
    entries: RunInspectionTimelineEntry[];
    page: number;
    limit: number;
    returned: number;
    omittedBefore: number;
    hasOlder: boolean;
    olderPage?: number;
    retentionOmittedBefore?: number;
  };
};

export type RunInspectionRaw = {
  schemaVersion: 2;
  kind: "raw";
  run: RunDetails;
  workflow: WorkflowIR;
  artifacts: ArtifactRecord[];
};

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
    | "steered"
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

type WatchInspectionDocument =
  | RunInspectionSnapshot
  | RunInspectionTargetSummaryDocument
  | RunInspectionTimelineDocument;

export type WatchInspectionEmission =
  | {
      schemaVersion: 2;
      kind: "view";
      document: WatchInspectionDocument;
    }
  | {
      schemaVersion: 2;
      kind: "timeline-entry";
      entry: RunInspectionTimelineEntry;
    };

export type RunInspectionError =
  | { type: "runtime-store-not-found"; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "target-not-found"; runId: string; target: string; message: string }
  | {
      type: "target-ambiguous";
      runId: string;
      target: string;
      candidates: RunInspectionCandidatesDocument;
      message: string;
    }
  | { type: "target-ref-collision"; runId: string; target: string; candidateKeys: string[]; message: string }
  | { type: "invalid-query"; message: string }
  | {
      type: "inspection-sequence-discontinuity";
      runId: string;
      expected: number;
      actual: number;
      message: string;
    }
  | { type: "inspection-read-failed"; runId: string; message: string; cause?: unknown };
