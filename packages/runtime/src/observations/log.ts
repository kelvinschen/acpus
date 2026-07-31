import type { DatabaseSync } from "node:sqlite";
import {
  type AgentContextSummary,
  type AgentObservationEvent,
  type AgentTokenUsageSummary,
  type AgentTurnObservation,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@acpus/agent-executor";
import { ResultAsync } from "neverthrow";
import { utf8Head, utf8Tail } from "../utf8.js";

const semanticEntryLimit = 128;
const semanticPayloadLimit = 128 * 1024;
const semanticReadPayloadLimit = 8 * 1024;
const currentPayloadLimit = 16 * 1024;
const responseCheckpointBytes = 512;
const checkpointIntervalMs = 10_000;
const currentResponseBytes = 1536;
const currentIntentBytes = 768;
const currentToolBytes = 768;
const timelineEntryBytes = 512;
const terminalToolStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);

type AgentPromptKind = "task" | "continuation" | "steer" | "repair";
type AgentObservationState = "recording" | "settled" | "incomplete";
type AgentObservationCompleteness = "complete" | "degraded";
type AgentObservationPhase =
  | "starting"
  | "responding"
  | "thinking"
  | "planning"
  | "tool"
  | "repairing"
  | "settling"
  | "settled";

export type AgentObservationTurnContext = {
  runId: string;
  nodeId: string;
  nodeKey: string;
  attemptId: string;
  attemptNo: number;
  turn: number;
  promptKind: AgentPromptKind;
  signal?: AbortSignal;
};

export type AgentObservationFenceInput = {
  runId: string;
  attemptId: string;
  eventSequence: number;
  committedAt: string;
  reason: string;
};

type AgentObservationUnavailableFenceInput = Omit<AgentObservationFenceInput, "eventSequence"> & {
  eventSequence?: number;
};

type AgentObservationExcerpt = {
  text: string;
  originalBytes: number;
  truncated: boolean;
};

type AgentObservationToolActivity = {
  toolCallId?: string;
  name: string;
  status?: string;
  input?: AgentObservationExcerpt;
  output?: AgentObservationExcerpt;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
};

export type AgentObservationCurrent = {
  attemptId: string;
  turn: number;
  promptKind: AgentPromptKind;
  phase: AgentObservationPhase;
  updatedAt: string;
  postFence?: true;
  response?: AgentObservationExcerpt;
  context?: AgentContextSummary;
  tokenUsage?: AgentTokenUsageSummary;
  intent?: {
    kind: "plan" | "reported-thought";
    excerpt: AgentObservationExcerpt;
  };
  tools?: {
    active: AgentObservationToolActivity[];
    recent?: AgentObservationToolActivity;
    omittedActive: number;
  };
  state: AgentObservationState;
  completeness: AgentObservationCompleteness;
};

type AgentObservationEntryBase = {
  id: string;
  observationVersion: number;
  attemptId: string;
  turn: number;
  sourceSequence: number;
  at: string;
};

type AgentObservationSemanticEntry =
  | AgentObservationEntryBase & {
      kind: "activity";
      channel: "response" | "reported-thought" | "plan" | "tool";
      summary: AgentObservationExcerpt;
      tool?: AgentObservationToolActivity;
      postFence?: true;
    }
  | AgentObservationEntryBase & {
      kind: "gap";
      dropped: number;
      reason: string;
    };

export type AgentObservationTurn = {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  turn: number;
  promptKind: AgentPromptKind;
  state: AgentObservationState;
  completeness: AgentObservationCompleteness;
  gapCount: number;
  eventCount: number;
  unknownEventCount: number;
  fenceEventSequence?: number;
  fencedAt?: string;
  fenceReason?: string;
  providerStatus?: "completed" | "failed" | "cancelled" | "timed_out";
  startedAt: string;
  finishedAt?: string;
};

export type AgentObservationInspectionProjection = {
  version: number;
  latestRelevantVersion?: number;
  turns: AgentObservationTurn[];
  omittedTurns?: true;
  currents: AgentObservationCurrent[];
  entries: AgentObservationSemanticEntry[];
  retentionOmittedBefore: number;
  retentionFloorVersion?: number;
  olderEntryCount: number;
  hasOlderEntries: boolean;
  oldestObservationVersion?: number;
  beforeEntryRetained?: boolean;
};

export type AgentObservationEntryCursor = {
  observationVersion: number;
  sourceSequence: number;
  id: string;
};

export type AgentObservationReadError = {
  type: "observation-read-failed";
  runId: string;
  message: string;
  cause?: unknown;
};

export type AgentObservationReconciliationError = {
  type: "observation-reconciliation-failed";
  runId: string;
  message: string;
  cause?: unknown;
};

type TurnRow = {
  run_id: string;
  attempt_id: string;
  node_key: string;
  node_id: string;
  attempt_no: number;
  turn_no: number;
  prompt_kind: AgentPromptKind;
  state: AgentObservationState;
  degraded: number;
  gap_count: number;
  provider_event_count: number;
  unknown_event_count: number;
  fence_event_sequence: number | null;
  fenced_at: string | null;
  fence_reason: string | null;
  provider_status: NonNullable<AgentObservationTurn["providerStatus"]> | null;
  current_json: string | null;
  current_bytes: number;
  current_updated_at: string | null;
  current_observation_version: number | null;
  started_at: string;
  finished_at: string | null;
};

type ReconciliationRow = TurnRow & {
  attempt_finished_at: string | null;
};

type AttemptObservationRow = {
  latest_observation_version: number;
  retention_omitted_count: number;
  retention_floor_version: number | null;
};

type EntryRow = {
  attempt_id: string;
  turn_no: number;
  entry_id: string;
  observation_version: number;
  source_sequence: number;
  observed_at: string;
  kind: "activity" | "gap";
  payload_json: string;
  payload_bytes: number;
};

type PendingSemanticEntry =
  | Omit<Extract<AgentObservationSemanticEntry, { kind: "activity" }>, "observationVersion">
  | Omit<Extract<AgentObservationSemanticEntry, { kind: "gap" }>, "observationVersion">;

type SemanticMutation = {
  entries: PendingSemanticEntry[];
  checkpoint: boolean;
  current: AgentObservationCurrent | undefined;
  observedAt: string;
};

type FenceOperation = {
  eventSequence?: number;
  committedAt: string;
  reason: string;
  mutation: SemanticMutation;
};

type DurableSteerFence = {
  eventSequence: number;
  committedAt: string;
  reason: "operator_steered";
};

export class AgentObservationLog {
  private readonly active = new Map<string, AgentTurnWriter>();
  private readonly unavailableFences = new Map<string, Promise<void>>();

  constructor(private readonly db: DatabaseSync) {}

  async captureTurn(
    context: AgentObservationTurnContext,
    request: AgentTurnRequest,
    runTurn: (request: AgentTurnRequest) => Promise<AgentTurnResult>,
  ): Promise<AgentTurnResult> {
    const writer = new AgentTurnWriter(this, context);
    const key = activeKey(context.runId, context.attemptId, context.turn);
    if (this.active.has(key)) {
      throw new Error(`Agent observation turn '${context.attemptId}:${context.turn}' is already active.`);
    }
    this.active.set(key, writer);
    try {
      writer.start();
      return await this.captureStartedTurn(writer, context, request, runTurn);
    } finally {
      this.active.delete(key);
    }
  }

  private async captureStartedTurn(
    writer: AgentTurnWriter,
    context: AgentObservationTurnContext,
    request: AgentTurnRequest,
    runTurn: (request: AgentTurnRequest) => Promise<AgentTurnResult>,
  ): Promise<AgentTurnResult> {
    const onAbort = (): void => {
      void writer.markFallbackFenced("runtime_abort", new Date().toISOString()).catch(() => {});
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    try {
      if (!writer.fenced && !this.startedAttemptMatches(context)) {
        await writer.markFallbackFenced("runtime_abort");
      }
      const result = writer.fenced
        ? cancelledBeforeProviderDispatch()
        : await runTurn({
            ...request,
            onObservation: observation => {
              writer.observe(observation);
              notifyObserver(request.onObservation, observation);
            },
          });
      writer.finish(result);
      return result;
    } catch (error) {
      try {
        writer.markIncomplete("provider_settlement_missing");
      } catch (observationError) {
        throw new AggregateError(
          [error, observationError],
          "Agent execution failed and its semantic observation could not be closed.",
        );
      }
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  markFenced(input: AgentObservationFenceInput): Promise<void> {
    const writer = [...this.active.values()]
      .filter(candidate =>
        candidate.context.runId === input.runId && candidate.context.attemptId === input.attemptId)
      .sort((left, right) => right.context.turn - left.context.turn)[0];
    if (writer) return writer.markFenced(input);
    return this.markUnavailableFence(input);
  }

  readInspectionProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
    latestTurnOnly?: true;
    includeOlderCount?: boolean;
  }): ResultAsync<AgentObservationInspectionProjection, AgentObservationReadError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(() => this.readProjection(input)),
      cause => ({
        type: "observation-read-failed",
        runId: input.runId,
        message: `Agent observations for run '${input.runId}' could not be read: ${causeMessage(cause)}.`,
        cause,
      }),
    );
  }

  reconcileInterruptedTurns(
    runId: string,
  ): ResultAsync<void, AgentObservationReconciliationError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(() => this.reconcileRun(runId)),
      cause => ({
        type: "observation-reconciliation-failed",
        runId,
        message: `Agent observations for run '${runId}' could not be reconciled: ${causeMessage(cause)}.`,
        cause,
      }),
    );
  }

  async reconcileTerminalTurns(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT id AS run_id
      FROM runs
      WHERE status IN ('completed', 'failed', 'canceled')
      ORDER BY id
    `).all() as Array<{ run_id: string }>;
    for (const row of rows) this.reconcileRun(row.run_id);
  }

  beginTurn(writer: AgentTurnWriter, observedAt: string): void {
    const initialCurrent = writer.initialCurrent(observedAt);
    const currentJson = boundedCurrentJson(initialCurrent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireStartedAttempt(writer.context);
      const version = this.advanceObservationVersion(writer.context.runId, observedAt);
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.db.prepare(`
        INSERT INTO agent_observation_turns (
          run_id, attempt_id, node_key, node_id, attempt_no, turn_no, prompt_kind,
          state, degraded, gap_count, provider_event_count, unknown_event_count,
          current_json, current_bytes, current_updated_at, current_observation_version,
          started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', 0, 0, 0, 0, ?, ?, ?, ?, ?)
      `).run(
        writer.context.runId,
        writer.context.attemptId,
        writer.context.nodeKey,
        writer.context.nodeId,
        writer.context.attemptNo,
        writer.context.turn,
        writer.context.promptKind,
        currentJson,
        Buffer.byteLength(currentJson),
        observedAt,
        version,
        observedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  persistObservation(writer: AgentTurnWriter, mutation: SemanticMutation): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, mutation.observedAt);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, mutation.current, version);
      this.updateObservationCounts(writer);
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  persistFence(writer: AgentTurnWriter, operation: FenceOperation): void {
    const row = this.turnRow(
      writer.context.runId,
      writer.context.attemptId,
      writer.context.turn,
    );
    if (!row) throw new Error("Agent observation turn was not found while fencing.");
    if (operation.eventSequence !== undefined
      && row.fence_event_sequence !== null
      && row.fence_event_sequence !== operation.eventSequence) {
      throw new Error(
        `Agent observation turn '${writer.context.attemptId}:${writer.context.turn}' already has a different durable fence.`,
      );
    }
    if (operation.eventSequence !== undefined
      && row.fence_event_sequence === operation.eventSequence) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, operation.committedAt);
      this.insertSemanticEntries(writer.context, operation.mutation.entries, version);
      this.updateCurrent(writer, operation.mutation.current, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET fence_event_sequence = COALESCE(fence_event_sequence, ?),
            fenced_at = COALESCE(fenced_at, ?),
            fence_reason = COALESCE(fence_reason, ?)
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        operation.eventSequence ?? null,
        operation.committedAt,
        operation.reason,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.updateObservationCounts(writer);
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishTurn(
    writer: AgentTurnWriter,
    result: AgentTurnResult,
    mutation: SemanticMutation,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, result.timing.finishedAt);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, mutation.current, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET state = 'settled',
            degraded = ?,
            provider_event_count = ?,
            unknown_event_count = ?,
            provider_status = ?,
            finished_at = ?
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        writer.degraded ? 1 : 0,
        writer.providerEventCount,
        writer.unknownEventCount,
        providerOutcome(result),
        result.timing.finishedAt,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markWriterIncomplete(
    writer: AgentTurnWriter,
    mutation: SemanticMutation,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, mutation.observedAt);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, undefined, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET state = 'incomplete',
            degraded = 1,
            gap_count = gap_count + 1,
            provider_event_count = ?,
            unknown_event_count = ?,
            finished_at = COALESCE(finished_at, ?)
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
          AND state = 'recording'
      `).run(
        writer.providerEventCount,
        writer.unknownEventCount,
        mutation.observedAt,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private markUnavailableFence(input: AgentObservationUnavailableFenceInput): Promise<void> {
    const key = `${input.runId}\0${input.attemptId}`;
    const previous = this.unavailableFences.get(key) ?? Promise.resolve();
    const pending = previous.then(
      () => this.persistUnavailableFence(input),
      () => this.persistUnavailableFence(input),
    );
    this.unavailableFences.set(key, pending);
    void pending.finally(() => {
      if (this.unavailableFences.get(key) === pending) this.unavailableFences.delete(key);
    }).catch(() => {});
    return pending;
  }

  private persistUnavailableFence(input: AgentObservationUnavailableFenceInput): void {
    const row = this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ? AND attempt_id = ?
      ORDER BY turn_no DESC
      LIMIT 1
    `).get(input.runId, input.attemptId) as TurnRow | undefined;
    if (!row) return;
    if (input.eventSequence !== undefined && row.fence_event_sequence === input.eventSequence) return;
    if (input.eventSequence === undefined && row.fence_reason !== null) return;
    if (input.eventSequence !== undefined && row.fence_event_sequence !== null) {
      throw new Error(
        `Agent observation turn '${input.attemptId}:${row.turn_no}' already has a different durable fence.`,
      );
    }
    const at = input.committedAt;
    const recording = row.state === "recording";
    const entries: PendingSemanticEntry[] = [];
    let sourceSequence = this.nextSourceSequence(row.run_id, row.attempt_id, row.turn_no);
    const current = recording ? parseCurrent(row.current_json) : undefined;
    const currentEntry = current ? entryFromCurrent(current, sourceSequence) : undefined;
    if (currentEntry) {
      entries.push(currentEntry);
      sourceSequence += 1;
    }
    if (recording) {
      entries.push(gapEntry(row, sourceSequence, at, "observation_boundary_unavailable"));
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(input.runId, at);
      this.insertSemanticEntries(rowContext(row), entries, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET fence_event_sequence = COALESCE(fence_event_sequence, ?),
            fenced_at = COALESCE(fenced_at, ?),
            fence_reason = COALESCE(fence_reason, ?),
            state = CASE WHEN state = 'recording' THEN 'incomplete' ELSE state END,
            degraded = CASE WHEN state = 'recording' THEN 1 ELSE degraded END,
            gap_count = CASE WHEN state = 'recording' THEN gap_count + 1 ELSE gap_count END,
            current_json = CASE WHEN state = 'recording' THEN NULL ELSE current_json END,
            current_bytes = CASE WHEN state = 'recording' THEN 0 ELSE current_bytes END,
            current_updated_at = CASE WHEN state = 'recording' THEN ? ELSE current_updated_at END,
            current_observation_version = CASE WHEN state = 'recording' THEN ? ELSE current_observation_version END,
            finished_at = CASE WHEN state = 'recording' THEN COALESCE(finished_at, ?) ELSE finished_at END
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        input.eventSequence ?? null,
        at,
        input.reason,
        at,
        version,
        at,
        input.runId,
        input.attemptId,
        row.turn_no,
      );
      this.touchAttempt(input.runId, input.attemptId, version);
      this.trimAttemptEntries(input.runId, input.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private reconcileRun(runId: string): void {
    const rows = this.db.prepare(`
      SELECT turns.*, attempts.finished_at AS attempt_finished_at
      FROM agent_observation_turns AS turns
      JOIN node_attempts AS attempts
        ON attempts.run_id = turns.run_id
        AND attempts.attempt_id = turns.attempt_id
      WHERE turns.run_id = ?
        AND turns.state = 'recording'
        AND attempts.status IN ('completed', 'failed', 'timed_out', 'cancelled', 'superseded')
      ORDER BY turns.attempt_no, turns.turn_no
    `).all(runId) as ReconciliationRow[];
    for (const row of rows) this.reconcileTurn(row);
  }

  private reconcileTurn(row: ReconciliationRow): void {
    if (row.attempt_finished_at === null) {
      throw new Error(
        `Terminal Agent attempt '${row.attempt_id}' has no finished_at for observation reconciliation.`,
      );
    }
    const at = row.attempt_finished_at;
    const entries: PendingSemanticEntry[] = [];
    let sourceSequence = this.nextSourceSequence(row.run_id, row.attempt_id, row.turn_no);
    const current = parseCurrent(row.current_json);
    const currentEntry = current ? entryFromCurrent(current, sourceSequence) : undefined;
    if (currentEntry) {
      entries.push(currentEntry);
      sourceSequence += 1;
    }
    entries.push(gapEntry(row, sourceSequence, at, "provider_settlement_missing_recovery"));
    const fence = this.durableSteerFence(row);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(row.run_id, at);
      this.insertSemanticEntries(rowContext(row), entries, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET state = 'incomplete',
            degraded = 1,
            gap_count = gap_count + 1,
            fence_event_sequence = COALESCE(fence_event_sequence, ?),
            fenced_at = COALESCE(fenced_at, ?),
            fence_reason = COALESCE(fence_reason, ?),
            current_json = NULL,
            current_bytes = 0,
            current_updated_at = ?,
            current_observation_version = ?,
            finished_at = ?
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
          AND state = 'recording'
      `).run(
        fence?.eventSequence ?? null,
        fence?.committedAt ?? null,
        fence?.reason ?? null,
        at,
        version,
        at,
        row.run_id,
        row.attempt_id,
        row.turn_no,
      );
      this.touchAttempt(row.run_id, row.attempt_id, version);
      this.trimAttemptEntries(row.run_id, row.attempt_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private durableSteerFence(
    row: Pick<TurnRow, "run_id" | "attempt_id">,
  ): DurableSteerFence | undefined {
    const events = this.db.prepare(`
      SELECT sequence, payload_json, created_at
      FROM run_events
      WHERE run_id = ? AND type = 'control.agent_steer_requested'
      ORDER BY sequence DESC
    `).all(row.run_id) as Array<{
      sequence: number;
      payload_json: string;
      created_at: string;
    }>;
    for (const event of events) {
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      if (payload.fencedAttemptId === row.attempt_id) {
        return {
          eventSequence: event.sequence,
          committedAt: event.created_at,
          reason: "operator_steered",
        };
      }
    }
    return undefined;
  }

  private readProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
    latestTurnOnly?: true;
    includeOlderCount?: boolean;
  }): AgentObservationInspectionProjection {
    if (input.latestTurnOnly && input.attemptIds?.length !== 1) {
      throw new Error("Latest-turn inspection requires exactly one attempt.");
    }
    const versionRow = this.db.prepare("SELECT observation_version FROM runs WHERE id = ?")
      .get(input.runId) as { observation_version: number } | undefined;
    if (!versionRow) throw new Error(`Run '${input.runId}' was not found.`);
    const turns = this.turnRows(input.runId, input.attemptIds, input.latestTurnOnly);
    const attempts = this.attemptRows(input.runId, input.attemptIds);
    const entryRows = input.entryLimit === undefined || input.attemptIds?.length === 0
      ? []
      : this.readEntryRows(input);
    const entryLimit = Math.min(50, Math.max(1, input.entryLimit ?? 1));
    const chosenRows: EntryRow[] = [];
    let chosenBytes = 0;
    for (const row of entryRows) {
      if (chosenRows.length >= entryLimit) break;
      if (chosenRows.length > 0 && chosenBytes + row.payload_bytes > semanticReadPayloadLimit) break;
      chosenRows.push(row);
      chosenBytes += row.payload_bytes;
    }
    chosenRows.reverse();
    const entries = chosenRows.map(semanticEntry);
    const currents = turns.flatMap(row => {
      const current = parseCurrent(row.current_json);
      return current ? [current] : [];
    });
    const attemptValues = [...attempts.values()];
    const latestRelevantVersion = attemptValues.length === 0
      ? undefined
      : Math.max(...attemptValues.map(row => row.latest_observation_version));
    const retentionOmittedBefore = attemptValues.reduce(
      (total, row) => total + row.retention_omitted_count,
      0,
    );
    const floors = attemptValues.flatMap(row =>
      row.retention_floor_version === null ? [] : [row.retention_floor_version]);
    const retentionFloorVersion = floors.length === 0 ? undefined : Math.max(...floors);
    const oldestObservationVersion = entries[0]?.observationVersion;
    const hasOlderEntries = entryRows.length > chosenRows.length;
    const olderEntryCount = input.latestTurnOnly || input.includeOlderCount === false
      ? Number(hasOlderEntries)
      : Math.max(
          0,
          (input.entryLimit === undefined || input.attemptIds?.length === 0
            ? 0
            : this.countEntryRows(input)) - chosenRows.length,
        );
    const beforeEntryRetained = input.beforeEntry === undefined
      ? undefined
      : this.hasEntryBoundary(input.runId, input.attemptIds, input.beforeEntry);
    return {
      version: versionRow.observation_version,
      ...(latestRelevantVersion === undefined ? {} : { latestRelevantVersion }),
      turns: turns.map(observationTurn),
      ...(input.latestTurnOnly && (turns[0]?.turn_no ?? 0) > 1 ? { omittedTurns: true } : {}),
      currents,
      entries,
      retentionOmittedBefore,
      ...(retentionFloorVersion === undefined ? {} : { retentionFloorVersion }),
      olderEntryCount,
      hasOlderEntries: olderEntryCount > 0,
      ...(oldestObservationVersion === undefined ? {} : { oldestObservationVersion }),
      ...(beforeEntryRetained === undefined ? {} : { beforeEntryRetained }),
    };
  }

  private readEntryRows(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
  }): EntryRow[] {
    const attemptClause = input.attemptIds === undefined
      ? ""
      : ` AND attempt_id IN (${input.attemptIds.map(() => "?").join(", ")})`;
    const beforeClause = input.beforeEntry === undefined
      ? ""
      : ` AND (
          observation_version < ?
          OR observation_version = ? AND source_sequence < ?
          OR observation_version = ? AND source_sequence = ? AND entry_id < ?
        )`;
    const limit = Math.min(50, Math.max(1, input.entryLimit ?? 1)) + 1;
    const parameters: Array<string | number> = [
      input.runId,
      ...(input.attemptIds ?? []),
      ...(input.beforeEntry === undefined
        ? []
        : [
            input.beforeEntry.observationVersion,
            input.beforeEntry.observationVersion,
            input.beforeEntry.sourceSequence,
            input.beforeEntry.observationVersion,
            input.beforeEntry.sourceSequence,
            input.beforeEntry.id,
          ]),
      limit,
    ];
    return this.db.prepare(`
      SELECT attempt_id, turn_no, entry_id, observation_version, source_sequence,
             observed_at, kind, payload_json, payload_bytes
      FROM agent_observation_entries
      WHERE run_id = ?${attemptClause}${beforeClause}
      ORDER BY observation_version DESC, source_sequence DESC, entry_id DESC
      LIMIT ?
    `).all(...parameters) as EntryRow[];
  }

  private countEntryRows(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
  }): number {
    const attemptClause = input.attemptIds === undefined
      ? ""
      : ` AND attempt_id IN (${input.attemptIds.map(() => "?").join(", ")})`;
    const beforeClause = input.beforeEntry === undefined
      ? ""
      : ` AND (
          observation_version < ?
          OR observation_version = ? AND source_sequence < ?
          OR observation_version = ? AND source_sequence = ? AND entry_id < ?
        )`;
    const parameters: Array<string | number> = [
      input.runId,
      ...(input.attemptIds ?? []),
      ...(input.beforeEntry === undefined
        ? []
        : [
            input.beforeEntry.observationVersion,
            input.beforeEntry.observationVersion,
            input.beforeEntry.sourceSequence,
            input.beforeEntry.observationVersion,
            input.beforeEntry.sourceSequence,
            input.beforeEntry.id,
          ]),
    ];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_observation_entries
      WHERE run_id = ?${attemptClause}${beforeClause}
    `).get(...parameters) as { count: number };
    return row.count;
  }

  private hasEntryBoundary(
    runId: string,
    attemptIds: readonly string[] | undefined,
    boundary: AgentObservationEntryCursor,
  ): boolean {
    if (attemptIds?.length === 0) return false;
    const attemptClause = attemptIds === undefined
      ? ""
      : ` AND attempt_id IN (${attemptIds.map(() => "?").join(", ")})`;
    return this.db.prepare(`
      SELECT 1
      FROM agent_observation_entries
      WHERE run_id = ?${attemptClause}
        AND observation_version = ?
        AND source_sequence = ?
        AND entry_id = ?
      LIMIT 1
    `).get(
      runId,
      ...(attemptIds ?? []),
      boundary.observationVersion,
      boundary.sourceSequence,
      boundary.id,
    ) !== undefined;
  }

  private requireStartedAttempt(context: AgentObservationTurnContext): void {
    if (!this.startedAttemptMatches(context)) {
      throw new Error(`Attempt '${context.attemptId}' is not the started Agent attempt being observed.`);
    }
  }

  private startedAttemptMatches(context: AgentObservationTurnContext): boolean {
    const row = this.db.prepare(`
      SELECT run_id, node_key, node_id, attempt_no, status
      FROM node_attempts
      WHERE attempt_id = ?
    `).get(context.attemptId) as {
      run_id: string;
      node_key: string;
      node_id: string;
      attempt_no: number;
      status: string;
    } | undefined;
    return Boolean(row
      && row.run_id === context.runId
      && row.node_key === context.nodeKey
      && row.node_id === context.nodeId
      && row.attempt_no === context.attemptNo
      && row.status === "started");
  }

  private advanceObservationVersion(runId: string, updatedAt: string): number {
    const row = this.db.prepare("SELECT observation_version FROM runs WHERE id = ?")
      .get(runId) as { observation_version: number } | undefined;
    if (!row) throw new Error(`Run '${runId}' was not found while updating Agent observations.`);
    const version = row.observation_version + 1;
    this.db.prepare(`
      UPDATE runs
      SET observation_version = ?, observation_updated_at = ?
      WHERE id = ?
    `).run(version, updatedAt, runId);
    return version;
  }

  private touchAttempt(runId: string, attemptId: string, version: number): void {
    this.db.prepare(`
      INSERT INTO agent_observation_attempts (run_id, attempt_id, latest_observation_version)
      VALUES (?, ?, ?)
      ON CONFLICT (run_id, attempt_id)
      DO UPDATE SET latest_observation_version = excluded.latest_observation_version
    `).run(runId, attemptId, version);
  }

  private insertSemanticEntries(
    context: Pick<AgentObservationTurnContext, "runId" | "attemptId" | "turn">,
    entries: readonly PendingSemanticEntry[],
    version: number,
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO agent_observation_entries (
        run_id, attempt_id, turn_no, entry_id, observation_version,
        source_sequence, observed_at, kind, payload_json, payload_bytes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, attempt_id, entry_id) DO NOTHING
    `);
    for (const entry of entries) {
      const payload = entry.kind === "activity"
        ? JSON.stringify({
            channel: entry.channel,
            summary: entry.summary,
            ...(entry.tool ? { tool: entry.tool } : {}),
            ...(entry.postFence ? { postFence: true } : {}),
          })
        : JSON.stringify({ dropped: entry.dropped, reason: entry.reason });
      insert.run(
        context.runId,
        context.attemptId,
        context.turn,
        entry.id,
        version,
        entry.sourceSequence,
        entry.at,
        entry.kind,
        payload,
        Buffer.byteLength(payload),
      );
    }
  }

  private updateCurrent(
    writer: AgentTurnWriter,
    current: AgentObservationCurrent | undefined,
    version: number,
  ): void {
    const json = current ? boundedCurrentJson(current) : null;
    this.db.prepare(`
      UPDATE agent_observation_turns
      SET current_json = ?,
          current_bytes = ?,
          current_updated_at = ?,
          current_observation_version = ?
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).run(
      json,
      json === null ? 0 : Buffer.byteLength(json),
      current?.updatedAt ?? new Date().toISOString(),
      version,
      writer.context.runId,
      writer.context.attemptId,
      writer.context.turn,
    );
  }

  private updateObservationCounts(writer: AgentTurnWriter): void {
    this.db.prepare(`
      UPDATE agent_observation_turns
      SET degraded = ?,
          provider_event_count = ?,
          unknown_event_count = ?
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).run(
      writer.degraded ? 1 : 0,
      writer.providerEventCount,
      writer.unknownEventCount,
      writer.context.runId,
      writer.context.attemptId,
      writer.context.turn,
    );
  }

  private trimAttemptEntries(runId: string, attemptId: string): void {
    const rows = this.db.prepare(`
      SELECT entry_id, observation_version, payload_bytes
      FROM agent_observation_entries
      WHERE run_id = ? AND attempt_id = ?
      ORDER BY observation_version, source_sequence, entry_id
    `).all(runId, attemptId) as Array<{
      entry_id: string;
      observation_version: number;
      payload_bytes: number;
    }>;
    let count = rows.length;
    let bytes = rows.reduce((total, row) => total + row.payload_bytes, 0);
    let deleted = 0;
    let floor: number | undefined;
    const remove = this.db.prepare(`
      DELETE FROM agent_observation_entries
      WHERE run_id = ? AND attempt_id = ? AND entry_id = ?
    `);
    for (const row of rows) {
      if (count <= semanticEntryLimit && bytes <= semanticPayloadLimit) break;
      remove.run(runId, attemptId, row.entry_id);
      count -= 1;
      bytes -= row.payload_bytes;
      deleted += 1;
      floor = Math.max(floor ?? 0, row.observation_version);
    }
    if (deleted === 0) return;
    this.db.prepare(`
      UPDATE agent_observation_attempts
      SET retention_omitted_count = retention_omitted_count + ?,
          retention_floor_version = MAX(COALESCE(retention_floor_version, 0), ?)
      WHERE run_id = ? AND attempt_id = ?
    `).run(deleted, floor!, runId, attemptId);
  }

  private turnRows(
    runId: string,
    attemptIds?: readonly string[],
    latestOnly?: true,
  ): TurnRow[] {
    if (attemptIds?.length === 0) return [];
    const attemptClause = attemptIds === undefined
      ? ""
      : ` AND attempt_id IN (${attemptIds.map(() => "?").join(", ")})`;
    return this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ?${attemptClause}
      ORDER BY ${latestOnly ? "turn_no DESC" : "attempt_no, turn_no"}
      ${latestOnly ? "LIMIT 1" : ""}
    `).all(runId, ...(attemptIds ?? [])) as TurnRow[];
  }

  private attemptRows(
    runId: string,
    attemptIds?: readonly string[],
  ): Map<string, AttemptObservationRow> {
    if (attemptIds?.length === 0) return new Map();
    const attemptClause = attemptIds === undefined
      ? ""
      : ` AND attempt_id IN (${attemptIds.map(() => "?").join(", ")})`;
    const rows = this.db.prepare(`
      SELECT attempt_id, latest_observation_version, retention_omitted_count, retention_floor_version
      FROM agent_observation_attempts
      WHERE run_id = ?${attemptClause}
    `).all(runId, ...(attemptIds ?? [])) as Array<AttemptObservationRow & { attempt_id: string }>;
    return new Map(rows.map(row => [row.attempt_id, row]));
  }

  private turnRow(runId: string, attemptId: string, turn: number): TurnRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).get(runId, attemptId, turn) as TurnRow | undefined;
  }

  private nextSourceSequence(runId: string, attemptId: string, turn: number): number {
    const row = this.db.prepare(`
      SELECT MAX(source_sequence) AS source_sequence
      FROM agent_observation_entries
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).get(runId, attemptId, turn) as { source_sequence: number | null };
    return (row.source_sequence ?? -1) + 1;
  }
}

export class AgentTurnWriter {
  fenced = false;
  providerEventCount = 0;
  unknownEventCount = 0;
  degraded = false;
  private maxSourceSequence = -1;
  private readonly reducer: AgentObservationSemanticReducer;
  private failure: unknown;
  private terminalMutation: SemanticMutation | undefined;
  private durableFenceSequence?: number;
  private boundaryClosed = false;
  private finished = false;

  constructor(
    private readonly log: AgentObservationLog,
    readonly context: AgentObservationTurnContext,
  ) {
    this.reducer = new AgentObservationSemanticReducer(context);
  }

  start(): void {
    this.log.beginTurn(this, new Date().toISOString());
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    return this.reducer.initialCurrent(observedAt);
  }

  observe(observation: AgentTurnObservation): void {
    this.maxSourceSequence = Math.max(this.maxSourceSequence, observation.event.sequence);
    this.providerEventCount += 1;
    if (observation.event.type === "unknown") {
      this.unknownEventCount += 1;
      this.degraded = true;
    }
    try {
      const mutation = this.reducer.observe(observation, this.degraded);
      if (observation.event.type === "turn_end") {
        this.terminalMutation = mutation;
        return;
      }
      if (!mutation.checkpoint && mutation.entries.length === 0) return;
      this.log.persistObservation(this, mutation);
    } catch (error) {
      this.failure ??= error;
    }
  }

  markFenced(input: AgentObservationFenceInput): Promise<void> {
    return this.applyFence(input.eventSequence, input.committedAt, input.reason);
  }

  markFallbackFenced(
    reason: string,
    observedAt = new Date().toISOString(),
  ): Promise<void> {
    return this.applyFence(undefined, observedAt, reason);
  }

  finish(result: AgentTurnResult): void {
    if (this.finished) return;
    if (this.failure !== undefined) throw this.failure;
    const remainder = this.reducer.terminal(result, this.degraded);
    const mutation = this.terminalMutation
      ? {
          entries: [...this.terminalMutation.entries, ...remainder.entries],
          checkpoint: true,
          current: remainder.current,
          observedAt: result.timing.finishedAt,
        }
      : remainder;
    this.log.finishTurn(this, result, mutation);
    this.finished = true;
  }

  markIncomplete(reason: string): void {
    if (this.finished) return;
    const observedAt = new Date().toISOString();
    const mutation = this.reducer.gap(
      observedAt,
      this.nextSyntheticSequence(),
      1,
      reason,
    );
    this.log.markWriterIncomplete(this, mutation);
    this.finished = true;
  }

  private applyFence(
    eventSequence: number | undefined,
    committedAt: string,
    reason: string,
  ): Promise<void> {
    if (this.finished) {
      return Promise.resolve();
    }
    if (eventSequence !== undefined && this.durableFenceSequence !== undefined) {
      if (eventSequence === this.durableFenceSequence) return Promise.resolve();
      return Promise.reject(new Error(
        `Agent observation turn '${this.context.attemptId}:${this.context.turn}' already has a different durable fence.`,
      ));
    }
    const mutation = this.boundaryClosed
      ? { entries: [], checkpoint: true, current: undefined, observedAt: committedAt }
      : this.reducer.boundary(committedAt);
    try {
      this.log.persistFence(this, {
        ...(eventSequence === undefined ? {} : { eventSequence }),
        committedAt,
        reason,
        mutation,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    this.fenced = true;
    this.boundaryClosed = true;
    if (eventSequence !== undefined) this.durableFenceSequence = eventSequence;
    return Promise.resolve();
  }

  private nextSyntheticSequence(): number {
    this.maxSourceSequence += 1;
    return this.maxSourceSequence;
  }
}

class AgentObservationSemanticReducer {
  private segment: {
    channel: "response" | "reported-thought" | "plan";
    sourceSequence: number;
    at: string;
    text: string;
    originalBytes: number;
  } | undefined;
  private readonly tools = new Map<string, AgentObservationToolActivity & { sourceSequence: number }>();
  private recentTool: AgentObservationToolActivity | undefined;
  private updatedAt: string;
  private lastCheckpointAt = 0;
  private lastCheckpointTextBytes = 0;
  private unknownSeen = false;
  private fenced = false;
  private context?: AgentContextSummary;
  private tokenUsage?: AgentTokenUsageSummary;

  constructor(private readonly contextIdentity: AgentObservationTurnContext) {
    this.updatedAt = new Date().toISOString();
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    this.updatedAt = observedAt;
    this.lastCheckpointAt = Date.parse(observedAt);
    return this.current(false);
  }

  observe(
    observation: AgentTurnObservation,
    degraded: boolean,
  ): SemanticMutation {
    const { event } = observation;
    const telemetryChanged = this.updateTelemetry(observation.progress.summary);
    if (event.type === "usage") {
      this.updatedAt = event.observedAt;
      return {
        entries: [],
        checkpoint: telemetryChanged,
        current: telemetryChanged ? this.current(degraded) : undefined,
        observedAt: event.observedAt,
      };
    }
    this.updatedAt = event.observedAt;
    const beforePhase = this.phase();
    const entries: PendingSemanticEntry[] = [];
    let toolBoundary = false;
    const firstUnknown = event.type === "unknown" && !this.unknownSeen;
    if (event.type === "unknown") this.unknownSeen = true;
    if (event.type === "message") {
      const channel = event.channel === "assistant" ? "response" : "reported-thought";
      if (this.segment?.channel !== channel) entries.push(...this.closeSegment());
      this.segment ??= {
        channel,
        sourceSequence: event.sequence,
        at: event.observedAt,
        text: "",
        originalBytes: 0,
      };
      appendSemanticText(this.segment, eventText(event.content));
      this.segment.at = event.observedAt;
    } else if (event.type === "plan") {
      if (this.segment?.channel !== "plan") entries.push(...this.closeSegment());
      this.segment ??= {
        channel: "plan",
        sourceSequence: event.sequence,
        at: event.observedAt,
        text: "",
        originalBytes: 0,
      };
      appendSemanticText(this.segment, eventText(event.value));
      this.segment.at = event.observedAt;
    } else if (event.type === "tool") {
      entries.push(...this.closeSegment());
      const id = event.toolCallId ?? `anonymous-${event.sequence}`;
      const previous = this.tools.get(id);
      const tool = mergeTool(previous, event);
      if (terminalToolStatuses.has(tool.status ?? "")) {
        toolBoundary = true;
        entries.push(toolEntry(
          this.contextIdentity,
          tool,
          previous?.sourceSequence ?? event.sequence,
          this.fenced,
        ));
        this.tools.delete(id);
        this.recentTool = tool;
      } else {
        toolBoundary = previous === undefined;
        this.tools.set(id, { ...tool, sourceSequence: previous?.sourceSequence ?? event.sequence });
      }
    } else if (event.type === "turn_end") {
      entries.push(...this.closeAll());
    }
    const afterPhase = this.phase();
    const now = Date.parse(event.observedAt);
    const textBytes = this.segment?.originalBytes ?? 0;
    const checkpoint = entries.length > 0
      || beforePhase !== afterPhase
      || toolBoundary
      || firstUnknown
      || event.type === "turn_end"
      || telemetryChanged
      || textBytes - this.lastCheckpointTextBytes >= responseCheckpointBytes
      || Number.isFinite(now) && now - this.lastCheckpointAt >= checkpointIntervalMs;
    if (checkpoint) {
      this.lastCheckpointAt = Number.isFinite(now) ? now : this.lastCheckpointAt;
      this.lastCheckpointTextBytes = textBytes;
    }
    return {
      entries,
      checkpoint,
      current: event.type === "turn_end" ? undefined : this.current(degraded),
      observedAt: event.observedAt,
    };
  }

  boundary(at: string): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    this.fenced = true;
    return { entries, checkpoint: true, current: undefined, observedAt: at };
  }

  terminal(
    result: AgentTurnResult,
    degraded: boolean,
  ): SemanticMutation {
    const at = result.timing.finishedAt;
    this.updatedAt = at;
    this.updateTelemetry(result.summary);
    const entries = this.closeAll();
    const response = result.status === "completed" ? result.finalResponse : result.responses.at(-1) ?? "";
    return {
      entries,
      checkpoint: true,
      current: this.current(degraded, {
        phase: "settled",
        state: "settled",
        ...(response.length === 0
          ? {}
          : { response: excerpt(response, currentResponseBytes, "tail") }),
      }),
      observedAt: at,
    };
  }

  gap(
    at: string,
    sourceSequence: number,
    dropped: number,
    reason: string,
  ): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    entries.push({
      id: `observation:${this.contextIdentity.attemptId}:${this.contextIdentity.turn}:${sourceSequence}:gap`,
      kind: "gap",
      attemptId: this.contextIdentity.attemptId,
      turn: this.contextIdentity.turn,
      sourceSequence,
      at,
      dropped,
      reason,
    });
    return { entries, checkpoint: true, current: undefined, observedAt: at };
  }

  checkpoint(
    entries: PendingSemanticEntry[],
    degraded: boolean,
  ): SemanticMutation {
    return {
      entries,
      checkpoint: true,
      current: this.current(degraded),
      observedAt: this.updatedAt,
    };
  }

  private current(
    degraded: boolean,
    terminal: Partial<Pick<AgentObservationCurrent, "phase" | "response" | "state">> = {},
  ): AgentObservationCurrent {
    const active = [...this.tools.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const selected = active.slice(-2).map(({ sourceSequence: _sourceSequence, ...tool }) => tool);
    const phase = this.phase();
    const segment = this.segment;
    return {
      attemptId: this.contextIdentity.attemptId,
      turn: this.contextIdentity.turn,
      promptKind: this.contextIdentity.promptKind,
      phase: terminal.phase ?? phase,
      updatedAt: this.updatedAt,
      ...(this.fenced ? { postFence: true } : {}),
      ...(terminal.response
        ? { response: terminal.response }
        : segment?.channel === "response" && segment.text
        ? { response: semanticExcerpt(segment, currentResponseBytes) }
        : {}),
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.tokenUsage === undefined ? {} : { tokenUsage: this.tokenUsage }),
      ...(segment && segment.channel !== "response" && segment.text
        ? {
            intent: {
              kind: segment.channel,
              excerpt: semanticExcerpt(segment, currentIntentBytes),
            },
          }
        : {}),
      ...(active.length > 0 || this.recentTool
        ? {
            tools: {
              active: selected,
              ...(active.length === 0 && this.recentTool ? { recent: this.recentTool } : {}),
              omittedActive: Math.max(0, active.length - selected.length),
            },
          }
        : {}),
      state: terminal.state ?? "recording",
      completeness: degraded ? "degraded" : "complete",
    };
  }

  private updateTelemetry(summary: AgentTurnObservation["progress"]["summary"]): boolean {
    const changed = !equalTelemetry(this.context, summary.context)
      || !equalTelemetry(this.tokenUsage, summary.tokenUsage);
    if (summary.context === undefined) delete this.context;
    else this.context = summary.context;
    if (summary.tokenUsage === undefined) delete this.tokenUsage;
    else this.tokenUsage = summary.tokenUsage;
    return changed;
  }

  private phase(): AgentObservationPhase {
    if (this.tools.size > 0) return "tool";
    if (this.segment?.channel === "plan") return "planning";
    if (this.segment?.channel === "reported-thought") return "thinking";
    if (this.segment?.channel === "response" && this.segment.text) return "responding";
    return this.contextIdentity.promptKind === "repair" ? "repairing" : "starting";
  }

  private closeAll(): PendingSemanticEntry[] {
    const entries = this.closeSegment();
    for (const tool of this.tools.values()) {
      entries.push(toolEntry(this.contextIdentity, tool, tool.sourceSequence, this.fenced));
    }
    this.tools.clear();
    return entries;
  }

  private closeSegment(): PendingSemanticEntry[] {
    const segment = this.segment;
    this.segment = undefined;
    if (!segment?.text) return [];
    return [{
      id: `observation:${this.contextIdentity.attemptId}:${this.contextIdentity.turn}:${segment.sourceSequence}:${segment.channel}`,
      kind: "activity",
      attemptId: this.contextIdentity.attemptId,
      turn: this.contextIdentity.turn,
      sourceSequence: segment.sourceSequence,
      at: segment.at,
      channel: segment.channel,
      summary: semanticExcerpt(segment, timelineEntryBytes),
      ...(this.fenced ? { postFence: true } : {}),
    }];
  }
}

function equalTelemetry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTool(
  previous: (AgentObservationToolActivity & { sourceSequence: number }) | undefined,
  event: Extract<AgentObservationEvent, { type: "tool" }>,
): AgentObservationToolActivity {
  const inputText = event.rawInput === undefined ? undefined : eventText(event.rawInput);
  const outputValue = event.rawOutput ?? event.content;
  const outputText = outputValue === undefined ? undefined : eventText(outputValue);
  const [inputBudget, outputBudget] = inputText !== undefined && outputText !== undefined
    ? [Math.floor(currentToolBytes / 2), Math.ceil(currentToolBytes / 2)]
    : [currentToolBytes, currentToolBytes];
  const status = event.status ?? previous?.status;
  const toolCallId = event.toolCallId ?? previous?.toolCallId;
  return {
    ...(toolCallId ? { toolCallId } : {}),
    name: visible(event.toolName ?? event.title ?? event.kind ?? previous?.name ?? "tool", 160),
    ...(status ? { status: visible(status, 64) } : {}),
    ...(inputText === undefined
      ? previous?.input ? { input: previous.input } : {}
      : { input: excerpt(inputText, inputBudget, "head") }),
    ...(outputText === undefined
      ? previous?.output ? { output: previous.output } : {}
      : { output: excerpt(outputText, outputBudget, "tail") }),
    startedAt: previous?.startedAt ?? event.observedAt,
    updatedAt: event.observedAt,
    ...(terminalToolStatuses.has(status ?? "") ? { finishedAt: event.observedAt } : {}),
  };
}

function toolEntry(
  context: AgentObservationTurnContext,
  tool: AgentObservationToolActivity,
  sourceSequence: number,
  postFence: boolean,
): PendingSemanticEntry {
  const { sourceSequence: _sourceSequence, ...activity } =
    tool as AgentObservationToolActivity & { sourceSequence?: number };
  const bounded = boundedTimelineTool(activity);
  return {
    id: `observation:${context.attemptId}:${context.turn}:${sourceSequence}:tool`,
    kind: "activity",
    attemptId: context.attemptId,
    turn: context.turn,
    sourceSequence,
    at: activity.updatedAt,
    channel: "tool",
    summary: bounded.summary,
    tool: bounded.tool,
    ...(postFence ? { postFence: true } : {}),
  };
}

function boundedTimelineTool(tool: AgentObservationToolActivity): {
  summary: AgentObservationExcerpt;
  tool: AgentObservationToolActivity;
} {
  const summary = excerpt(
    `${tool.name}${tool.status ? ` ${tool.status}` : ""}`,
    timelineEntryBytes,
    "head",
  );
  const remaining = Math.max(0, timelineEntryBytes - Buffer.byteLength(summary.text));
  const inputBudget = tool.input && tool.output ? Math.floor(remaining / 2) : remaining;
  const outputBudget = tool.input && tool.output ? remaining - inputBudget : remaining;
  return {
    summary,
    tool: {
      ...tool,
      ...(tool.input ? { input: limitExcerpt(tool.input, inputBudget, "head") } : {}),
      ...(tool.output ? { output: limitExcerpt(tool.output, outputBudget, "tail") } : {}),
    },
  };
}

function entryFromCurrent(
  current: AgentObservationCurrent,
  sourceSequence: number,
): PendingSemanticEntry | undefined {
  const tool = current.tools?.active.at(-1) ?? current.tools?.recent;
  if (tool) {
    const bounded = boundedTimelineTool(tool);
    return {
      id: `observation:${current.attemptId}:${current.turn}:${sourceSequence}:recovered-tool`,
      kind: "activity",
      attemptId: current.attemptId,
      turn: current.turn,
      sourceSequence,
      at: current.updatedAt,
      channel: "tool",
      summary: bounded.summary,
      tool: bounded.tool,
      ...(current.postFence ? { postFence: true } : {}),
    };
  }
  if (current.intent) {
    return {
      id: `observation:${current.attemptId}:${current.turn}:${sourceSequence}:recovered-${current.intent.kind}`,
      kind: "activity",
      attemptId: current.attemptId,
      turn: current.turn,
      sourceSequence,
      at: current.updatedAt,
      channel: current.intent.kind,
      summary: current.intent.excerpt,
      ...(current.postFence ? { postFence: true } : {}),
    };
  }
  if (current.response) return {
    id: `observation:${current.attemptId}:${current.turn}:${sourceSequence}:recovered-response`,
    kind: "activity",
    attemptId: current.attemptId,
    turn: current.turn,
    sourceSequence,
    at: current.updatedAt,
    channel: "response",
    summary: current.response,
    ...(current.postFence ? { postFence: true } : {}),
  };
  return undefined;
}

function boundedCurrentJson(current: AgentObservationCurrent): string {
  let json = JSON.stringify(current);
  if (Buffer.byteLength(json) <= currentPayloadLimit) return json;
  const smaller: AgentObservationCurrent = {
    ...current,
    ...(current.response ? { response: limitExcerpt(current.response, 512, "tail") } : {}),
    ...(current.intent
      ? { intent: { ...current.intent, excerpt: limitExcerpt(current.intent.excerpt, 256, "tail") } }
      : {}),
    ...(current.tools
      ? {
          tools: {
            active: current.tools.active.map(withoutToolPayload),
            ...(current.tools.recent
              ? { recent: withoutToolPayload(current.tools.recent) }
              : {}),
            omittedActive: current.tools.omittedActive,
          },
        }
      : {}),
  };
  json = JSON.stringify(smaller);
  if (Buffer.byteLength(json) > currentPayloadLimit) {
    throw new Error("Bounded Agent current projection exceeds 16 KiB.");
  }
  return json;
}

function withoutToolPayload(tool: AgentObservationToolActivity): AgentObservationToolActivity {
  const { input: _input, output: _output, ...metadata } = tool;
  return metadata;
}

function semanticEntry(row: EntryRow): AgentObservationSemanticEntry {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const base: AgentObservationEntryBase = {
    id: row.entry_id,
    observationVersion: row.observation_version,
    attemptId: row.attempt_id,
    turn: row.turn_no,
    sourceSequence: row.source_sequence,
    at: row.observed_at,
  };
  if (row.kind === "gap") {
    return {
      ...base,
      kind: "gap",
      dropped: typeof payload.dropped === "number" ? payload.dropped : 1,
      reason: typeof payload.reason === "string" ? payload.reason : "observation_gap",
    };
  }
  return {
    ...base,
    kind: "activity",
    channel: payload.channel as "response" | "reported-thought" | "plan" | "tool",
    summary: payload.summary as AgentObservationExcerpt,
    ...(payload.tool ? { tool: payload.tool as AgentObservationToolActivity } : {}),
    ...(payload.postFence === true ? { postFence: true } : {}),
  };
}

function parseCurrent(json: string | null): AgentObservationCurrent | undefined {
  return json === null ? undefined : JSON.parse(json) as AgentObservationCurrent;
}

function rowContext(row: TurnRow): Pick<AgentObservationTurnContext, "runId" | "attemptId" | "turn"> {
  return { runId: row.run_id, attemptId: row.attempt_id, turn: row.turn_no };
}



function gapEntry(
  row: Pick<TurnRow, "attempt_id" | "turn_no">,
  sourceSequence: number,
  at: string,
  reason: string,
): PendingSemanticEntry {
  return {
    id: `observation:${row.attempt_id}:${row.turn_no}:${sourceSequence}:gap`,
    kind: "gap",
    attemptId: row.attempt_id,
    turn: row.turn_no,
    sourceSequence,
    at,
    dropped: 1,
    reason,
  };
}

function observationTurn(row: TurnRow): AgentObservationTurn {
  return {
    runId: row.run_id,
    attemptId: row.attempt_id,
    nodeKey: row.node_key,
    nodeId: row.node_id,
    attemptNo: row.attempt_no,
    turn: row.turn_no,
    promptKind: row.prompt_kind,
    state: row.state,
    completeness: row.degraded === 0 ? "complete" : "degraded",
    gapCount: row.gap_count,
    eventCount: row.provider_event_count,
    unknownEventCount: row.unknown_event_count,
    ...(row.fence_event_sequence === null ? {} : { fenceEventSequence: row.fence_event_sequence }),
    ...(row.fenced_at === null ? {} : { fencedAt: row.fenced_at }),
    ...(row.fence_reason === null ? {} : { fenceReason: row.fence_reason }),
    ...(row.provider_status === null ? {} : { providerStatus: row.provider_status }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  };
}

function excerpt(value: string, maxBytes: number, side: "head" | "tail"): AgentObservationExcerpt {
  const originalBytes = Buffer.byteLength(value);
  return {
    text: originalBytes <= maxBytes
      ? value
      : side === "head" ? utf8Head(value, maxBytes) : utf8Tail(value, maxBytes),
    originalBytes,
    truncated: originalBytes > maxBytes,
  };
}

export function appendSemanticText(
  segment: { text: string; originalBytes: number },
  value: string,
): void {
  segment.originalBytes += Buffer.byteLength(value);
  segment.text = utf8Tail(segment.text + value, currentResponseBytes);
}

function semanticExcerpt(
  segment: { text: string; originalBytes: number },
  maxBytes: number,
): AgentObservationExcerpt {
  return {
    text: utf8Tail(segment.text, maxBytes),
    originalBytes: segment.originalBytes,
    truncated: segment.originalBytes > maxBytes,
  };
}

function limitExcerpt(
  value: AgentObservationExcerpt,
  maxBytes: number,
  side: "head" | "tail",
): AgentObservationExcerpt {
  const bytes = Buffer.byteLength(value.text);
  return {
    text: bytes <= maxBytes
      ? value.text
      : side === "head" ? utf8Head(value.text, maxBytes) : utf8Tail(value.text, maxBytes),
    originalBytes: value.originalBytes,
    truncated: value.truncated || bytes > maxBytes,
  };
}

function visible(value: string, maxCharacters: number): string {
  return [...value.replace(/\s+/g, " ").trim()].slice(0, maxCharacters).join("");
}

function eventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(eventText).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.value === "string") return record.value;
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function cancelledBeforeProviderDispatch(): AgentTurnResult {
  const observedAt = new Date().toISOString();
  return {
    status: "cancelled",
    message: "Agent turn was fenced before provider dispatch.",
    responses: [],
    stderr: "",
    summary: {
      eventCount: 0,
      availability: { context: "unavailable", tokenUsage: "unavailable" },
      tools: { totalToolCallCount: 0, calls: [] },
    },
    timing: {
      startedAt: observedAt,
      finishedAt: observedAt,
      elapsedMs: 0,
    },
  };
}

function providerOutcome(result: AgentTurnResult): NonNullable<AgentObservationTurn["providerStatus"]> {
  return result.status === "failed" && result.failure.kind === "timeout" ? "timed_out" : result.status;
}



function activeKey(runId: string, attemptId: string, turn: number): string {
  return `${runId}\0${attemptId}\0${turn}`;
}

function notifyObserver(
  observer: AgentTurnRequest["onObservation"],
  observation: AgentTurnObservation,
): void {
  if (!observer) return;
  try {
    const result = observer(observation);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {}
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
