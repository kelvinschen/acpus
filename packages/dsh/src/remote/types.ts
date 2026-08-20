import type { StoredSessionProjection } from "../host/run-links.js";
import type { ResolvedTaskSelector } from "../task.js";
export type { DelegatedTaskSelector, ResolvedTaskSelector } from "../task.js";

export const TASK_HISTORY_LIMIT = 50;
export const LONG_POLL_MS = 200_000;

export type AgentProfileView = {
  id: string;
  use: string;
  model?: string;
  guidance: string;
  builtIn: boolean;
};

export type ReadAgentProfilesRequest = {};

export type ReadAgentProfilesResult = {
  profiles: AgentProfileView[];
};

export type AcpusRunStatus =
  | "pending"
  | "running"
  | "awaiting"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type ActivityNodeStatus =
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

export type AgentActivity = {
  name?: string;
  phase?:
    | "starting"
    | "responding"
    | "reported-thought"
    | "planning"
    | "tool"
    | "output-repair"
    | "settling"
    | "settled";
  turn?: number;
  tool?: {
    name: string;
    title?: string;
    state: "running" | "completed" | "failed" | "canceled";
  };
  telemetry?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    contextWindow?: {
      used: number;
      size: number;
    };
  };
};

export type ActivityNode = {
  activityId: string;
  label: string;
  kind: string;
  status: ActivityNodeStatus;
  startedAt?: string;
  durationMs?: number;
  progress?: { completed: number; total: number };
  agent?: AgentActivity;
  children: ActivityNode[];
};

export type RunCounts = {
  total: number;
  notStarted: number;
  pending: number;
  running: number;
  awaiting: number;
  completed: number;
  failed: number;
  timedOut: number;
  canceled: number;
};

export type AcpusTaskAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      reason:
        | "workspace-unavailable"
        | "runtime-authority-busy"
        | "runtime-store-unavailable"
        | "runtime-store-unsupported"
        | "runtime-configuration-invalid"
        | "runtime-open-failed";
      workspace: string;
      detail: string;
      detectedAt: string;
    };

export type DelegatedTaskActivity = {
  selector: ResolvedTaskSelector;
  generation: number;
  status: AcpusRunStatus;
  availability: AcpusTaskAvailability;
  counts: RunCounts;
  startedAt: string;
  finishedAt?: string;
  tree: ActivityNode[];
};

export type BoundedHoverText = {
  text: string;
  truncated: boolean;
};

export type HoverResult =
  | {
      kind: "output";
      format: "text" | "json";
      text: string;
      truncated: boolean;
    }
  | { kind: "completed-without-output" }
  | { kind: "failed" | "timed-out"; code?: string; message: string }
  | { kind: "canceled" };

export type ActivityHoverDetail =
  | {
      kind: "agent";
      agent: string;
      model?: string;
      prompt?: BoundedHoverText & {
        origin: "authored" | "steering";
      };
      result?: HoverResult;
    }
  | {
      kind: "task";
      input: BoundedHoverText & { format: "text" | "json" };
      result?: HoverResult;
    };

export type ReadActivityDetailResult =
  | { status: "available"; detail: ActivityHoverDetail }
  | {
      status: "rejected";
      reason:
        | "task-unavailable"
        | "node-unavailable"
        | "detail-unavailable"
        | "temporarily-unavailable";
    };

export type ReadActivityDetailRequest = {
  sessionId: string;
  generation: number;
  activityId: string;
};

export type DelegatedTaskSummary = {
  task: ResolvedTaskSelector;
  status: AcpusRunStatus;
  availability: AcpusTaskAvailability;
  counts: RunCounts;
  startedAt: string;
  finishedAt?: string;
  forkedFrom?: ResolvedTaskSelector;
};

export type AcpusTasksResult = {
  tasks: DelegatedTaskSummary[];
  truncated: boolean;
};

export type SessionActivityProjection = {
  sessionId: string;
  revision: number;
  tasks: DelegatedTaskSummary[];
  tasksTruncated: boolean;
  task?: DelegatedTaskActivity;
};

export type AwaitSessionActivityRevisionResult = { revision: number };

export type ReadSessionActivityRequest = {
  sessionId: string;
  task?: ResolvedTaskSelector;
};

export type AwaitSessionActivityRevisionRequest = {
  sessionId: string;
  afterRevision: number;
};

export type CancelSessionTaskResult =
  | { status: "applied"; projection: SessionActivityProjection }
  | {
      status: "rejected";
      reason:
        | "task-unavailable"
        | "already-terminal"
        | "not-controllable"
        | "temporarily-unavailable";
      projection: SessionActivityProjection;
    };

export type CancelSessionTaskRequest = {
  sessionId: string;
  generation: number;
};

export interface SessionProjectionSource {
  readSession(sessionId: string): Promise<StoredSessionProjection>;
  waitForActivityRevision(
    sessionId: string,
    afterRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
}

export type ProjectionReaderDependencies = {
  sessions: SessionProjectionSource;
};
