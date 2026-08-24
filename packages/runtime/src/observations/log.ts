import type { DatabaseSync } from "node:sqlite";
import {
  type AgentTurnEvent,
  type AgentTurnSnapshot,
} from "@acpus/agent-executor";
import * as Effect from "effect/Effect";
import {
  AgentObservationSemanticReducer,
  boundAgentObservationTimelineTool,
  limitAgentObservationExcerpt,
  type AgentObservationCompleteness,
  type AgentObservationCurrent,
  type AgentObservationEntryBase,
  type AgentObservationExcerpt,
  type AgentObservationSemanticEntry,
  type AgentObservationState,
  type AgentObservationToolActivity,
  type AgentPromptKind,
  type PendingSemanticEntry,
  type SemanticMutation,
} from "./turn-semantics.js";

export type { AgentObservationCurrent } from "./turn-semantics.js";

const semanticEntryLimit = 128;
const semanticPayloadLimit = 128 * 1024;
const semanticReadPayloadLimit = 8 * 1024;
const currentPayloadLimit = 16 * 1024;

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

export type AgentObservationTerminal = Readonly<{
  status: "completed" | "failed" | "cancelled" | "timed_out";
  snapshot: AgentTurnSnapshot;
  finalResponse?: string;
}>;

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

  constructor(private readonly db: DatabaseSync) {}

  captureTurn<Request, TurnResult extends AgentObservationTerminal, Failure, Requirements>(
    context: AgentObservationTurnContext,
    request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>,
    runTurn: (request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>) => Effect.Effect<TurnResult, Failure, Requirements>,
    cancelled: () => TurnResult,
  ): Effect.Effect<TurnResult, Failure, Requirements> {
    return Effect.suspend(() => {
      const writer = new AgentTurnWriter(this, context);
      const key = activeKey(context.runId, context.attemptId, context.turn);
      if (this.active.has(key)) {
        throw new Error(`Agent observation turn '${context.attemptId}:${context.turn}' is already active.`);
      }
      this.active.set(key, writer);
      writer.start();
      return this.captureStartedTurn(writer, context, request, runTurn, cancelled).pipe(
        Effect.ensuring(Effect.sync(() => this.active.delete(key))),
      );
    });
  }

  private captureStartedTurn<Request, TurnResult extends AgentObservationTerminal, Failure, Requirements>(
    writer: AgentTurnWriter,
    context: AgentObservationTurnContext,
    request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>,
    runTurn: (request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>) => Effect.Effect<TurnResult, Failure, Requirements>,
    cancelled: () => TurnResult,
  ): Effect.Effect<TurnResult, Failure, Requirements> {
    const log = this;
    const onAbort = (): void => {
      try {
        writer.markFallbackFencedNow("runtime_abort", new Date().toISOString());
      } catch {
        // The primary Turn settlement retains authority over error composition.
      }
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    return Effect.gen(function* () {
      if (!writer.fenced && !log.startedAttemptMatches(context)) {
        yield* Effect.sync(() => writer.markFallbackFencedNow("runtime_abort"));
      }
      const result = writer.fenced
        ? cancelled()
        : yield* runTurn({
            ...request,
            onEvent: (event: AgentTurnEvent) => {
              writer.observe(event);
              notifyObserver(request.onEvent, event);
            },
          } as Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>);
      writer.finish(result);
      return result;
    }).pipe(
      Effect.onInterrupt(() => Effect.sync(() => writer.markFallbackFencedNow("runtime_abort")).pipe(Effect.ignore)),
      Effect.onError(() => Effect.sync(() => writer.markIncomplete("provider_settlement_missing"))),
      Effect.ensuring(Effect.sync(() => context.signal?.removeEventListener("abort", onAbort))),
    );
  }

  markFenced(input: AgentObservationFenceInput): Effect.Effect<void> {
    return Effect.sync(() => {
      const writer = [...this.active.values()]
        .filter(candidate =>
          candidate.context.runId === input.runId && candidate.context.attemptId === input.attemptId)
        .sort((left, right) => right.context.turn - left.context.turn)[0];
      if (writer) writer.markFenced(input);
      else this.persistUnavailableFence(input);
    });
  }

  readInspectionProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
    latestTurnPerAttempt?: true;
    includeOlderCount?: boolean;
  }): Effect.Effect<AgentObservationInspectionProjection, AgentObservationReadError> {
    return Effect.try({
      try: () => this.readProjection(input),
      catch: cause => ({
        type: "observation-read-failed",
        runId: input.runId,
        message: `Agent observations for run '${input.runId}' could not be read: ${causeMessage(cause)}.`,
        cause,
      }),
    });
  }

  reconcileInterruptedTurns(
    runId: string,
  ): Effect.Effect<void, AgentObservationReconciliationError> {
    return Effect.try({
      try: () => this.reconcileRun(runId),
      catch: cause => ({
        type: "observation-reconciliation-failed",
        runId,
        message: `Agent observations for run '${runId}' could not be reconciled: ${causeMessage(cause)}.`,
        cause,
      }),
    });
  }

  reconcileTerminalTurns(): Effect.Effect<void> {
    return Effect.sync(() => {
      const rows = this.db.prepare(`
        SELECT id AS run_id
        FROM runs
        WHERE status IN ('completed', 'failed', 'canceled')
        ORDER BY id
      `).all() as Array<{ run_id: string }>;
      for (const row of rows) this.reconcileRun(row.run_id);
    });
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
    result: AgentObservationTerminal,
    mutation: SemanticMutation,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, result.snapshot.timing.finishedAt);
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
        result.snapshot.timing.finishedAt,
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
    latestTurnPerAttempt?: true;
    includeOlderCount?: boolean;
  }): AgentObservationInspectionProjection {
    const versionRow = this.db.prepare("SELECT observation_version FROM runs WHERE id = ?")
      .get(input.runId) as { observation_version: number } | undefined;
    if (!versionRow) throw new Error(`Run '${input.runId}' was not found.`);
    const turns = this.turnRows(input.runId, input.attemptIds, input.latestTurnPerAttempt);
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
    const olderEntryCount = input.latestTurnPerAttempt || input.includeOlderCount === false
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
      ...(input.latestTurnPerAttempt && turns.some(row => row.turn_no > 1) ? { omittedTurns: true } : {}),
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
    latestPerAttempt?: true,
  ): TurnRow[] {
    if (attemptIds?.length === 0) return [];
    const attemptClause = attemptIds === undefined
      ? ""
      : ` AND turn.attempt_id IN (${attemptIds.map(() => "?").join(", ")})`;
    const latestClause = latestPerAttempt
      ? ` AND turn.turn_no = (
          SELECT MAX(candidate.turn_no)
          FROM agent_observation_turns AS candidate
          WHERE candidate.run_id = turn.run_id
            AND candidate.attempt_id = turn.attempt_id
        )`
      : "";
    return this.db.prepare(`
      SELECT turn.*
      FROM agent_observation_turns AS turn
      WHERE turn.run_id = ?${attemptClause}${latestClause}
      ORDER BY turn.attempt_no, turn.attempt_id, turn.turn_no
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

class AgentTurnWriter {
  fenced = false;
  providerEventCount = 0;
  unknownEventCount = 0;
  degraded = false;
  private maxSourceSequence = -1;
  private readonly reducer: AgentObservationSemanticReducer;
  private failure: unknown;
  private durableFenceSequence?: number;
  private boundaryClosed = false;
  private finished = false;

  constructor(
    private readonly log: AgentObservationLog,
    readonly context: AgentObservationTurnContext,
  ) {
    this.reducer = new AgentObservationSemanticReducer({
      attemptId: context.attemptId,
      turn: context.turn,
      promptKind: context.promptKind,
    });
  }

  start(): void {
    this.log.beginTurn(this, new Date().toISOString());
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    return this.reducer.initialCurrent(observedAt);
  }

  observe(observation: AgentTurnEvent): void {
    this.maxSourceSequence = Math.max(this.maxSourceSequence, observation.sequence);
    this.providerEventCount += 1;
    if (observation.event.type === "unknown") {
      this.unknownEventCount += 1;
      this.degraded = true;
    }
    try {
      const mutation = this.reducer.observe(observation, this.degraded);
      if (!mutation.checkpoint && mutation.entries.length === 0) return;
      this.log.persistObservation(this, mutation);
    } catch (error) {
      this.failure ??= error;
    }
  }

  markFenced(input: AgentObservationFenceInput): void {
    this.applyFence(input.eventSequence, input.committedAt, input.reason);
  }

  markFallbackFencedNow(
    reason: string,
    observedAt = new Date().toISOString(),
  ): void {
    this.applyFence(undefined, observedAt, reason);
  }

  finish(result: AgentObservationTerminal): void {
    if (this.finished) return;
    if (this.failure !== undefined) throw this.failure;
    const remainder = this.reducer.terminal(
      result.snapshot,
      this.degraded,
      result.status === "completed" && result.finalResponse !== undefined
        ? { finalResponse: result.finalResponse }
        : undefined,
    );
    this.log.finishTurn(this, result, remainder);
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
  ): void {
    if (this.finished) {
      return;
    }
    if (eventSequence !== undefined && this.durableFenceSequence !== undefined) {
      if (eventSequence === this.durableFenceSequence) return;
      throw new Error(
        `Agent observation turn '${this.context.attemptId}:${this.context.turn}' already has a different durable fence.`,
      );
    }
    const mutation = this.boundaryClosed
      ? { entries: [], checkpoint: true, current: undefined, observedAt: committedAt }
      : this.reducer.boundary(committedAt);
    this.log.persistFence(this, {
      ...(eventSequence === undefined ? {} : { eventSequence }),
      committedAt,
      reason,
      mutation,
    });
    this.fenced = true;
    this.boundaryClosed = true;
    if (eventSequence !== undefined) this.durableFenceSequence = eventSequence;
  }

  private nextSyntheticSequence(): number {
    this.maxSourceSequence += 1;
    return this.maxSourceSequence;
  }
}

function entryFromCurrent(
  current: AgentObservationCurrent,
  sourceSequence: number,
): PendingSemanticEntry | undefined {
  const tool = current.tools?.active.at(-1) ?? current.tools?.recent;
  if (tool) {
    const bounded = boundAgentObservationTimelineTool(tool);
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
    ...(current.response
      ? { response: limitAgentObservationExcerpt(current.response, 512, "tail") }
      : {}),
    ...(current.intent
      ? {
          intent: {
            ...current.intent,
            excerpt: limitAgentObservationExcerpt(current.intent.excerpt, 256, "tail"),
          },
        }
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

function providerOutcome(result: AgentObservationTerminal): NonNullable<AgentObservationTurn["providerStatus"]> {
  return result.status;
}

function activeKey(runId: string, attemptId: string, turn: number): string {
  return `${runId}\0${attemptId}\0${turn}`;
}

function notifyObserver(
  observer: ((event: AgentTurnEvent) => unknown) | undefined,
  observation: AgentTurnEvent,
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
