import type { JsonValue } from "@acpus/expression/ir";
import type { DatabaseSync } from "node:sqlite";
import { requirePersistedDeadline } from "../deadline.js";
import type { HookJournalEntry } from "../hooks/journal.js";
import { throwSchedulerStoreResult, type SchedulerStorePort } from "../scheduler/store-port.js";
import type { GroupMemberIdentity, GroupProjection, InstancePath, SchedulerFrame } from "../scheduler/types.js";

export type RunDynamicDetails = {
  version: number;
  progressVersion: number;
  progressUpdatedAt?: string;
  frames: RunDynamicFrame[];
  nodeInstances: RunDynamicNodeInstance[];
  attempts: RunDynamicAttempt[];
  groups: RunDynamicGroup[];
  groupMembers: RunDynamicGroupMember[];
  signalWaits: RunDynamicSignalWait[];
  executionMetadata: RunExecutionMetadata[];
  progress: RunNodeProgress[];
};

type RunDynamicGroupBase = {
  groupKey: string;
  nodeKey: string;
  nodeId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  maxConcurrency?: number;
};

export type RunDynamicGroup =
  | (RunDynamicGroupBase & { kind: "parallel"; strategy: "all" | "race"; quorumCount?: never })
  | (RunDynamicGroupBase & { kind: "fanout"; strategy: "all"; quorumCount?: never })
  | (RunDynamicGroupBase & { kind: "fanout"; strategy: "quorum"; quorumCount: number });

export type RunExecutionMetadata = {
  id: number;
  attemptId?: string;
  kind: string;
  metadata: unknown;
  createdAt: string;
};

export type RunNodeProgress = {
  nodeKey: string;
  nodeId: string;
  attemptId?: string;
  attemptNo?: number;
  kind: string;
  status: string;
  message?: string;
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  context?: unknown;
  tokenUsage?: unknown;
  tools?: unknown;
  intent?: unknown;
  acpActivityAt?: string;
  updatedAt: string;
};

export type RunDynamicFrame = {
  frameKey: string;
  parentFrameKey?: string;
  nodeKey?: string;
  nodeId?: string;
  instancePath?: InstancePath;
  frameKind: string;
  status: string;
  scope?: Record<string, string>;
  strategy?: string;
  loop?: SchedulerFrame["loop"];
  terminalReason?: string;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicNodeInstance = {
  nodeKey: string;
  nodeId: string;
  parentFrameKey?: string;
  instancePath?: InstancePath;
  status: string;
  /** Current status reason only; historical control reasons are kept in run events/attempt metadata. */
  statusReason?: string;
  output?: unknown;
  error?: unknown;
  acceptedAttemptId?: string;
  reusedFromRunId?: string;
  reusedFromNodeKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicAttempt = {
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  status: string;
  deadlineAt?: string;
  result?: unknown;
  error?: unknown;
  terminalReason?: string;
  cancelReason?: string;
  startedAt: string;
  finishedAt?: string;
};

type RunDynamicGroupMemberBase = {
  groupKey: string;
  memberKey: string;
  childFrameKey?: string;
  status: string;
  completionSequence?: number;
  acceptedRank?: number;
  terminalReason?: string;
  output?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RunDynamicGroupMember = RunDynamicGroupMemberBase & GroupMemberIdentity;

export type RunDynamicSignalWait = {
  nodeKey: string;
  nodeId: string;
  status: string;
  payload?: JsonValue;
  deadlineAt?: string;
  timeoutMessage?: string;
  timeoutRemainingMs?: number;
  renderedPrompt?: string;
  terminalReason?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type HookJournalRow = {
  id: number;
  run_id: string;
  event_sequence: number;
  trigger_order: number;
  event: HookJournalEntry["event"];
  source: HookJournalEntry["source"];
  source_path: string;
  handler_id: string;
  definition_hash: string;
  node_key: string | null;
  status: HookJournalEntry["status"];
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  error: string | null;
  triggered_at: string;
};

/** Owns the SQLite-backed public inspection model and all row-to-model mappings. */
export class SqliteRuntimeInspectionReadModel {
  constructor(
    private readonly db: DatabaseSync,
    private readonly scheduler: SchedulerStorePort,
  ) {}

  getHookJournal(runId: string): HookJournalEntry[] {
    const rows = this.db.prepare(`
      SELECT id, run_id, event_sequence, trigger_order, event, source, source_path, handler_id, definition_hash,
        node_key, status, exit_code, stdout, stderr, duration_ms, error, triggered_at
      FROM hook_journal
      WHERE run_id = ?
      ORDER BY event_sequence ASC, trigger_order ASC, id ASC
    `).all(runId) as HookJournalRow[];
    return rows.map(hookJournalEntryFromRow);
  }

  getExecutionMetadata(runId: string): RunExecutionMetadata[] {
    const rows = this.db.prepare(`
      SELECT id, attempt_id, kind, metadata_json, created_at
      FROM execution_metadata
      WHERE run_id = ?
      ORDER BY id
    `).all(runId) as Array<Record<string, string | number | null>>;
    return rows.map(row => withoutUndefined({
      id: Number(row.id),
      attemptId: nullableString(row.attempt_id),
      kind: String(row.kind),
      metadata: JSON.parse(String(row.metadata_json)) as unknown,
      createdAt: String(row.created_at),
    }) as RunExecutionMetadata);
  }

  getDynamicDetails(runId: string): RunDynamicDetails | undefined {
    const frames = readRunDynamicFrames(this.db, runId);
    const nodeInstances = readRunDynamicNodeInstances(this.db, runId);
    const attempts = readRunDynamicAttempts(this.db, runId);
    const groups = Object.values(throwSchedulerStoreResult(this.scheduler.tryLoadRunSnapshot(runId)).projection.groups).map(runDynamicGroup);
    const groupMembers = readRunDynamicGroupMembers(this.db, runId);
    const signalWaits = readRunDynamicSignalWaits(this.db, runId);
    const executionMetadata = this.getExecutionMetadata(runId);
    const progress = readRunNodeProgress(this.db, runId);
    const progressVersion = runProgressVersion(this.db, runId);
    if (frames.length + nodeInstances.length + attempts.length + groups.length + groupMembers.length + signalWaits.length + executionMetadata.length + progress.length === 0) return undefined;
    return {
      version: runEventVersion(this.db, runId),
      progressVersion: progressVersion.version,
      ...(progressVersion.updatedAt ? { progressUpdatedAt: progressVersion.updatedAt } : {}),
      frames,
      nodeInstances,
      attempts,
      groups,
      groupMembers,
      signalWaits,
      executionMetadata,
      progress,
    };
  }
}

function readRunDynamicFrames(db: DatabaseSync, runId: string): RunDynamicFrame[] {
  const rows = db.prepare(`
    SELECT frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
      terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json, created_at, updated_at
    FROM scheduler_frames
    WHERE run_id = ?
    ORDER BY frame_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => withoutUndefined({
    frameKey: String(row.frame_key),
    parentFrameKey: nullableString(row.parent_frame_key),
    nodeKey: nullableString(row.node_key),
    nodeId: nullableString(row.node_id),
    instancePath: parseOptionalJson(row.instance_path_json),
    frameKind: String(row.frame_kind),
    status: String(row.status),
    scope: parseOptionalJson(row.scope_json),
    strategy: nullableString(row.strategy),
    loop: parseOptionalJson(row.loop_json),
    terminalReason: nullableString(row.terminal_reason),
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson(row.error_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }) as RunDynamicFrame);
}

function readRunDynamicNodeInstances(db: DatabaseSync, runId: string): RunDynamicNodeInstance[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
      output_json, error_json, accepted_attempt_id, reused_from_run_id, reused_from_node_key,
      created_at, updated_at
    FROM node_instances
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => {
    const status = String(row.status);
    const statusReason = publicNodeInstanceStatusReason(status, nullableString(row.status_reason));
    return withoutUndefined({
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      parentFrameKey: nullableString(row.parent_frame_key),
      instancePath: parseOptionalJson(row.instance_path_json),
      status,
      statusReason,
      output: parseOptionalJson(row.output_json),
      error: parseOptionalJson(row.error_json),
      acceptedAttemptId: nullableString(row.accepted_attempt_id),
      reusedFromRunId: nullableString(row.reused_from_run_id),
      reusedFromNodeKey: nullableString(row.reused_from_node_key),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicNodeInstance;
  });
}

function publicNodeInstanceStatusReason(status: string, statusReason: string | undefined): string | undefined {
  return status === "running" || status === "completed" ? undefined : statusReason;
}

function readRunDynamicAttempts(db: DatabaseSync, runId: string): RunDynamicAttempt[] {
  const rows = db.prepare(`
    SELECT attempt_id, node_key, node_id, attempt_no, status, deadline_at,
      started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
    FROM node_attempts
    WHERE run_id = ?
    ORDER BY attempt_id
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => {
    const attemptId = String(row.attempt_id);
    return withoutUndefined({
      attemptId,
      nodeKey: String(row.node_key),
      nodeId: String(row.node_id),
      attemptNo: Number(row.attempt_no),
      status: String(row.status),
      deadlineAt: optionalPersistedDeadline(row.deadline_at, `Attempt '${attemptId}'`),
      startedAt: String(row.started_at),
      finishedAt: nullableString(row.finished_at),
      result: parseOptionalJson(row.result_json),
      error: parseOptionalJson(row.error_json),
      terminalReason: nullableString(row.terminal_reason),
      cancelReason: nullableString(row.cancel_reason),
    }) as RunDynamicAttempt;
  });
}

function readRunDynamicGroupMembers(db: DatabaseSync, runId: string): RunDynamicGroupMember[] {
  const rows = db.prepare(`
    SELECT group_key, member_key, member_kind, branch_id, item_index, item_json, child_frame_key,
      status, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
    FROM group_members
    WHERE run_id = ?
    ORDER BY member_key
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => {
    const member = withoutUndefined({
      groupKey: String(row.group_key),
      memberKey: String(row.member_key),
      childFrameKey: nullableString(row.child_frame_key),
      status: String(row.status),
      completionSequence: nullableNumber(row.completion_sequence),
      acceptedRank: nullableNumber(row.accepted_rank),
      terminalReason: nullableString(row.terminal_reason),
      output: parseOptionalJson(row.output_json),
      error: parseOptionalJson(row.error_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicGroupMemberBase;
    if (row.member_kind === "branch") {
      const branchId = nullableString(row.branch_id);
      if (branchId === undefined) throw new Error(`Branch group member '${member.memberKey}' is missing branch_id.`);
      return { ...member, memberKind: "branch", branchId };
    }
    if (row.member_kind === "fanout_item") {
      const itemIndex = nullableNumber(row.item_index);
      const item = parseOptionalJson(row.item_json);
      if (itemIndex === undefined) throw new Error(`Fanout group member '${member.memberKey}' is missing item_index.`);
      if (item === undefined) throw new Error(`Fanout group member '${member.memberKey}' is missing item_json.`);
      return { ...member, memberKind: "fanout_item", itemIndex, item: item as JsonValue };
    }
    throw new Error(`Group member '${member.memberKey}' has invalid member_kind '${row.member_kind}'.`);
  });
}

function readRunDynamicSignalWaits(db: DatabaseSync, runId: string): RunDynamicSignalWait[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, status, payload_json, deadline_at,
      timeout_message, timeout_remaining_ms, rendered_prompt, terminal_reason,
      consumed_at, created_at, updated_at
    FROM signal_waits
    WHERE run_id = ?
    ORDER BY node_key
  `).all(runId) as Array<Record<string, string | null>>;
  return rows.map(row => {
    const nodeKey = String(row.node_key);
    return withoutUndefined({
      nodeKey,
      nodeId: String(row.node_id),
      status: String(row.status),
      payload: row.status === "consumed" ? parseOptionalJson(row.payload_json) : undefined,
      deadlineAt: optionalPersistedDeadline(row.deadline_at, `Signal wait '${nodeKey}'`),
      timeoutMessage: nullableString(row.timeout_message),
      timeoutRemainingMs: nullableNumber(row.timeout_remaining_ms),
      renderedPrompt: nullableString(row.rendered_prompt),
      terminalReason: nullableString(row.terminal_reason),
      consumedAt: row.status === "consumed" ? nullableString(row.consumed_at) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }) as RunDynamicSignalWait;
  });
}

function runDynamicGroup(group: GroupProjection): RunDynamicGroup {
  const base: RunDynamicGroupBase = {
    groupKey: group.groupKey,
    nodeKey: group.nodeKey,
    nodeId: group.nodeId,
    status: group.status,
    ...(group.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
  };
  if (group.kind === "parallel") return { ...base, kind: "parallel", strategy: group.strategy };
  if (group.strategy === "quorum") return { ...base, kind: "fanout", strategy: "quorum", quorumCount: group.quorumCount };
  return { ...base, kind: "fanout", strategy: "all" };
}

function readRunNodeProgress(db: DatabaseSync, runId: string): RunNodeProgress[] {
  const rows = db.prepare(`
    SELECT node_key, node_id, attempt_id, attempt_no, kind, status, message,
      output_tail, output_total_bytes, output_truncated,
      context_json, token_usage_json, tools_json, intent_json, acp_activity_at, updated_at
    FROM node_progress
    WHERE run_id = ?
    ORDER BY updated_at ASC, node_key ASC
  `).all(runId) as Array<Record<string, string | number | null>>;
  return rows.map(row => withoutUndefined({
    nodeKey: String(row.node_key),
    nodeId: String(row.node_id),
    attemptId: nullableString(row.attempt_id),
    attemptNo: nullableNumber(row.attempt_no),
    kind: String(row.kind),
    status: String(row.status),
    message: nullableString(row.message),
    output: row.output_tail === null ? undefined : {
      tail: String(row.output_tail),
      totalBytes: Number(row.output_total_bytes ?? 0),
      truncated: Boolean(row.output_truncated),
    },
    context: row.context_json === null ? undefined : JSON.parse(String(row.context_json)) as unknown,
    tokenUsage: row.token_usage_json === null ? undefined : JSON.parse(String(row.token_usage_json)) as unknown,
    tools: row.tools_json === null ? undefined : JSON.parse(String(row.tools_json)) as unknown,
    intent: row.intent_json === null ? undefined : JSON.parse(String(row.intent_json)) as unknown,
    acpActivityAt: nullableString(row.acp_activity_at),
    updatedAt: String(row.updated_at),
  }) as RunNodeProgress);
}

function runProgressVersion(db: DatabaseSync, runId: string): { version: number; updatedAt?: string } {
  const row = db.prepare("SELECT progress_version, progress_updated_at FROM runs WHERE id = ?").get(runId) as { progress_version: number; progress_updated_at: string | null } | undefined;
  return {
    version: Number(row?.progress_version ?? 0),
    ...(row?.progress_updated_at ? { updatedAt: row.progress_updated_at } : {}),
  };
}

function runEventVersion(db: DatabaseSync, runId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS version FROM run_events WHERE run_id = ?").get(runId) as { version: number } | undefined;
  return Number(row?.version ?? 0);
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalPersistedDeadline(value: unknown, subject: string): string | undefined {
  const deadlineAt = nullableString(value);
  return deadlineAt === undefined ? undefined : requirePersistedDeadline(deadlineAt, subject);
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function hookJournalEntryFromRow(row: HookJournalRow): HookJournalEntry {
  return {
    id: Number(row.id),
    runId: row.run_id,
    eventSequence: Number(row.event_sequence),
    triggerOrder: Number(row.trigger_order),
    event: row.event,
    source: row.source,
    sourcePath: row.source_path,
    handlerId: row.handler_id,
    definitionHash: row.definition_hash,
    ...(row.node_key === null ? {} : { nodeKey: row.node_key }),
    status: row.status,
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.stdout === null ? {} : { stdout: row.stdout }),
    ...(row.stderr === null ? {} : { stderr: row.stderr }),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    ...(row.error === null ? {} : { error: row.error }),
    triggeredAt: row.triggered_at,
  };
}

function parseOptionalJson(value: unknown): unknown {
  return value === null || value === undefined ? undefined : JSON.parse(String(value));
}
