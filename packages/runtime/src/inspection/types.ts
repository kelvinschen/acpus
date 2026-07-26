import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTelemetryAvailability } from "@acpus/agent-executor";
import type {
  ArtifactRecord,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunExecutionMetadata,
  RunForkInfo,
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
  | { runId: string; mode: "target"; target: string; context?: RunInspectionContext; view?: "summary" }
  | {
      runId: string;
      mode: "timeline";
      target: string;
      context?: RunInspectionContext;
      page?: { limit?: number; before?: string };
    }
  | { runId: string; mode: "details"; target: string; context?: RunInspectionContext }
  | { runId: string; mode: "raw" };

export type FollowRunInspectionQuery = (
  | Extract<RunInspectionQuery, { mode: "overview" | "all" }>
  | Extract<RunInspectionQuery, { mode: "target" }>
  | Extract<RunInspectionQuery, { mode: "timeline" }>
) & {
  intervalMs?: number;
  signal?: AbortSignal;
  after?: RunInspectionRevision;
};

/** Internal projection versions. Public inspection documents expose only a revision. */
export type RunInspectionCursor = {
  eventSequence: number;
  progressVersion: number;
  observationVersion: number;
};

declare const inspectionRevisionBrand: unique symbol;
export type RunInspectionRevision = string & { readonly [inspectionRevisionBrand]: true };

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
  tools?: {
    totalCallCount: number;
    recent: Array<{
      command: string;
      status?: string;
    }>;
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
  | { kind: "inspect-all"; omitted: number }
  | { kind: "inspect-target"; target: string; itemKey: string }
  | { kind: "signal"; target: string; itemKey: string; schemaSummary?: string }
  | { kind: "retry"; target: string; itemKey: string }
  | { kind: "fork"; itemKey?: string };

export type RunInspectionAction =
  | { kind: "inspect-timeline"; target: string }
  | { kind: "follow-target"; target: string }
  | { kind: "steer"; target: string }
  | { kind: "signal"; target: string; schemaSummary?: string }
  | { kind: "retry"; target?: string }
  | { kind: "fork"; target?: string };

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
  schemaVersion: 2;
  kind: "snapshot";
  revision: RunInspectionRevision;
  run: RunInspectionDecisionRunSummary;
  counts: RunInspectionStatusCounts;
  items: RunInspectionItem[];
  availableActions: RunInspectionOverviewAction[];
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
  counts?: RunInspectionStatusCounts;
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
  agent?: AgentInspectionState;
  agentDefinition?: AgentDefinitionIR;
  signal?: RunInspectionItem["signal"];
  artifacts: ArtifactRecord[];
};

export type RunInspectionTargetDetailsDocument = {
  schemaVersion: 2;
  kind: "details";
  revision: RunInspectionRevision;
  run: RunInspectionRunSummary;
  target: RunInspectionTarget;
  staticNode?: RunInspectionStaticNode;
  summary: RunInspectionTargetSummary;
  items: RunInspectionItem<AgentInspectionState>[];
  instances: RunDynamicNodeInstance[];
  frames: RunDynamicFrame[];
  attempts: RunDynamicAttempt[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
  progress: RunNodeProgress[];
  artifacts: ArtifactRecord[];
};

export type RunInspectionSubject = {
  targetKind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
  label: string;
  kind: string;
  nodeId?: string;
  nodeKey?: string;
  attemptId?: string;
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

export type AgentAttemptEvidenceCapsule = {
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

export type RunInspectionTargetSummaryDocument = {
  schemaVersion: 2;
  kind: "target";
  revision: RunInspectionRevision;
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
  evidence?: AgentAttemptEvidenceCapsule;
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

type CurrentActivityChanges<T, Stable extends keyof T> = Partial<{
  [Key in Exclude<keyof T, Stable>]: T[Key] | null;
}>;

export type RunInspectionCurrentActivityPatch =
  | {
      kind: "agent";
      attemptId: string;
      attemptNo?: number;
      turn?: number;
      turnKind?: AgentCurrentActivity["turnKind"];
      changes: CurrentActivityChanges<AgentCurrentActivity, "kind" | "attemptId" | "attemptNo" | "turn" | "turnKind">;
    }
  | {
      kind: "task" | "composite";
      changes: CurrentActivityChanges<
        Extract<RunInspectionCurrentActivity, { kind: "task" | "composite" }>,
        "kind"
      >;
    }
  | {
      kind: "signal";
      changes: CurrentActivityChanges<Extract<RunInspectionCurrentActivity, { kind: "signal" }>, "kind">;
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
      kind: "gap";
      at: string;
      dropped: number;
      reason: string;
    };

export type RunInspectionTimelineDocument = {
  schemaVersion: 2;
  kind: "timeline";
  revision: RunInspectionRevision;
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
    returned: number;
    omittedBefore: number;
    hasOlder: boolean;
    olderCursor?: string;
    retentionOmittedBefore?: number;
  };
};

export type RunInspectionRaw = {
  schemaVersion: 2;
  kind: "raw";
  revision: RunInspectionRevision;
  run: RunDetails;
  workflow: WorkflowIR;
  artifacts: ArtifactRecord[];
};

export type RunInspectionDocument =
  | RunInspectionSnapshot
  | RunInspectionTargetSummaryDocument
  | RunInspectionTimelineDocument
  | RunInspectionTargetDetailsDocument
  | RunInspectionRaw;

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

export type RunInspectionPatch = {
  upsertItems: RunInspectionItem[];
  removeItemKeys: string[];
  itemOrder?: string[];
  counts?: RunInspectionStatusCounts;
  availableActions?: RunInspectionOverviewAction[];
  omitted?: RunInspectionOmitted | null;
  hooks?: RunDetails["hooks"];
};

export type RunInspectionDelta =
  | {
      kind: "overview";
      run: RunInspectionDecisionRunSummary;
      changes: RunInspectionChange[];
      patch: RunInspectionPatch;
    }
  | {
      kind: "run";
      run: { id: string; status: RunStatus; updatedAt: string };
    }
  | {
      kind: "state";
      state: RunInspectionTargetState;
    }
  | {
      kind: "pulse";
      pulse: RunInspectionPulse | null;
    }
  | {
      kind: "attention";
      attention: RunInspectionAttention | null;
    }
  | {
      kind: "visibility";
      visibility: RunInspectionVisibility | null;
    }
  | {
      kind: "available-actions";
      availableActions: RunInspectionAction[];
    }
  | {
      kind: "current";
      current: RunInspectionCurrentActivity | null;
    }
  | {
      kind: "current-patch";
      patch: RunInspectionCurrentActivityPatch;
    }
  | {
      kind: "recent";
      upsert: RunInspectionTimelineEntry[];
      order: string[];
      page: Omit<RunInspectionTimelineDocument["recent"], "entries">;
    }
  | {
      kind: "evidence";
      evidence: AgentAttemptEvidenceCapsule | null;
    };

export type FollowableInspectionDocument =
  | RunInspectionSnapshot
  | RunInspectionTargetSummaryDocument
  | RunInspectionTimelineDocument;

export type RunInspectionEmission =
  | {
      schemaVersion: 2;
      kind: "snapshot";
      revision: RunInspectionRevision;
      document: FollowableInspectionDocument;
    }
  | {
      schemaVersion: 2;
      kind: "delta";
      revision: RunInspectionRevision;
      changes: RunInspectionDelta[];
    }
  | {
      schemaVersion: 2;
      kind: "resync";
      revision: RunInspectionRevision;
      reason: "cursor-gap" | "projection-drift";
      document: FollowableInspectionDocument;
    }
  | {
      schemaVersion: 2;
      kind: "done";
      revision: RunInspectionRevision;
      run: { id: string; status: RunStatus };
      output?: JsonValue;
    };

export type RunInspectionError =
  | { type: "runtime-store-not-found"; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "target-not-found"; runId: string; target: string; message: string }
  | { type: "target-ambiguous"; runId: string; target: string; candidateKeys: string[]; message: string }
  | { type: "invalid-cursor"; runId: string; target?: string; message: string }
  | { type: "invalid-query"; message: string }
  | { type: "inspection-read-failed"; runId: string; message: string; cause?: unknown };
