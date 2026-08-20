import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTelemetryAvailability } from "@acpus/agent-executor";
import type { ArtifactRecord } from "../artifacts/types.js";
import type { FrozenAgentBinding } from "../agents/injections.js";
import type {
  RunDetails,
  RunForkInfo,
  RunStatus,
} from "../store/store.js";
import type { RuntimeAgentSessionInspection } from "../scheduler/store-port.js";
import type { RuntimeSteerProjection } from "../scheduler/steer-lifecycle.js";

export type InspectNodeQuery = { runId: string; target: string };
export type InspectAgentExecutionQuery = { runId: string; target: string };
export type InspectTargetArtifactsQuery = { runId: string; target: string };

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
  agentSessions?: readonly RuntimeAgentSessionInspection[];
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

type RunInspectionFailure = {
  origin: "provider" | "runtime" | "scheduler" | "task" | "signal" | "unknown";
  code?: string;
  message: string;
  upstream?: {
    source: "acp";
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
  backend?: { kind: "use"; name: string } | { kind: "command" };
};

type RunInspectionScopeState =
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

export type RunInspectionTarget = {
  kind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
  ref?: string;
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
  agentSession?: RuntimeAgentSessionInspection;
  steer?: RuntimeSteerProjection;
};

export type RunInspectionControl =
  | { type: "retry"; target: string }
  | { type: "steer"; target: string; delivery: "interrupt_continue"; effect: "cancel_drain_then_continue" }
  | { type: "cancel"; target?: string };

/** Web's one-target read. The resolved dossier remains private to Runtime. */
export type RunInspectionNodeDocument = {
  schemaVersion: 2;
  kind: "node";
  run: RunInspectionRunSummary;
  subject: RunInspectionSubject;
  state: RunInspectionTargetState;
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
    agentSessionId?: string;
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

export type RunInspectionVisibility = {
  state: "degraded";
  reason:
    | "observation-gap"
    | "unrecognized-provider-activity";
};

export type RunInspectionExcerpt = {
  text: string;
  originalBytes: number;
  truncated: boolean;
};

type RunInspectionToolActivity = {
  toolCallId?: string;
  name: string;
  title?: string;
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
  turnKind?: "task" | "steer" | "repair";
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

export type InspectionCandidates = {
  kind: "candidates";
  run: {
    id: string;
    status: RunStatus;
  };
  target: string;
  entries: Array<{
    selector: string;
    status: RunInspectionStatus;
    breadcrumb: string;
  }>;
};

export type RunInspectionError =
  | { type: "runtime-store-not-found"; message: string }
  | RuntimeStoreRepairRequiredInspectionError
  | RuntimeStoreUnsupportedInspectionError
  | RuntimeStoreUnavailableInspectionError
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "target-not-found"; runId: string; target: string; message: string }
  | {
      type: "target-ambiguous";
      runId: string;
      target: string;
      candidates: InspectionCandidates;
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

// The coherent view and observation documents below are the public CLI/LLM
// surface. Narrow Inspector/Web documents above share only ambiguity results.

export type InspectionViewQuery =
  | { kind: "run"; runId: string; structure?: "materialized" }
  | {
      kind: "target";
      runId: string;
      target: string;
      detail: "summary" | "timeline" | "forensics";
    };

export type ObservableInspectionViewQuery =
  | { kind: "run"; runId: string; structure?: "materialized" }
  | {
      kind: "target";
      runId: string;
      target: string;
      detail: "summary" | "timeline";
    };

export type ObserveInspectionQuery = {
  view: ObservableInspectionViewQuery;
  until: "subject-terminal" | "decision-boundary";
  updates?: "decision" | "activity";
  signal?: AbortSignal;
};

type InspectionStatus = RunInspectionStatus;

export type InspectionVisibleReason =
  | "retry"
  | "steer"
  | "resume"
  | "operator-cancelled"
  | "parent-cancelled"
  | "branch-selected"
  | "race-selected"
  | "quorum-selected"
  | "superseded";

export type InspectionCounts = {
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

export type InspectionProgress = {
  completed: number;
  total: number;
};

export type InspectionFailure = {
  origin: RunInspectionFailure["origin"];
  code?: string;
  message: string;
};

export type InspectionVisibleState = {
  status: InspectionStatus;
  durationMs?: number;
  failure?: InspectionFailure;
};

export type InspectionRun = {
  id: string;
  name: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  liveness?: "active" | "inactive" | "stale" | "terminal" | "unknown";
  failure?: InspectionFailure;
  fork?: {
    sourceRunId: string;
  };
  agentSessions?: readonly RuntimeAgentSessionInspection[];
};

type InspectionRunRef = {
  id: string;
  status: RunStatus;
};

export type InspectionSubject = {
  label: string;
  kind: string;
  selector?: string;
};

export type ForensicsAgentBinding = FrozenAgentBinding;

export type ForensicsScopeDefinition = {
  nodes: string[];
  output: string;
};

export type ForensicsDefinition =
  | {
      kind: "workflow";
      name: string;
      description?: string;
      inputSchema?: SchemaIR;
      agents: Record<string, {
        profile: AgentDefinitionIR;
        binding: ForensicsAgentBinding;
      }>;
      root: ForensicsScopeDefinition;
    }
  | {
      kind: "agent";
      agent: string;
      profile: AgentDefinitionIR;
      binding: ForensicsAgentBinding;
      prompt: string;
      permissionMode?: "approve-reads" | "approve-all" | "deny-all";
      sessionKey?: string;
      cwd?: string;
      env?: Record<string, string>;
      outputSchema?: SchemaIR;
      timeout?: string;
    }
  | {
      kind: "task";
      input: string;
      implementation:
        | "inline"
        | { kind: "module"; specifier: string; export: string };
      cwd?: string;
      env?: Record<string, string>;
      defaultCommandTimeout?: string;
      timeout?: string;
    }
  | {
      kind: "signal";
      prompt: string;
      outputSchema?: SchemaIR;
      timeout?: string;
      onTimeoutMessage?: string;
    }
  | {
      kind: "assert";
      condition: string;
      message?: string;
    }
  | {
      kind: "if";
      condition: string;
      branches: {
        then: ForensicsScopeDefinition;
        else: ForensicsScopeDefinition;
      };
    }
  | {
      kind: "switch";
      cases: Array<{ id: string; when: string; then: ForensicsScopeDefinition }>;
      default: ForensicsScopeDefinition;
    }
  | {
      kind: "parallel";
      strategy: "all" | "race";
      maxConcurrency?: string;
      branches: Record<string, ForensicsScopeDefinition>;
    }
  | {
      kind: "fanout";
      over: string;
      strategy: "all" | "quorum";
      count?: string;
      maxConcurrency?: string;
      do: ForensicsScopeDefinition;
    }
  | {
      kind: "loop";
      state: string;
      do: {
        nodes: string[];
        transition: { state: string; stop: string };
      };
    };

export type ForensicsExecutionContext =
  | {
      kind: "branch";
      nodeId: string;
      ownerKind: "if" | "switch" | "parallel";
      branchId: string;
    }
  | {
      kind: "fanout";
      nodeId: string;
      itemIndex: number;
      item: JsonValue;
    }
  | {
      kind: "loop";
      nodeId: string;
      index: number;
      round: number;
      state?: JsonValue;
    };

type ForensicsResolvedInvocationBase = {
  status: "resolved";
  context?: ForensicsExecutionContext[];
};

export type ForensicsInvocation =
  | {
      status: "unavailable";
      reason: "not_started" | "not_selected" | "not_yet_resolved" | "resolution_failed" | "not_recorded";
      context?: ForensicsExecutionContext[];
    }
  | (ForensicsResolvedInvocationBase & {
      kind: "workflow";
      input: JsonValue;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "agent";
      attempt: number;
      promptOrigin: "authored" | "steering" | "repair";
      prompt: string;
      cwd: string;
      env: Record<string, string>;
      model?: string;
      permissionMode: "approve-reads" | "approve-all" | "deny-all";
      sessionKey?: string;
      config?: Record<string, string>;
      deadlineAt?: string;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "task";
      attempt: number;
      input: JsonValue;
      cwd: string;
      env: Record<string, string>;
      timeoutMs?: number;
      defaultCommandTimeout?: string;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "signal";
      prompt: string;
      deadlineAt?: string;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "assert";
      condition: boolean;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "if" | "switch";
      selectedBranch: string;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "parallel";
      maxConcurrency?: number;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "fanout";
      items: JsonValue[];
      quorumCount?: number;
      maxConcurrency?: number;
    })
  | (ForensicsResolvedInvocationBase & {
      kind: "loop";
      index: number;
      round: number;
      state?: JsonValue;
      transition?: JsonValue;
    });

export type ForensicsResult =
  | { status: "accepted"; value: JsonValue }
  | { status: "completed_without_output" }
  | { status: "pending" | "not_started" | "not_selected" | "cancelled" | "not_accepted" }
  | { status: "failed" | "timed_out"; code?: string; message: string };

type InspectionTreeSubject = InspectionSubject;

export type InspectionToolActivity = {
  name: string;
  title?: string;
  state: "running" | "completed" | "failed" | "canceled";
};

export type InspectionAgentTelemetry = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindow?: {
    used: number;
    size: number;
  };
};

export type InspectionTreeAgent = {
  name: string;
  telemetry?: InspectionAgentTelemetry;
};

export type InspectionPulse = {
  phase: RunInspectionPulse["phase"];
  turn?: number;
  headline?: string;
  tool?: InspectionToolActivity;
};

export type InspectionAttention =
  | {
      kind: "failure" | "timed-out";
      summary: string;
    }
  | {
      kind: "awaiting-input";
      summary: string;
      signal: string;
      prompt?: string;
      expected?: string;
    };

export type InspectionVisibility = {
  state: "degraded";
  reason: RunInspectionVisibility["reason"];
};

export type InspectionActivity =
  | {
      kind: "agent";
      phase: RunInspectionPulse["phase"];
      turn?: number;
      headline?: string;
    }
  | {
      kind: "task" | "composite";
      phase: "starting" | "running" | "settling";
      headline?: string;
    }
  | {
      kind: "signal";
      phase: "awaiting";
      signal: string;
      prompt?: string;
      expected?: string;
    };

export type TimelineEntry =
  | {
      kind: "transition";
      at: string;
      action: "started" | "awaiting" | "completed" | "failed" | "timed-out" | "cancelled" | "retry" | "steer" | "resumed";
      status?: InspectionStatus;
      attempt?: number;
      summary?: string;
    }
  | {
      kind: "activity";
      at: string;
      channel: "response" | "reported-thought" | "plan" | "tool";
      attempt?: number;
      turn?: number;
      summary: string;
    }
  | {
      kind: "control";
      at: string;
      action: "steered" | "paused" | "resumed" | "retried" | "cancelled";
      attempt?: number;
    }
  | {
      kind: "phase";
      at: string;
      phase: Exclude<RunInspectionCurrentActivity["phase"], "awaiting">;
      attempt?: number;
      turn?: number;
    }
  | {
      kind: "visibility";
      at: string;
      state: "degraded" | "restored";
      reason?: RunInspectionVisibility["reason"];
    }
  | {
      kind: "gap";
      at: string;
      dropped: number;
      reason: string;
    };

export type InspectionTreeEntry =
  | {
      type: "item";
      subject: InspectionTreeSubject;
      state: InspectionVisibleState;
      progress?: InspectionProgress;
      agent?: InspectionTreeAgent;
      pulse?: InspectionPulse;
      attention?: InspectionAttention;
      children: InspectionTreeEntry[];
    }
  | {
      type: "fold";
      scope: "fanout-items" | "loop-rounds";
      range: { start: number; end: number };
      count: number;
      state: InspectionVisibleState;
      children: InspectionTreeEntry[];
    };

export type InspectionForensicsView = {
  kind: "target";
  detail: "forensics";
  run: InspectionRunRef;
  subject: InspectionSubject;
  state: {
    status: RunInspectionStatus;
    durationMs?: number;
  };
  definition: ForensicsDefinition;
  invocation: ForensicsInvocation;
  result: ForensicsResult;
};

export type InspectionView =
  | {
      kind: "run";
      run: InspectionRun;
      counts: InspectionCounts;
      tree: InspectionTreeEntry[];
      output?: JsonValue;
    }
  | {
      kind: "target";
      detail: "summary";
      run: InspectionRunRef;
      subject: InspectionSubject;
      state: InspectionVisibleState;
      pulse?: InspectionPulse;
      acp?: { silentForMs: number };
      attention?: InspectionAttention;
      visibility?: InspectionVisibility;
      occurrences?: InspectionCounts;
      agentSession?: RuntimeAgentSessionInspection;
      steer?: RuntimeSteerProjection;
      availableControls?: RunInspectionControl[];
    }
  | {
      kind: "target";
      detail: "timeline";
      run: InspectionRunRef;
      subject: InspectionSubject;
      state: InspectionVisibleState;
      visibility?: InspectionVisibility;
      current?: InspectionActivity;
      recent: TimelineEntry[];
    }
  | InspectionForensicsView;

export type ArchivedRunInspection = {
  kind: "archived-run";
  run: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
};

export type InspectionRead = InspectionView | InspectionCandidates | ArchivedRunInspection;

export type InspectionChange = {
  subject: InspectionSubject;
  state: InspectionVisibleState;
  progress?: InspectionProgress;
  occurrences?: InspectionCounts;
  attention?: InspectionAttention;
  visibility?: InspectionVisibility;
  reason?: InspectionVisibleReason;
};

export type InspectionObservation =
  | { kind: "attached"; view: InspectionView }
  | {
      kind: "update";
      changes: InspectionChange[];
      timeline?: TimelineEntry[];
      activity?: true;
    }
  | {
      kind: "closed";
      reason: "subject-terminal" | "awaiting-input" | "paused";
      view: InspectionView;
    };

export type InspectionError =
  | { type: "runtime-store-not-found"; message: string }
  | RuntimeStoreRepairRequiredInspectionError
  | RuntimeStoreUnsupportedInspectionError
  | RuntimeStoreUnavailableInspectionError
  | { type: "archived-run-detail-unavailable"; runId: string; command: string; message: string }
  | { type: "archived-run-lookup-unavailable"; runId: string; message: string }
  | { type: "run-not-found"; runId: string; message: string }
  | { type: "target-not-found"; runId: string; target: string; message: string }
  | {
      type: "target-ambiguous";
      runId: string;
      target: string;
      candidates: InspectionCandidates;
      message: string;
    }
  | { type: "invalid-query"; message: string }
  | { type: "read-failed"; runId: string; message: string };

export type RuntimeStoreRepairRequiredInspectionError = {
  type: "runtime-store-repair-required";
  runId: string;
  message: string;
};

export type RuntimeStoreUnsupportedInspectionError = {
  type: "runtime-store-unsupported";
  runId: string;
  message: string;
};

export type RuntimeStoreUnavailableInspectionError = {
  type: "runtime-store-unavailable";
  runId: string;
  message: string;
};
