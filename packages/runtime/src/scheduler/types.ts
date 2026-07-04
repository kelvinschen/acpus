import type { JsonObject, JsonValue } from "@acpus/expression/ir";

export type InstancePathSegment =
  | { kind: "node"; nodeId: string }
  | { kind: "branch"; nodeId: string; branchId: string }
  | { kind: "fanout"; nodeId: string; itemKey: string | number; itemIndex: number }
  | { kind: "loop"; nodeId: string; iter: number };

export type InstancePath = readonly InstancePathSegment[];

export type FrameKind = "root" | "node" | "branch" | "fanout_item" | "loop" | "loop_iteration";
export type FrameStatus = "ready" | "running" | "awaiting" | "completed" | "failed" | "cancelled";
export type NodeInstanceStatus = "pending" | "ready" | "running" | "awaiting" | "completed" | "failed" | "cancelled";
export type AttemptStatus = "started" | "completed" | "failed" | "timed_out" | "cancelled" | "superseded";
export type GroupMemberStatus = "ready" | "running" | "completed" | "failed" | "cancelled";
export type SignalWaitStatus = "awaiting" | "consumed" | "timed_out" | "cancelled";

export type CancellationReason =
  | "parent_failed"
  | "race_lost"
  | "quorum_reached"
  | "paused"
  | "superseded"
  | "operator_cancelled";

export type FailureClass = "retryable" | "terminal";

export type SchedulerFrame = {
  runId: string;
  frameKey: string;
  frameKind: FrameKind;
  status: FrameStatus;
  scope: Record<string, string>;
  instancePath?: InstancePath;
  parentFrameKey?: string;
  nodeKey?: string;
  nodeId?: string;
  strategy?: "all" | "race" | "quorum";
  loop?: {
    iter: number;
    previous?: JsonValue;
    result?: JsonValue;
  };
  terminalReason?: string;
  result?: JsonValue;
  error?: JsonObject;
};

export type NodeInstance = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  status: NodeInstanceStatus;
  instancePath: InstancePath;
  parentFrameKey?: string;
  readinessSequence?: number;
  statusReason?: string;
  output?: JsonValue;
  error?: JsonObject;
  acceptedAttemptId?: string;
};

export type NodeAttempt = {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  ownerEpoch: number;
  status: AttemptStatus;
  deadlineAt?: string;
  result?: JsonValue;
  error?: JsonObject;
  terminalReason?: string;
  cancelReason?: CancellationReason;
};

type BaseGroupProjection = {
  runId: string;
  groupKey: string;
  nodeKey: string;
  nodeId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: JsonValue;
  error?: JsonObject;
};

export type GroupProjection =
  | (BaseGroupProjection & { kind: "parallel"; strategy: "all" | "race"; quorumCount?: never })
  | (BaseGroupProjection & { kind: "fanout"; strategy: "all"; quorumCount?: never })
  | (BaseGroupProjection & { kind: "fanout"; strategy: "quorum"; quorumCount: number });

export type GroupMember = {
  runId: string;
  groupKey: string;
  memberKey: string;
  memberKind: "branch" | "fanout_item";
  status: GroupMemberStatus;
  readinessSequence: number;
  completionSequence?: number;
  branchId?: string;
  itemKey?: string | number;
  itemIndex?: number;
  item?: JsonValue;
  childFrameKey?: string;
  acceptedRank?: number;
  terminalReason?: string;
  output?: JsonValue;
  error?: JsonObject;
};

export type SignalWait = {
  runId: string;
  nodeKey: string;
  nodeId: string;
  status: SignalWaitStatus;
  payload?: JsonValue;
  payloadDigest?: string;
  commandIdempotencyKey?: string;
  deadlineAt?: string;
  timeoutMessage?: string;
  timeoutRemainingMs?: number;
  renderedPrompt?: string;
  terminalReason?: string;
};

export type SchedulerRunProjection = {
  runId: string;
  status: "pending" | "running" | "awaiting" | "paused" | "completed" | "failed" | "canceled";
  paused: boolean;
};

export type SchedulerProjection = {
  run: SchedulerRunProjection;
  frames: Record<string, SchedulerFrame>;
  instances: Record<string, NodeInstance>;
  attempts: Record<string, NodeAttempt>;
  groups: Record<string, GroupProjection>;
  groupMembers: Record<string, GroupMember>;
  signalWaits: Record<string, SignalWait>;
  branchDecisions: Record<string, string>;
};

export type RetryTargetStatus = NodeInstanceStatus | SchedulerRunProjection["status"];
