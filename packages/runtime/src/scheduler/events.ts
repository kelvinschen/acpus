import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import type {
  AttemptStatus,
  CancellationReason,
  FrameKind,
  FrameStatus,
  GroupMemberIdentity,
  GroupMemberStatus,
  InstancePath,
  NodeInstanceStatus,
} from "./types.js";

type BaseEvent<Type extends string, Payload extends object> = {
  type: Type;
  payload: Payload;
};

export type SchedulerEvent =
  | BaseEvent<"control.paused", {}>
  | BaseEvent<"control.resumed", {}>
  | BaseEvent<"control.run_retry_requested", {}>
  // Starts a durable execution frame and installs the lexical scope snapshot used by resume.
  | BaseEvent<"frame.started", { runId: string; frameKey: string; frameKind: FrameKind; scope?: Record<string, string>; instancePath?: InstancePath; parentFrameKey?: string; nodeKey?: string; nodeId?: string; strategy?: "all" | "race" | "quorum" }>
  // Records a terminal frame result that can rebuild composite projections and visualization overlay.
  | BaseEvent<"frame.completed", { frameKey: string; result?: JsonValue; terminalReason?: string }>
  | BaseEvent<"frame.failed", { frameKey: string; error: JsonObject; terminalReason?: string }>
  | BaseEvent<"frame.cancelled", { frameKey: string; cancelReason: CancellationReason }>
  | BaseEvent<"frame.retry_requested", { frameKey: string; retryDependencyMemberKeys?: string[] }>
  | BaseEvent<"frame.loop_advanced", { frameKey: string; iter: number; state?: JsonValue; transition?: JsonValue }>
  // Makes a dynamic node instance known to the scheduler.
  | BaseEvent<"instance.ready", { runId: string; nodeKey: string; nodeId: string; instancePath: InstancePath; parentFrameKey?: string; readinessSequence?: number; timeoutMs?: number }>
  | BaseEvent<"instance.started", { nodeKey: string; attemptId?: string }>
  | BaseEvent<"instance.awaiting", { nodeKey: string; statusReason?: string }>
  | BaseEvent<"instance.requeued", { nodeKey: string; reason: "paused" | "superseded"; readinessSequence?: number }>
  | BaseEvent<"instance.retry_requested", { nodeKey: string; readinessSequence?: number; retryDependencyMemberKeys?: string[] }>
  | BaseEvent<"instance.completed", { nodeKey: string; output?: JsonValue; acceptedAttemptId?: string; attemptId?: string }>
  | BaseEvent<"instance.failed", { nodeKey: string; error: JsonObject; statusReason?: string; attemptId?: string }>
  | BaseEvent<"instance.cancelled", { nodeKey: string; cancelReason: CancellationReason }>
  // Tracks one scheduler-visible leaf attempt; executor-internal sub-attempts are not events here.
  | BaseEvent<"attempt.started", { runId: string; attemptId: string; nodeKey: string; nodeId: string; attemptNo: number; ownerEpoch: number; admissionVersion?: number; deadlineAt?: string }>
  | BaseEvent<"attempt.completed", { attemptId: string; result?: JsonValue }>
  | BaseEvent<"attempt.failed", { attemptId: string; error: JsonObject; terminalReason?: string }>
  | BaseEvent<"attempt.timed_out", { attemptId: string; error?: JsonObject }>
  | BaseEvent<"attempt.cancelled", { attemptId: string; cancelReason: CancellationReason }>
  | BaseEvent<"attempt.superseded", { attemptId: string; cancelReason?: CancellationReason }>
  // Captures branch or item readiness and terminal status for group completion policy.
  | BaseEvent<"group.started", { runId: string; groupKey: string; nodeKey: string; nodeId: string; kind: "parallel"; strategy: "all" | "race"; maxConcurrency?: number; quorumCount?: never }>
  | BaseEvent<"group.started", { runId: string; groupKey: string; nodeKey: string; nodeId: string; kind: "fanout"; strategy: "all"; maxConcurrency?: number; quorumCount?: never }>
  | BaseEvent<"group.started", { runId: string; groupKey: string; nodeKey: string; nodeId: string; kind: "fanout"; strategy: "quorum"; quorumCount: number; maxConcurrency?: number }>
  | BaseEvent<"group.member_ready", { runId: string; groupKey: string; memberKey: string; readinessSequence: number; childFrameKey?: string } & GroupMemberIdentity>
  | BaseEvent<"group.member_started", { memberKey: string }>
  | BaseEvent<"group.member_requeued", { memberKey: string; reason: "paused" | "superseded"; readinessSequence?: number }>
  | BaseEvent<"group.member_retry_requested", { memberKey: string; readinessSequence?: number }>
  | BaseEvent<"group.member_completed", { memberKey: string; completionSequence: number; output?: JsonValue; acceptedRank?: number }>
  | BaseEvent<"group.member_failed", { memberKey: string; error: JsonObject; terminalReason?: string }>
  | BaseEvent<"group.member_cancelled", { memberKey: string; cancelReason: CancellationReason }>
  | BaseEvent<"group.completed", { groupKey: string; result?: JsonValue }>
  | BaseEvent<"group.failed", { groupKey: string; error: JsonObject }>
  | BaseEvent<"group.cancelled", { groupKey: string; cancelReason: CancellationReason }>
  // Persists branch choice so resume does not re-evaluate the condition.
  | BaseEvent<"branch.decided", { frameKey: string; branchId: string }>
  // Stores normalized signal wait/consume transitions.
  | BaseEvent<"signal.awaiting", { runId: string; nodeKey: string; nodeId: string; deadlineAt?: string; timeoutMessage?: string; renderedPrompt?: string }>
  | BaseEvent<"signal.timeout_paused", { nodeKey: string; remainingMs: number }>
  | BaseEvent<"signal.timeout_resumed", { nodeKey: string; deadlineAt: string }>
  | BaseEvent<"signal.consumed", { nodeKey: string; payload: JsonValue; commandIdempotencyKey: string }>
  | BaseEvent<"signal.timed_out", { nodeKey: string; terminalReason?: string; message?: string }>
  | BaseEvent<"signal.cancelled", { nodeKey: string; cancelReason: CancellationReason }>;

export function isTerminalFrameStatus(status: FrameStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalInstanceStatus(status: NodeInstanceStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return status !== "started";
}

export function isTerminalGroupMemberStatus(status: GroupMemberStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
