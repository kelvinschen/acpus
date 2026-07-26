import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeAgentTurn,
  type AgentJsonValue,
  type AgentTraceEvent,
  type AgentTurnObservation,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@acpus/agent-executor";
import { ResultAsync } from "neverthrow";
import type { RuntimeLayout } from "../runtime-layout.js";

const evidenceSchemaVersion = 1;
const semanticEntryLimit = 128;
const semanticPayloadLimit = 128 * 1024;
const semanticReadPayloadLimit = 8 * 1024;
const currentPayloadLimit = 16 * 1024;
const responseCheckpointBytes = 512;
const checkpointIntervalMs = 10_000;
const traceBufferBytes = 64 * 1024;
const currentResponseBytes = 1536;
const currentIntentBytes = 768;
const currentToolBytes = 768;
const timelineEntryBytes = 512;
const boundedFailureEdgeBytes = 4 * 1024;
const terminalToolStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);

type AgentPromptKind = "task" | "continuation" | "steer" | "repair";
type AgentObservationState = "recording" | "sealed" | "partial";
type AgentObservationCompleteness = "complete" | "degraded";
type AgentTraceState = "none" | "recording" | "sealed" | "partial" | "published";
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
  agentKey: string;
  sessionName: string;
  cwd: string;
  trace: boolean;
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
  responseAtFence?: string;
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
  gaps: number;
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

export type AgentObservationTurnEvidence = {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  turn: number;
  promptKind: AgentPromptKind;
  relativePath: string;
  state: AgentObservationState;
  completeness: AgentObservationCompleteness;
  gapCount: number;
  eventCount: number;
  unknownEventCount: number;
  promptBytes: number;
  promptDigest: string;
  lastResponseBytes: number;
  lastResponseDigest: string;
  responseAtFenceBytes?: number;
  responseAtFenceDigest?: string;
  fenceEventSequence?: number;
  fencedAt?: string;
  fenceReason?: string;
  finalResponseBytes?: number;
  finalResponseDigest?: string;
  providerStatus?: "completed" | "failed" | "cancelled" | "timed_out";
  trace?: {
    state: Exclude<AgentTraceState, "none">;
    relativePath?: string;
    bytes?: number;
    digest?: string;
  };
  startedAt: string;
  finishedAt?: string;
  sealedBytes?: number;
  sealedDigest?: string;
};

type AgentTurnEvidenceSummary = Omit<AgentTurnResult["summary"], "tools"> & {
  tools: { totalToolCallCount: number };
};

export type AgentTurnEvidenceRecord =
  | {
      schemaVersion: 1;
      type: "turn_start";
      sequence: 0;
      observedAt: string;
      runId: string;
      nodeId: string;
      nodeKey: string;
      attemptId: string;
      attemptNo: number;
      turn: number;
      agentKey: string;
      sessionName: string;
      cwd: string;
      promptKind: AgentPromptKind;
      prompt: string;
      traceEnabled: boolean;
    }
  | {
      schemaVersion: 1;
      type: "fence";
      sequence: number;
      observedAt: string;
      reason: string;
      schedulerEventSequence?: number;
      schedulerCommittedAt?: string;
      responseAtFence?: string;
      responseUnavailable?: true;
    }
  | {
      schemaVersion: 1;
      type: "gap";
      sequence: number;
      observedAt: string;
      scope: "evidence" | "trace" | "semantic";
      dropped: number;
      droppedBytes: number;
      reason: string;
    }
  | {
      schemaVersion: 1;
      type: "turn_end";
      sequence: number;
      observedAt: string;
      providerStatus: "completed" | "failed" | "cancelled" | "timed_out";
      finalObservedResponse: string;
      summary: AgentTurnEvidenceSummary;
      timing: AgentTurnResult["timing"];
      failure?: AgentJsonValue;
      message?: string;
    };

export type AgentObservationInspectionProjection = {
  version: number;
  latestRelevantVersion?: number;
  turns: AgentObservationTurnEvidence[];
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

export type AgentObservationRecoveryError = {
  type: "observation-recovery-failed";
  runId: string;
  message: string;
  cause?: unknown;
};

export type AgentTracePublicationInput = {
  runId: string;
  attemptId: string;
  turn: number;
  destinationAbsolutePath: string;
  destinationRelativePath: string;
  register: (trace: {
    size: number;
    digest: string;
    relativePath: string;
  }) => Promise<void>;
};

export type AgentTracePublication = {
  size: number;
  digest: string;
  relativePath: string;
};

type TurnRow = {
  run_id: string;
  attempt_id: string;
  node_key: string;
  node_id: string;
  attempt_no: number;
  turn_no: number;
  prompt_kind: AgentPromptKind;
  relative_path: string;
  state: AgentObservationState;
  degraded: number;
  gap_count: number;
  provider_event_count: number;
  unknown_event_count: number;
  last_record_sequence: number;
  indexed_bytes: number;
  prompt_bytes: number;
  prompt_digest: string;
  last_response_bytes: number;
  last_response_digest: string;
  response_at_fence_bytes: number | null;
  response_at_fence_digest: string | null;
  fence_event_sequence: number | null;
  fenced_at: string | null;
  fence_reason: string | null;
  final_response_bytes: number | null;
  final_response_digest: string | null;
  provider_status: NonNullable<AgentObservationTurnEvidence["providerStatus"]> | null;
  current_json: string | null;
  current_bytes: number;
  current_updated_at: string | null;
  current_observation_version: number | null;
  trace_enabled: number;
  trace_state: AgentTraceState;
  trace_relative_path: string | null;
  trace_artifact_relative_path: string | null;
  trace_bytes: number | null;
  trace_digest: string | null;
  started_at: string;
  finished_at: string | null;
  sealed_bytes: number | null;
  sealed_digest: string | null;
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
  record: Extract<AgentTurnEvidenceRecord, { type: "fence" }>;
  mutation: SemanticMutation;
  fileWritten: boolean;
  offset?: number;
  pending?: Promise<void>;
};

type PreparedTurnPaths = {
  evidence: { absolutePath: string; relativePath: string };
  trace?: { absolutePath: string; relativePath: string };
};

type TraceSeal = {
  state: "none" | "sealed" | "partial";
  relativePath?: string;
  bytes?: number;
  digest?: string;
  error?: unknown;
};

type DurableSteerFence = {
  eventSequence: number;
  committedAt: string;
  reason: "operator_steered";
};

export class AgentObservationLog {
  private readonly active = new Map<string, AgentTurnWriter>();
  private readonly unavailableFences = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly layout: RuntimeLayout,
  ) {}

  async captureTurn(
    context: AgentObservationTurnContext,
    request: AgentTurnRequest,
  ): Promise<{ result: AgentTurnResult; evidence: AgentObservationTurnEvidence }> {
    const writer = new AgentTurnWriter(this, context, request.prompt);
    const key = activeKey(context.attemptId, context.turn);
    if (this.active.has(key)) throw new Error(`Agent evidence turn '${context.attemptId}:${context.turn}' is already active.`);
    this.active.set(key, writer);
    try {
      await writer.start();
      return await this.captureStartedTurn(writer, context, request);
    } finally {
      this.active.delete(key);
    }
  }

  private async captureStartedTurn(
    writer: AgentTurnWriter,
    context: AgentObservationTurnContext,
    request: AgentTurnRequest,
  ): Promise<{ result: AgentTurnResult; evidence: AgentObservationTurnEvidence }> {
    const onAbort = (): void => {
      const committedAt = new Date().toISOString();
      const fence = writer.acceptsBoundaries
        ? writer.markFallbackFenced("runtime_abort", committedAt)
        : (() => {
            const responseAtFence = writer.lastResponse;
            const input = {
              runId: context.runId,
              attemptId: context.attemptId,
              committedAt,
              reason: "runtime_abort",
              responseAtFence,
            };
            return writer.waitForSeal().then(
              () => this.markUnavailableFence(input),
              () => this.markUnavailableFence(input),
            );
          })();
      void fence.catch(() => {});
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    try {
      if (!writer.fenced && !this.startedAttemptMatches(context)) {
        await writer.markFallbackFenced("runtime_abort");
      }
      const { captureTrace: _captureTrace, ...runtimeRequest } = request;
      const result = writer.fenced
        ? cancelledBeforeProviderDispatch()
        : await (async () => {
            writer.markProviderDispatched();
            return executeAgentTurn({
              ...runtimeRequest,
              onObservation: observation => {
                writer.observe(observation);
                notifyObserver(request.onObservation, observation);
              },
            });
          })();
      try {
        const evidence = await writer.seal(result);
        return { result, evidence };
      } catch (error) {
        if (!writer.fenced) throw error;
        await writer.markPartial(error).catch(() => {});
        return {
          result,
          evidence: this.findTurn(context.runId, context.attemptId, context.turn) ?? writer.partialEvidence(),
        };
      }
    } catch (error) {
      await writer.markPartial(error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  markFenced(input: AgentObservationFenceInput): Promise<void> {
    const writer = [...this.active.values()]
      .filter(candidate => candidate.context.runId === input.runId && candidate.context.attemptId === input.attemptId)
      .sort((left, right) => right.context.turn - left.context.turn)[0];
    if (writer?.acceptsBoundaries) return writer.markFenced(input);
    if (writer) {
      const responseAtFence = writer.lastResponse;
      return writer.waitForSeal().then(
        () => this.markUnavailableFence({ ...input, responseAtFence }),
        () => this.markUnavailableFence({ ...input, responseAtFence }),
      );
    }
    return this.markUnavailableFence(input);
  }

  readInspectionProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
  }): ResultAsync<AgentObservationInspectionProjection, AgentObservationReadError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(() => this.readProjection(input)),
      cause => ({
        type: "observation-read-failed",
        runId: input.runId,
        message: `Private Agent evidence for run '${input.runId}' could not be read: ${causeMessage(cause)}.`,
        cause,
      }),
    );
  }

  recoverPartialTurns(runId: string): ResultAsync<void, AgentObservationRecoveryError> {
    return ResultAsync.fromPromise(
      this.recoverRun(runId),
      cause => ({
        type: "observation-recovery-failed",
        runId,
        message: `Private Agent evidence for run '${runId}' could not be recovered: ${causeMessage(cause)}.`,
        cause,
      }),
    );
  }

  async recoverTerminalPartialTurns(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT id AS run_id
      FROM runs
      WHERE status IN ('completed', 'failed', 'canceled')
      ORDER BY id
    `).all() as Array<{ run_id: string }>;
    for (const row of rows) await this.recoverRun(row.run_id);
  }

  async publishTrace(input: AgentTracePublicationInput): Promise<AgentTracePublication | undefined> {
    const row = this.turnRow(input.runId, input.attemptId, input.turn);
    if (!row || row.trace_enabled === 0 || row.trace_state === "none") return undefined;
    if (row.trace_state === "published") {
      if (row.trace_bytes === null || row.trace_digest === null || row.trace_artifact_relative_path === null) {
        throw new Error(`Published Agent trace '${input.attemptId}:${input.turn}' has incomplete metadata.`);
      }
      return {
        size: row.trace_bytes,
        digest: row.trace_digest,
        relativePath: row.trace_artifact_relative_path,
      };
    }
    if (row.trace_state !== "sealed" || row.trace_relative_path === null) {
      throw new Error(`Agent trace '${input.attemptId}:${input.turn}' is not sealed for publication.`);
    }
    const source = await this.verifiedEvidencePath(input.runId, row.trace_relative_path);
    const destination = await this.verifiedArtifactDestination(
      input.runId,
      input.destinationAbsolutePath,
      input.destinationRelativePath,
    );
    const metadata = await fileMetadata(source);
    const existingArtifact = this.traceArtifact(input.runId, input.destinationRelativePath);
    if (existingArtifact
      && (existingArtifact.size !== metadata.size || existingArtifact.digest !== metadata.digest)) {
      throw new Error(`Registered trace artifact '${input.destinationRelativePath}' does not match its private spool.`);
    }
    if (existingArtifact) {
      this.finalizeTracePublication(row, input.destinationRelativePath, metadata);
      await rm(source, { force: true }).catch(() => {});
      return {
        size: metadata.size,
        digest: metadata.digest,
        relativePath: input.destinationRelativePath,
      };
    }
    this.db.prepare(`
      UPDATE agent_observation_turns
      SET trace_artifact_relative_path = ?
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).run(input.destinationRelativePath, input.runId, input.attemptId, input.turn);
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      if (this.layout.platform !== "win32") await chmod(destination, 0o600);
      await input.register({
        size: metadata.size,
        digest: metadata.digest,
        relativePath: input.destinationRelativePath,
      });
    } catch (error) {
      let cleanupFailure: unknown;
      try {
        await rm(destination, { force: true });
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET trace_artifact_relative_path = NULL
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ? AND trace_state != 'published'
      `).run(input.runId, input.attemptId, input.turn);
      if (cleanupFailure !== undefined) {
        throw new AggregateError([error, cleanupFailure], "Trace publication and unregistered-copy cleanup both failed.");
      }
      throw error;
    }
    this.finalizeTracePublication(row, input.destinationRelativePath, metadata);
    await rm(source, { force: true }).catch(() => {});
    return {
      size: metadata.size,
      digest: metadata.digest,
      relativePath: input.destinationRelativePath,
    };
  }

  async beginTurn(
    writer: AgentTurnWriter,
    record: Extract<AgentTurnEvidenceRecord, { type: "turn_start" }>,
  ): Promise<void> {
    const paths = await this.prepareTurnPaths(writer.context);
    writer.attachPaths(paths);
    const evidenceLine = recordLine(record);
    try {
      await writer.openFiles(evidenceLine, traceStartLine(writer.context, record.observedAt));
    } catch (error) {
      await writer.discardStartingFiles();
      throw error;
    }
    const promptBytes = Buffer.byteLength(record.prompt);
    const promptDigest = digest(Buffer.from(record.prompt));
    const initialCurrent = writer.initialCurrent(record.observedAt);
    const currentJson = boundedCurrentJson(initialCurrent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.requireStartedAttempt(writer.context);
      const version = this.advanceObservationVersion(writer.context.runId, record.observedAt);
      this.db.prepare(`
        INSERT INTO agent_observation_attempts (
          run_id, attempt_id, latest_observation_version
        )
        VALUES (?, ?, ?)
        ON CONFLICT (run_id, attempt_id)
        DO UPDATE SET latest_observation_version = excluded.latest_observation_version
      `).run(writer.context.runId, writer.context.attemptId, version);
      this.db.prepare(`
        INSERT INTO agent_observation_turns (
          run_id, attempt_id, node_key, node_id, attempt_no, turn_no, prompt_kind,
          relative_path, state, degraded, gap_count, provider_event_count,
          unknown_event_count, last_record_sequence, indexed_bytes,
          prompt_bytes, prompt_digest, last_response_bytes, last_response_digest,
          current_json, current_bytes, current_updated_at, current_observation_version,
          trace_enabled, trace_state, trace_relative_path, started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', 0, 0, 0, 0, 0, ?,
                ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        writer.context.runId,
        writer.context.attemptId,
        writer.context.nodeKey,
        writer.context.nodeId,
        writer.context.attemptNo,
        writer.context.turn,
        writer.context.promptKind,
        paths.evidence.relativePath,
        evidenceLine.byteLength,
        promptBytes,
        promptDigest,
        digest(Buffer.alloc(0)),
        currentJson,
        Buffer.byteLength(currentJson),
        record.observedAt,
        version,
        writer.context.trace ? 1 : 0,
        writer.context.trace ? "recording" : "none",
        paths.trace?.relativePath ?? null,
        record.observedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      await writer.discardStartingFiles();
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

  async appendFence(
    writer: AgentTurnWriter,
    operation: FenceOperation,
  ): Promise<void> {
    const { record, mutation } = operation;
    const line = recordLine(record);
    const offset = operation.offset ?? writer.indexedBytes;
    if (!operation.fileWritten) {
      await writer.writeEvidence(line, true);
      operation.offset = offset;
      operation.fileWritten = true;
    }
    await writer.flushTrace(true);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, record.observedAt);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, undefined, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET last_record_sequence = ?,
            indexed_bytes = ?,
            response_at_fence_bytes = ?,
            response_at_fence_digest = ?,
            fence_event_sequence = COALESCE(fence_event_sequence, ?),
            fenced_at = COALESCE(fenced_at, ?),
            fence_reason = COALESCE(fence_reason, ?)
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        record.sequence,
        offset + line.byteLength,
        record.responseAtFence === undefined ? null : Buffer.byteLength(record.responseAtFence),
        record.responseAtFence === undefined ? null : digest(Buffer.from(record.responseAtFence)),
        record.schedulerEventSequence ?? null,
        record.schedulerCommittedAt ?? record.observedAt,
        record.reason,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.updateObservationCounts(writer);
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
      writer.indexedBytes = offset + line.byteLength;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async finishTurn(
    writer: AgentTurnWriter,
    result: AgentTurnResult,
    mutation: SemanticMutation,
  ): Promise<AgentObservationTurnEvidence> {
    const trace = await writer.sealTrace(result);
    const records: AgentTurnEvidenceRecord[] = [];
    if (trace.error !== undefined) {
      records.push({
        schemaVersion: evidenceSchemaVersion,
        type: "gap",
        sequence: writer.nextBoundarySequence(),
        observedAt: result.timing.finishedAt,
        scope: "trace",
        dropped: 1,
        droppedBytes: 0,
        reason: "trace_capture_failed",
      });
      writer.noteGap();
    }
    records.push(writer.turnEnd(result));
    const bytes = Buffer.concat(records.map(recordLine));
    const offset = writer.indexedBytes;
    await writer.writeEvidence(bytes, true);
    await writer.closeEvidence();
    const sealedPath = writer.evidencePath.absolutePath.replace(/\.partial$/, "");
    await rename(writer.evidencePath.absolutePath, sealedPath);
    if (this.layout.platform !== "win32") await chmod(sealedPath, 0o600);
    const sealed = await fileMetadata(sealedPath);
    const relativePath = writer.evidencePath.relativePath.replace(/\.partial$/, "");
    const outcome = providerOutcome(result);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, result.timing.finishedAt);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, undefined, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET relative_path = ?,
            state = 'sealed',
            degraded = ?,
            gap_count = ?,
            provider_event_count = ?,
            unknown_event_count = ?,
            last_record_sequence = ?,
            indexed_bytes = ?,
            last_response_bytes = ?,
            last_response_digest = ?,
            final_response_bytes = ?,
            final_response_digest = ?,
            provider_status = ?,
            trace_state = ?,
            trace_relative_path = ?,
            trace_bytes = ?,
            trace_digest = ?,
            finished_at = ?,
            sealed_bytes = ?,
            sealed_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        relativePath,
        writer.degraded || trace.error !== undefined ? 1 : 0,
        writer.gapCount,
        writer.providerEventCount,
        writer.unknownEventCount,
        records.at(-1)!.sequence,
        offset + bytes.byteLength,
        Buffer.byteLength(writer.lastResponse),
        digest(Buffer.from(writer.lastResponse)),
        Buffer.byteLength(result.responseText),
        digest(Buffer.from(result.responseText)),
        outcome,
        trace.state,
        trace.relativePath ?? null,
        trace.bytes ?? null,
        trace.digest ?? null,
        result.timing.finishedAt,
        sealed.size,
        sealed.digest,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
      writer.indexedBytes = offset + bytes.byteLength;
      writer.markEvidenceFinished();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const evidence = this.requireTurn(writer.context.runId, writer.context.attemptId, writer.context.turn);
    if (trace.error !== undefined && !writer.fenced) throw trace.error;
    return evidence;
  }

  async markWriterPartial(writer: AgentTurnWriter, cause: unknown): Promise<void> {
    if (writer.evidenceFinished) return;
    const at = new Date().toISOString();
    const record: Extract<AgentTurnEvidenceRecord, { type: "gap" }> = {
      schemaVersion: evidenceSchemaVersion,
      type: "gap",
      sequence: writer.nextBoundarySequence(),
      observedAt: at,
      scope: "evidence",
      dropped: 1,
      droppedBytes: 0,
      reason: "evidence_capture_failed",
    };
    writer.noteGap();
    const mutation = writer.closeForFailure(record);
    let line: Buffer;
    try {
      line = recordLine(record);
      await writer.writeEvidence(line, true);
      await writer.closeEvidence();
      await writer.markTracePartial();
    } catch (error) {
      throw new AggregateError([cause, error], "Agent execution and private-evidence persistence both failed.");
    }
    const trace = writer.traceMetadata();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(writer.context.runId, at);
      this.insertSemanticEntries(writer.context, mutation.entries, version);
      this.updateCurrent(writer, undefined, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET state = 'partial',
            degraded = 1,
            gap_count = ?,
            provider_event_count = ?,
            unknown_event_count = ?,
            last_record_sequence = ?,
            indexed_bytes = ?,
            last_response_bytes = ?,
            last_response_digest = ?,
            trace_state = ?,
            trace_bytes = ?,
            trace_digest = ?,
            finished_at = COALESCE(finished_at, ?)
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        writer.gapCount,
        writer.providerEventCount,
        writer.unknownEventCount,
        record.sequence,
        writer.indexedBytes,
        Buffer.byteLength(writer.lastResponse),
        digest(Buffer.from(writer.lastResponse)),
        trace.state,
        trace.bytes ?? null,
        trace.digest ?? null,
        at,
        writer.context.runId,
        writer.context.attemptId,
        writer.context.turn,
      );
      this.touchAttempt(writer.context.runId, writer.context.attemptId, version);
      this.trimAttemptEntries(writer.context.runId, writer.context.attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new AggregateError([cause, error], "Agent execution and partial-evidence indexing both failed.");
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

  private async persistUnavailableFence(input: AgentObservationUnavailableFenceInput): Promise<void> {
    const row = this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ? AND attempt_id = ?
      ORDER BY turn_no DESC
      LIMIT 1
    `).get(input.runId, input.attemptId) as TurnRow | undefined;
    if (!row
      || input.eventSequence !== undefined && row.fence_event_sequence === input.eventSequence
      || input.eventSequence === undefined && row.fence_reason !== null) return;
    if (input.eventSequence !== undefined && row.fence_event_sequence !== null) {
      throw new Error(`Agent evidence turn '${input.attemptId}:${row.turn_no}' already has a different durable fence.`);
    }
    const path = await this.verifiedEvidencePath(input.runId, row.relative_path);
    const info = await stat(path);
    const record: Extract<AgentTurnEvidenceRecord, { type: "fence" }> = {
      schemaVersion: evidenceSchemaVersion,
      type: "fence",
      sequence: row.last_record_sequence + 1,
      observedAt: input.committedAt,
      reason: input.reason,
      ...(input.eventSequence === undefined
        ? {}
        : {
            schedulerEventSequence: input.eventSequence,
            schedulerCommittedAt: input.committedAt,
          }),
      ...(input.responseAtFence === undefined
        ? { responseUnavailable: true }
        : { responseAtFence: input.responseAtFence }),
    };
    const line = recordLine(record);
    const handle = await open(path, "a");
    try {
      await writeFully(handle, line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sealed = row.state === "sealed" ? await fileMetadata(path) : undefined;
    const storedCurrent = parseCurrent(row.current_json);
    const recoveredEntry = storedCurrent
      ? entryFromCurrent(storedCurrent, row.last_record_sequence)
      : undefined;
    const entries = recoveredEntry ? [recoveredEntry] : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(input.runId, input.committedAt);
      this.insertSemanticEntries(rowContext(row), entries, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET fence_event_sequence = COALESCE(?, fence_event_sequence),
            fenced_at = ?,
            fence_reason = ?,
            response_at_fence_bytes = ?,
            response_at_fence_digest = ?,
            degraded = CASE WHEN ? = 1 THEN 1 ELSE degraded END,
            last_record_sequence = ?,
            indexed_bytes = ?,
            current_json = NULL,
            current_bytes = 0,
            current_updated_at = ?,
            current_observation_version = ?,
            sealed_bytes = COALESCE(?, sealed_bytes),
            sealed_digest = COALESCE(?, sealed_digest)
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        input.eventSequence ?? null,
        input.committedAt,
        input.reason,
        input.responseAtFence === undefined ? null : Buffer.byteLength(input.responseAtFence),
        input.responseAtFence === undefined ? null : digest(Buffer.from(input.responseAtFence)),
        input.responseAtFence === undefined ? 1 : 0,
        record.sequence,
        info.size + line.byteLength,
        input.committedAt,
        version,
        sealed?.size ?? null,
        sealed?.digest ?? null,
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

  private readProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
  }): AgentObservationInspectionProjection {
    const versionRow = this.db.prepare("SELECT observation_version FROM runs WHERE id = ?")
      .get(input.runId) as { observation_version: number } | undefined;
    if (!versionRow) throw new Error(`Run '${input.runId}' was not found.`);
    const turns = this.turnRows(input.runId, input.attemptIds);
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
    const eligibleEntryCount = input.entryLimit === undefined || input.attemptIds?.length === 0
      ? 0
      : this.countEntryRows(input);
    const olderEntryCount = Math.max(0, eligibleEntryCount - chosenRows.length);
    const beforeEntryRetained = input.beforeEntry === undefined
      ? undefined
      : this.hasEntryBoundary(input.runId, input.attemptIds, input.beforeEntry);
    return {
      version: versionRow.observation_version,
      ...(latestRelevantVersion === undefined ? {} : { latestRelevantVersion }),
      turns: turns.map(turnEvidence),
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

  private async recoverRun(runId: string): Promise<void> {
    const rows = this.db.prepare(`
      SELECT turns.*
      FROM agent_observation_turns AS turns
      JOIN node_attempts AS attempts
        ON attempts.run_id = turns.run_id
        AND attempts.attempt_id = turns.attempt_id
      WHERE turns.run_id = ?
        AND attempts.status IN ('completed', 'failed', 'timed_out', 'cancelled', 'superseded')
      ORDER BY turns.attempt_no, turns.turn_no
    `).all(runId) as TurnRow[];
    for (const row of rows) {
      const durableFence = this.durableSteerFence(row);
      if (row.state !== "sealed"
        || durableFence !== undefined && row.fence_event_sequence !== durableFence.eventSequence) {
        await this.recoverTurn(row, durableFence);
      }
      let current = this.turnRow(row.run_id, row.attempt_id, row.turn_no) ?? row;
      await this.reconcileTracePublication(current);
      current = this.turnRow(row.run_id, row.attempt_id, row.turn_no) ?? current;
      await this.recoverTrace(current);
      current = this.turnRow(row.run_id, row.attempt_id, row.turn_no) ?? current;
      await this.reconcileTracePublication(current);
    }
    await this.removeOrphanPartials(runId);
  }

  private async recoverTurn(
    row: TurnRow,
    durableFence = this.durableSteerFence(row),
  ): Promise<void> {
    const path = await this.verifiedEvidencePath(row.run_id, row.relative_path);
    let bytes = await readFile(path);
    if (row.indexed_bytes > bytes.byteLength) {
      throw new Error(`Evidence '${row.relative_path}' is shorter than its indexed boundary.`);
    }
    let records = parseCompleteEvidence(bytes);
    let changed = false;
    const tail = bytes.subarray(row.indexed_bytes);
    const lastNewline = tail.lastIndexOf(0x0a);
    const incompleteBytes = lastNewline === tail.byteLength - 1 ? 0 : tail.byteLength - Math.max(0, lastNewline + 1);
    if (incompleteBytes > 0) {
      const gap: Extract<AgentTurnEvidenceRecord, { type: "gap" }> = {
        schemaVersion: evidenceSchemaVersion,
        type: "gap",
        sequence: nextRecordSequence(records, row.last_record_sequence),
        observedAt: new Date().toISOString(),
        scope: "evidence",
        dropped: 1,
        droppedBytes: incompleteBytes,
        reason: "incomplete_tail_recovery",
      };
      const appended = Buffer.concat([Buffer.from("\n"), recordLine(gap)]);
      await appendSynced(path, appended);
      bytes = Buffer.concat([bytes, appended]);
      records = [...records, gap];
      changed = true;
    }
    const expectedFenceSequence = row.fence_event_sequence ?? durableFence?.eventSequence ?? null;
    const expectedFenceAt = row.fenced_at ?? durableFence?.committedAt ?? null;
    const expectedFenceReason = row.fence_reason ?? durableFence?.reason ?? null;
    const missingFence = expectedFenceReason !== null && !records.some(record =>
      record.type === "fence"
      && (expectedFenceSequence === null || record.schedulerEventSequence === expectedFenceSequence));
    if (missingFence) {
      const fence: Extract<AgentTurnEvidenceRecord, { type: "fence" }> = {
        schemaVersion: evidenceSchemaVersion,
        type: "fence",
        sequence: nextRecordSequence(records, row.last_record_sequence),
        observedAt: expectedFenceAt ?? new Date().toISOString(),
        reason: expectedFenceReason ?? "unavailable_fence_recovery",
        ...(expectedFenceSequence === null
          ? {}
          : { schedulerEventSequence: expectedFenceSequence }),
        ...(expectedFenceSequence === null || expectedFenceAt === null
          ? {}
          : { schedulerCommittedAt: expectedFenceAt }),
        responseUnavailable: true,
      };
      const appended = recordLine(fence);
      await appendSynced(path, appended);
      bytes = Buffer.concat([bytes, appended]);
      records = [...records, fence];
      changed = true;
    }
    const terminal = [...records].reverse().find(record => record.type === "turn_end");
    if (!terminal && !records.some(record =>
      record.type === "gap" && record.reason === "provider_settlement_missing_recovery")) {
      const gap: Extract<AgentTurnEvidenceRecord, { type: "gap" }> = {
        schemaVersion: evidenceSchemaVersion,
        type: "gap",
        sequence: nextRecordSequence(records, row.last_record_sequence),
        observedAt: new Date().toISOString(),
        scope: "evidence",
        dropped: 1,
        droppedBytes: 0,
        reason: "provider_settlement_missing_recovery",
      };
      const appended = recordLine(gap);
      await appendSynced(path, appended);
      bytes = Buffer.concat([bytes, appended]);
      records = [...records, gap];
      changed = true;
    }
    const finalRelative = terminal
      ? row.relative_path.replace(/\.partial$/, "")
      : row.relative_path;
    const finalPath = terminal ? path.replace(/\.partial$/, "") : path;
    if (terminal && path.endsWith(".partial")) {
      await rename(path, finalPath);
      changed = true;
    }
    const metadata = await fileMetadata(finalPath);
    const current = parseCurrent(row.current_json);
    const recoveredEntry = current
      ? entryFromCurrent(current, row.last_record_sequence)
      : undefined;
    const entries = recoveredEntry ? [recoveredEntry] : [];
    const at = terminal?.observedAt ?? new Date().toISOString();
    const gaps = records.filter(record => record.type === "gap").length;
    const fence = [...records].reverse().find(record => record.type === "fence");
    const nextState: AgentObservationState = terminal ? "sealed" : "partial";
    const unavailableFence = fence?.type === "fence" && fence.responseUnavailable === true;
    const nextDegraded = terminal && gaps === 0 && row.unknown_event_count === 0 && !unavailableFence ? 0 : 1;
    const needsMetadataUpdate = changed
      || row.relative_path !== finalRelative
      || row.state !== nextState
      || row.degraded !== nextDegraded
      || row.gap_count !== gaps
      || row.indexed_bytes !== bytes.byteLength
      || row.current_json !== null
      || row.fence_event_sequence !== (fence?.type === "fence" ? fence.schedulerEventSequence ?? null : null)
      || row.provider_status !== (terminal?.type === "turn_end" ? terminal.providerStatus : null);
    if (!needsMetadataUpdate) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(row.run_id, at);
      this.insertSemanticEntries(rowContext(row), entries, version);
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET relative_path = ?,
            state = ?,
            degraded = ?,
            gap_count = ?,
            last_record_sequence = ?,
            indexed_bytes = ?,
            response_at_fence_bytes = ?,
            response_at_fence_digest = ?,
            fence_event_sequence = COALESCE(fence_event_sequence, ?),
            fenced_at = COALESCE(fenced_at, ?),
            fence_reason = COALESCE(fence_reason, ?),
            final_response_bytes = ?,
            final_response_digest = ?,
            provider_status = ?,
            current_json = NULL,
            current_bytes = 0,
            current_updated_at = ?,
            current_observation_version = ?,
            finished_at = ?,
            sealed_bytes = ?,
            sealed_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        finalRelative,
        nextState,
        nextDegraded,
        gaps,
        records.reduce((latest, record) => Math.max(latest, record.sequence), row.last_record_sequence),
        bytes.byteLength,
        fence?.type === "fence" && fence.responseAtFence !== undefined
          ? Buffer.byteLength(fence.responseAtFence)
          : null,
        fence?.type === "fence" && fence.responseAtFence !== undefined
          ? digest(Buffer.from(fence.responseAtFence))
          : null,
        fence?.type === "fence" ? fence.schedulerEventSequence ?? null : null,
        fence?.type === "fence" ? fence.schedulerCommittedAt ?? fence.observedAt : null,
        fence?.type === "fence" ? fence.reason : null,
        terminal?.type === "turn_end" ? Buffer.byteLength(terminal.finalObservedResponse) : null,
        terminal?.type === "turn_end" ? digest(Buffer.from(terminal.finalObservedResponse)) : null,
        terminal?.type === "turn_end" ? terminal.providerStatus : null,
        at,
        version,
        terminal?.type === "turn_end" ? terminal.observedAt : row.finished_at ?? at,
        terminal ? metadata.size : null,
        terminal ? metadata.digest : null,
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

  private async recoverTrace(row: TurnRow): Promise<void> {
    if (row.trace_enabled === 0
      || row.trace_relative_path === null
      || row.trace_state === "none"
      || row.trace_state === "sealed"
      || row.trace_state === "published") return;
    const path = await this.verifiedEvidencePath(row.run_id, row.trace_relative_path);
    if (row.trace_state === "partial" && row.trace_bytes !== null) {
      const info = await stat(path);
      if (info.size === row.trace_bytes) return;
    }
    const bytes = await readFile(path);
    const records = parseCompleteJsonLines(bytes);
    const contiguous = records.every((record, index) =>
      record && typeof record === "object" && (record as { sequence?: unknown }).sequence === index);
    const terminal = records.at(-1);
    const complete = contiguous
      && terminal
      && typeof terminal === "object"
      && (terminal as { type?: unknown }).type === "turn_end";
    let finalPath = path;
    let relativePath = row.trace_relative_path;
    if (complete) {
      relativePath = relativePath.replace(/\.partial$/, "");
      if (path.endsWith(".partial")) {
        finalPath = path.replace(/\.partial$/, "");
        await rename(path, finalPath);
      }
    }
    const metadata = await fileMetadata(finalPath);
    const nextState = complete ? "sealed" : "partial";
    if (row.trace_state === nextState
      && row.trace_relative_path === relativePath
      && row.trace_bytes === metadata.size
      && row.trace_digest === metadata.digest) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(row.run_id, new Date().toISOString());
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET trace_state = ?,
            trace_relative_path = ?,
            trace_bytes = ?,
            trace_digest = ?,
            degraded = CASE WHEN ? = 'partial' THEN 1 ELSE degraded END
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        nextState,
        relativePath,
        metadata.size,
        metadata.digest,
        nextState,
        row.run_id,
        row.attempt_id,
        row.turn_no,
      );
      this.touchAttempt(row.run_id, row.attempt_id, version);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async reconcileTracePublication(row: TurnRow): Promise<void> {
    if (row.trace_relative_path === null
      || row.trace_artifact_relative_path === null
      || row.trace_bytes === null
      || row.trace_digest === null) return;
    const metadata = { size: row.trace_bytes, digest: row.trace_digest };
    if (!this.registeredTraceArtifact(row.run_id, row.trace_artifact_relative_path, metadata)) return;
    if (row.trace_state !== "published") {
      this.finalizeTracePublication(row, row.trace_artifact_relative_path, metadata);
    }
    try {
      const path = await this.verifiedEvidencePath(row.run_id, row.trace_relative_path);
      await rm(path, { force: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private registeredTraceArtifact(
    runId: string,
    relativePath: string,
    metadata: { size: number; digest: string },
  ): boolean {
    const artifact = this.traceArtifact(runId, relativePath);
    return artifact?.size === metadata.size && artifact.digest === metadata.digest;
  }

  private traceArtifact(runId: string, relativePath: string): { size: number; digest: string } | undefined {
    return this.db.prepare(`
      SELECT size, digest
      FROM artifacts
      WHERE run_id = ? AND relative_path = ?
    `).get(runId, relativePath) as { size: number; digest: string } | undefined;
  }

  private finalizeTracePublication(
    row: Pick<TurnRow, "run_id" | "attempt_id" | "turn_no" | "trace_state">,
    relativePath: string,
    metadata: { size: number; digest: string },
  ): void {
    if (row.trace_state === "published") return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = this.advanceObservationVersion(row.run_id, new Date().toISOString());
      this.db.prepare(`
        UPDATE agent_observation_turns
        SET trace_state = 'published',
            trace_artifact_relative_path = ?,
            trace_bytes = ?,
            trace_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
      `).run(
        relativePath,
        metadata.size,
        metadata.digest,
        row.run_id,
        row.attempt_id,
        row.turn_no,
      );
      this.touchAttempt(row.run_id, row.attempt_id, version);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async removeOrphanPartials(runId: string): Promise<void> {
    const runDir = await this.verifiedRunDirectory(runId);
    const evidenceRoot = join(runDir, "evidence");
    let root;
    try {
      root = await lstat(evidenceRoot);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (root.isSymbolicLink() || !root.isDirectory()) {
      throw new Error(`Evidence root '${evidenceRoot}' is not a regular directory.`);
    }
    const agentRoot = join(evidenceRoot, "agents");
    let agentRootInfo;
    try {
      agentRootInfo = await lstat(agentRoot);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (agentRootInfo.isSymbolicLink() || !agentRootInfo.isDirectory()) {
      throw new Error(`Agent evidence root '${agentRoot}' is not a regular directory.`);
    }
    const indexed = new Set(this.turnRows(runId).flatMap(row => [
      row.relative_path,
      ...(row.trace_relative_path ? [row.trace_relative_path] : []),
    ]));
    const attemptDirs = await readdir(agentRoot, { withFileTypes: true });
    for (const attemptDir of attemptDirs) {
      if (attemptDir.isSymbolicLink() || !attemptDir.isDirectory()) continue;
      const directory = join(agentRoot, attemptDir.name);
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".partial")) continue;
        const relativePath = relative(runDir, join(directory, file.name));
        if (!indexed.has(relativePath)) await rm(join(directory, file.name));
      }
    }
  }

  private async prepareTurnPaths(context: AgentObservationTurnContext): Promise<PreparedTurnPaths> {
    if (!safePathSegment(context.runId)) throw new Error(`Run id '${context.runId}' is not safe for private evidence storage.`);
    if (!safePathSegment(context.attemptId)) throw new Error(`Attempt id '${context.attemptId}' is not safe for private evidence storage.`);
    const runDir = await this.verifiedRunDirectory(context.runId);
    const evidenceRoot = join(runDir, "evidence");
    const agentsRoot = join(evidenceRoot, "agents");
    const attemptDir = join(agentsRoot, context.attemptId);
    await ensurePrivateDirectory(evidenceRoot, this.layout.platform);
    await ensurePrivateDirectory(agentsRoot, this.layout.platform);
    await ensurePrivateDirectory(attemptDir, this.layout.platform);
    const realRun = await realpath(runDir);
    const realAttempt = await realpath(attemptDir);
    if (!contained(realRun, realAttempt)) throw new Error(`Evidence directory '${attemptDir}' escapes run '${context.runId}'.`);
    const prefix = `turn-${String(context.turn).padStart(3, "0")}`;
    const evidenceName = `${prefix}.evidence.jsonl.partial`;
    const traceName = `${prefix}.trace.jsonl.partial`;
    return {
      evidence: {
        absolutePath: join(attemptDir, evidenceName),
        relativePath: join("evidence", "agents", context.attemptId, evidenceName),
      },
      ...(context.trace
        ? {
            trace: {
              absolutePath: join(attemptDir, traceName),
              relativePath: join("evidence", "agents", context.attemptId, traceName),
            },
          }
        : {}),
    };
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
          gap_count = ?,
          provider_event_count = ?,
          unknown_event_count = ?,
          last_response_bytes = ?,
          last_response_digest = ?
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).run(
      writer.degraded ? 1 : 0,
      writer.gapCount,
      writer.providerEventCount,
      writer.unknownEventCount,
      Buffer.byteLength(writer.lastResponse),
      digest(Buffer.from(writer.lastResponse)),
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

  private turnRows(runId: string, attemptIds?: readonly string[]): TurnRow[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ?
      ORDER BY attempt_no, turn_no
    `).all(runId) as TurnRow[];
    if (attemptIds === undefined) return rows;
    const selected = new Set(attemptIds);
    return rows.filter(row => selected.has(row.attempt_id));
  }

  private attemptRows(
    runId: string,
    attemptIds?: readonly string[],
  ): Map<string, AttemptObservationRow> {
    const rows = this.db.prepare(`
      SELECT attempt_id, latest_observation_version, retention_omitted_count, retention_floor_version
      FROM agent_observation_attempts
      WHERE run_id = ?
    `).all(runId) as Array<AttemptObservationRow & { attempt_id: string }>;
    const selected = attemptIds === undefined ? undefined : new Set(attemptIds);
    return new Map(rows
      .filter(row => selected === undefined || selected.has(row.attempt_id))
      .map(row => [row.attempt_id, row]));
  }

  private turnRow(runId: string, attemptId: string, turn: number): TurnRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM agent_observation_turns
      WHERE run_id = ? AND attempt_id = ? AND turn_no = ?
    `).get(runId, attemptId, turn) as TurnRow | undefined;
  }

  private findTurn(runId: string, attemptId: string, turn: number): AgentObservationTurnEvidence | undefined {
    const row = this.turnRow(runId, attemptId, turn);
    return row ? turnEvidence(row) : undefined;
  }

  private requireTurn(runId: string, attemptId: string, turn: number): AgentObservationTurnEvidence {
    const evidence = this.findTurn(runId, attemptId, turn);
    if (!evidence) throw new Error(`Agent evidence turn '${attemptId}:${turn}' was not found.`);
    return evidence;
  }

  private async verifiedEvidencePath(runId: string, relativePath: string): Promise<string> {
    if (!safePathSegment(runId)) throw new Error(`Run id '${runId}' is not safe for private evidence storage.`);
    const runDir = await this.verifiedRunDirectory(runId);
    const evidenceRoot = resolve(runDir, "evidence");
    let absolute = resolve(runDir, relativePath);
    if (isAbsolute(relativePath) || absolute === evidenceRoot || !contained(evidenceRoot, absolute)) {
      throw new Error(`Evidence path '${relativePath}' escapes run '${runId}'.`);
    }
    await requireDirectory(evidenceRoot, "Evidence root");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (!missing(error) || !relativePath.endsWith(".partial")) throw error;
      absolute = absolute.replace(/\.partial$/, "");
      info = await lstat(absolute);
    }
    const attemptDirectory = resolve(absolute, "..");
    await requireDirectory(attemptDirectory, "Agent evidence directory");
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Evidence path '${absolute}' is not a regular file.`);
    const realRun = await realpath(runDir);
    const realRoot = await realpath(evidenceRoot);
    const realAttempt = await realpath(attemptDirectory);
    const real = await realpath(absolute);
    if (resolve(realRoot, "..") !== realRun
      || !contained(realRoot, realAttempt)
      || !contained(realAttempt, real)) {
      throw new Error(`Evidence path '${absolute}' escapes its private root.`);
    }
    return absolute;
  }

  private async verifiedArtifactDestination(
    runId: string,
    absolutePath: string,
    relativePath: string,
  ): Promise<string> {
    const runDir = await this.verifiedRunDirectory(runId);
    const artifacts = resolve(runDir, "artifacts");
    const expected = resolve(runDir, relativePath);
    if (isAbsolute(relativePath)
      || expected !== resolve(absolutePath)
      || expected === artifacts
      || !contained(artifacts, expected)) {
      throw new Error(`Trace artifact path '${relativePath}' escapes run '${runId}'.`);
    }
    await ensurePrivateDirectory(artifacts, this.layout.platform);
    await ensurePrivateDirectory(dirname(expected), this.layout.platform);
    const realRun = await realpath(runDir);
    const realArtifacts = await realpath(artifacts);
    const realParent = await realpath(dirname(expected));
    if (resolve(realArtifacts, "..") !== realRun || !contained(realArtifacts, realParent)) {
      throw new Error(`Trace artifact destination '${absolutePath}' escapes its artifact root.`);
    }
    return expected;
  }

  private async verifiedRunDirectory(runId: string): Promise<string> {
    const runsRoot = resolve(this.layout.runsRoot);
    const runDir = resolve(runsRoot, runId);
    if (!safePathSegment(runId) || resolve(runDir, "..") !== runsRoot) {
      throw new Error(`Run '${runId}' escapes the Runtime runs root.`);
    }
    await requireDirectory(runsRoot, "Runtime runs root");
    await requireDirectory(runDir, "Run capsule");
    const realRunsRoot = await realpath(runsRoot);
    const realRun = await realpath(runDir);
    if (resolve(realRun, "..") !== realRunsRoot) {
      throw new Error(`Run '${runId}' resolves outside the Runtime runs root.`);
    }
    return runDir;
  }
}

export class AgentTurnWriter {
  indexedBytes = 0;
  fenced = false;
  providerEventCount = 0;
  unknownEventCount = 0;
  gapCount = 0;
  degraded = false;
  lastResponse = "";
  evidenceFinished = false;
  private paths?: PreparedTurnPaths;
  private evidenceHandle: FileHandle | undefined;
  private traceWriter?: AgentTraceSpoolWriter;
  private boundarySequence = 0;
  private sealing = false;
  private sealCompletion?: Promise<void>;
  private readonly fences = new Map<number, FenceOperation>();
  private readonly reducer: AgentObservationSemanticReducer;
  private failure: unknown;
  private boundaryPending = false;
  private deferredEntries: PendingSemanticEntry[] = [];
  private deferredCheckpoint = false;
  private terminalMutation: SemanticMutation | undefined;
  private providerDispatched = false;

  constructor(
    private readonly log: AgentObservationLog,
    readonly context: AgentObservationTurnContext,
    private readonly prompt: string,
  ) {
    this.reducer = new AgentObservationSemanticReducer(context);
  }

  get acceptsBoundaries(): boolean {
    return !this.sealing;
  }

  get evidencePath(): PreparedTurnPaths["evidence"] {
    if (!this.paths) throw new Error("Agent evidence path is not initialized.");
    return this.paths.evidence;
  }

  waitForSeal(): Promise<void> {
    return this.sealCompletion ?? Promise.resolve();
  }

  start(): Promise<void> {
    const observedAt = new Date().toISOString();
    return this.log.beginTurn(this, {
      schemaVersion: evidenceSchemaVersion,
      type: "turn_start",
      sequence: 0,
      observedAt,
      runId: this.context.runId,
      nodeId: this.context.nodeId,
      nodeKey: this.context.nodeKey,
      attemptId: this.context.attemptId,
      attemptNo: this.context.attemptNo,
      turn: this.context.turn,
      agentKey: this.context.agentKey,
      sessionName: this.context.sessionName,
      cwd: this.context.cwd,
      promptKind: this.context.promptKind,
      prompt: this.prompt,
      traceEnabled: this.context.trace,
    });
  }

  attachPaths(paths: PreparedTurnPaths): void {
    this.paths = paths;
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    return this.reducer.initialCurrent(observedAt);
  }

  async openFiles(evidenceLine: Buffer, traceLine: Buffer | undefined): Promise<void> {
    this.evidenceHandle = await open(this.evidencePath.absolutePath, "wx", 0o600);
    await writeFully(this.evidenceHandle, evidenceLine, 0);
    await this.evidenceHandle.sync();
    this.indexedBytes = evidenceLine.byteLength;
    if (this.paths?.trace && traceLine) {
      this.traceWriter = new AgentTraceSpoolWriter(this.paths.trace);
      await this.traceWriter.start(traceLine);
    }
  }

  observe(observation: AgentTurnObservation): void {
    this.lastResponse = observation.progress.responseText;
    this.providerEventCount += 1;
    if (observation.event.type === "unknown") {
      this.unknownEventCount += 1;
      this.degraded = true;
    }
    try {
      this.traceWriter?.observe(observation.event);
      const mutation = this.reducer.observe(observation, this.gapCount, this.degraded);
      if (observation.event.type === "turn_end") {
        this.terminalMutation = mutation;
        return;
      }
      if (!mutation.checkpoint && mutation.entries.length === 0) return;
      if (this.boundaryPending) {
        this.deferredEntries.push(...mutation.entries);
        this.deferredCheckpoint ||= mutation.checkpoint;
        return;
      }
      this.log.persistObservation(this, mutation);
    } catch (error) {
      this.failure ??= error;
    }
  }

  markProviderDispatched(): void {
    this.providerDispatched = true;
  }

  markFenced(input: AgentObservationFenceInput): Promise<void> {
    let operation = this.fences.get(input.eventSequence);
    if (operation?.pending) return operation.pending;
    if (!operation) {
      this.fenced = true;
      const response = this.lastResponse;
      operation = {
        record: {
          schemaVersion: evidenceSchemaVersion,
          type: "fence",
          sequence: this.nextBoundarySequence(),
          observedAt: input.committedAt,
          reason: input.reason,
          schedulerEventSequence: input.eventSequence,
          schedulerCommittedAt: input.committedAt,
          responseAtFence: response,
        },
        mutation: this.reducer.boundary(input.committedAt),
        fileWritten: false,
      };
      this.fences.set(input.eventSequence, operation);
    }
    this.boundaryPending = true;
    const pending = this.log.appendFence(this, operation).then(() => {
      this.boundaryPending = false;
      this.flushDeferred();
    }, error => {
      this.boundaryPending = false;
      delete operation!.pending;
      throw error;
    });
    operation.pending = pending;
    return pending;
  }

  markFallbackFenced(reason: string, observedAt = new Date().toISOString()): Promise<void> {
    if (this.fenced) return Promise.resolve();
    this.fenced = true;
    const response = this.lastResponse;
    const mutation = this.reducer.boundary(observedAt);
    this.boundaryPending = true;
    return this.log.appendFence(this, {
      record: {
        schemaVersion: evidenceSchemaVersion,
        type: "fence",
        sequence: this.nextBoundarySequence(),
        observedAt,
        reason,
        responseAtFence: response,
      },
      mutation,
      fileWritten: false,
    }).then(() => {
      this.boundaryPending = false;
      this.flushDeferred();
    }, error => {
      this.boundaryPending = false;
      this.failure ??= error;
      throw error;
    });
  }

  turnEnd(result: AgentTurnResult): Extract<AgentTurnEvidenceRecord, { type: "turn_end" }> {
    const failure = result.status === "failed"
      ? boundedFailure(result.failure)
      : undefined;
    return {
      schemaVersion: evidenceSchemaVersion,
      type: "turn_end",
      sequence: this.nextBoundarySequence(),
      observedAt: result.timing.finishedAt,
      providerStatus: providerOutcome(result),
      finalObservedResponse: result.responseText,
      summary: evidenceSummary(result),
      timing: result.timing,
      ...(failure === undefined ? {} : { failure }),
      ...(result.status === "cancelled"
        ? { message: utf8Head(result.message, boundedFailureEdgeBytes * 2) }
        : {}),
    };
  }

  seal(result: AgentTurnResult): Promise<AgentObservationTurnEvidence> {
    this.sealing = true;
    const sealing = (async () => {
      if (this.boundaryPending) await waitFor(() => !this.boundaryPending);
      if (this.failure !== undefined) throw this.failure;
      this.flushDeferred();
      const remainder = this.reducer.terminal(result.timing.finishedAt);
      const mutation = this.terminalMutation
        ? {
            entries: [...this.terminalMutation.entries, ...remainder.entries],
            checkpoint: true,
            current: undefined,
            observedAt: result.timing.finishedAt,
          }
        : remainder;
      return this.log.finishTurn(this, result, mutation);
    })();
    this.sealCompletion = sealing.then(() => {}, () => {});
    return sealing;
  }

  closeForFailure(record: Extract<AgentTurnEvidenceRecord, { type: "gap" }>): SemanticMutation {
    const mutation = this.reducer.gap(
      record.observedAt,
      record.sequence,
      record.dropped,
      record.reason,
    );
    return mutation;
  }

  markPartial(cause: unknown): Promise<void> {
    return this.log.markWriterPartial(this, cause);
  }

  partialEvidence(): AgentObservationTurnEvidence {
    const trace = this.traceMetadata();
    const relativePath = this.paths?.evidence.relativePath
      ?? join(
        "evidence",
        "agents",
        this.context.attemptId,
        `turn-${String(this.context.turn).padStart(3, "0")}.evidence.jsonl.partial`,
      );
    return {
      runId: this.context.runId,
      attemptId: this.context.attemptId,
      nodeKey: this.context.nodeKey,
      nodeId: this.context.nodeId,
      attemptNo: this.context.attemptNo,
      turn: this.context.turn,
      promptKind: this.context.promptKind,
      relativePath,
      state: "partial",
      completeness: "degraded",
      gapCount: this.gapCount + 1,
      eventCount: this.providerEventCount,
      unknownEventCount: this.unknownEventCount,
      promptBytes: Buffer.byteLength(this.prompt),
      promptDigest: digest(Buffer.from(this.prompt)),
      lastResponseBytes: Buffer.byteLength(this.lastResponse),
      lastResponseDigest: digest(Buffer.from(this.lastResponse)),
      ...(trace.state === "none"
        ? {}
        : {
            trace: {
              state: trace.state,
              ...(trace.relativePath ? { relativePath: trace.relativePath } : {}),
              ...(trace.bytes === undefined ? {} : { bytes: trace.bytes }),
              ...(trace.digest === undefined ? {} : { digest: trace.digest }),
            },
          }),
      startedAt: new Date().toISOString(),
    };
  }

  async writeEvidence(bytes: Buffer, sync: boolean): Promise<void> {
    if (!this.evidenceHandle) throw new Error("Private evidence file is not open.");
    await writeFully(this.evidenceHandle, bytes, this.indexedBytes);
    if (sync) await this.evidenceHandle.sync();
    this.indexedBytes += bytes.byteLength;
  }

  flushTrace(sync: boolean): Promise<void> {
    return this.traceWriter?.flush(sync) ?? Promise.resolve();
  }

  sealTrace(result: AgentTurnResult): Promise<TraceSeal> {
    if (!this.traceWriter) return Promise.resolve({ state: "none" });
    if (!this.providerDispatched) this.traceWriter.endUndispatchedTurn(result);
    return this.traceWriter.seal();
  }

  async markTracePartial(): Promise<void> {
    await this.traceWriter?.markPartial();
  }

  traceMetadata(): {
    state: AgentTraceState;
    relativePath?: string;
    bytes?: number;
    digest?: string;
  } {
    if (!this.traceWriter) return { state: "none" };
    return this.traceWriter.metadata();
  }

  async closeEvidence(): Promise<void> {
    if (!this.evidenceHandle) return;
    const handle = this.evidenceHandle;
    this.evidenceHandle = undefined;
    await handle.close();
  }

  async discardStartingFiles(): Promise<void> {
    await this.closeEvidence().catch(() => {});
    await this.traceWriter?.discard().catch(() => {});
    if (this.paths) {
      await Promise.all([
        rm(this.paths.evidence.absolutePath, { force: true }),
        ...(this.paths.trace ? [rm(this.paths.trace.absolutePath, { force: true })] : []),
      ]);
    }
  }

  nextBoundarySequence(): number {
    this.boundarySequence += 1;
    return this.boundarySequence;
  }

  noteGap(): void {
    this.gapCount += 1;
    this.degraded = true;
  }

  markEvidenceFinished(): void {
    this.evidenceFinished = true;
  }

  private flushDeferred(): void {
    if (!this.deferredCheckpoint && this.deferredEntries.length === 0) return;
    const mutation = this.reducer.checkpoint(
      this.deferredEntries,
      this.gapCount,
      this.degraded,
    );
    this.deferredEntries = [];
    this.deferredCheckpoint = false;
    this.log.persistObservation(this, mutation);
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

  constructor(private readonly contextIdentity: AgentObservationTurnContext) {
    this.updatedAt = new Date().toISOString();
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    this.updatedAt = observedAt;
    this.lastCheckpointAt = Date.parse(observedAt);
    return this.current(0, false);
  }

  observe(
    observation: AgentTurnObservation,
    gaps: number,
    degraded: boolean,
  ): SemanticMutation {
    const { event } = observation;
    if (event.type === "usage") {
      return {
        entries: [],
        checkpoint: false,
        current: undefined,
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
      || textBytes - this.lastCheckpointTextBytes >= responseCheckpointBytes
      || Number.isFinite(now) && now - this.lastCheckpointAt >= checkpointIntervalMs;
    if (checkpoint) {
      this.lastCheckpointAt = Number.isFinite(now) ? now : this.lastCheckpointAt;
      this.lastCheckpointTextBytes = textBytes;
    }
    return {
      entries,
      checkpoint,
      current: event.type === "turn_end" ? undefined : this.current(gaps, degraded),
      observedAt: event.observedAt,
    };
  }

  boundary(at: string): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    this.fenced = true;
    return { entries, checkpoint: true, current: undefined, observedAt: at };
  }

  terminal(at: string): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    return { entries, checkpoint: true, current: undefined, observedAt: at };
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
    gaps: number,
    degraded: boolean,
  ): SemanticMutation {
    return {
      entries,
      checkpoint: true,
      current: this.current(gaps, degraded),
      observedAt: this.updatedAt,
    };
  }

  private current(gaps: number, degraded: boolean): AgentObservationCurrent {
    const active = [...this.tools.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const selected = active.slice(-2).map(({ sourceSequence: _sourceSequence, ...tool }) => tool);
    const phase = this.phase();
    const segment = this.segment;
    return {
      attemptId: this.contextIdentity.attemptId,
      turn: this.contextIdentity.turn,
      promptKind: this.contextIdentity.promptKind,
      phase,
      updatedAt: this.updatedAt,
      ...(this.fenced ? { postFence: true } : {}),
      ...(segment?.channel === "response" && segment.text
        ? { response: semanticExcerpt(segment, currentResponseBytes) }
        : {}),
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
      state: "recording",
      completeness: degraded ? "degraded" : "complete",
      gaps,
    };
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

class AgentTraceSpoolWriter {
  private fd: number | undefined;
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private writtenBytes = 0;
  private failure: unknown;
  private terminalSeen = false;
  private expectedEventSequence = 0;
  private state: "recording" | "sealed" | "partial" = "recording";
  private finalRelativePath: string;
  private size?: number;
  private fileDigest?: string;

  constructor(private readonly path: { absolutePath: string; relativePath: string }) {
    this.finalRelativePath = path.relativePath;
  }

  async start(header: Buffer): Promise<void> {
    this.fd = openSync(this.path.absolutePath, "wx", 0o600);
    writeFullySync(this.fd, header, 0);
    fsyncSync(this.fd);
    this.writtenBytes = header.byteLength;
  }

  observe(event: AgentTraceEvent): void {
    if (this.failure !== undefined) return;
    if (this.terminalSeen) {
      this.failure = new Error("Agent trace received an event after turn_end.");
      return;
    }
    if (event.sequence !== this.expectedEventSequence) {
      this.failure = new Error(`Agent trace event sequence ${event.sequence} did not match ${this.expectedEventSequence}.`);
      return;
    }
    this.expectedEventSequence += 1;
    if (event.type === "turn_end") this.terminalSeen = true;
    const line = Buffer.from(`${JSON.stringify({ ...event, sequence: event.sequence + 1 })}\n`);
    this.buffer.push(line);
    this.bufferedBytes += line.byteLength;
    if (this.bufferedBytes >= traceBufferBytes) {
      try {
        this.flushNow(false);
      } catch (error) {
        this.failure ??= error;
      }
    }
  }

  endUndispatchedTurn(result: AgentTurnResult): void {
    if (this.terminalSeen) return;
    this.observe({
      schemaVersion: 1,
      sequence: this.expectedEventSequence,
      observedAt: result.timing.finishedAt,
      elapsedMs: result.timing.elapsedMs,
      type: "turn_end",
      status: providerOutcome(result),
      ...(result.status === "failed" ? { failure: boundedFailure(result.failure) } : {}),
      ...(result.status === "cancelled" ? { message: result.message } : {}),
    });
  }

  flush(sync: boolean): Promise<void> {
    try {
      this.flushNow(sync);
      return Promise.resolve();
    } catch (error) {
      this.failure ??= error;
      return Promise.reject(error);
    }
  }

  private flushNow(sync: boolean): void {
    const chunks = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    if (this.failure !== undefined) throw this.failure;
    if (this.fd === undefined) throw new Error("Agent trace spool is not open.");
    if (chunks.length > 0) {
      const bytes = Buffer.concat(chunks);
      writeFullySync(this.fd, bytes, this.writtenBytes);
      this.writtenBytes += bytes.byteLength;
    }
    if (sync) fsyncSync(this.fd);
  }

  async seal(): Promise<TraceSeal> {
    try {
      await this.flush(true);
      if (this.failure !== undefined) throw this.failure;
      if (!this.terminalSeen) throw new Error("Agent trace ended without a terminal turn_end observation.");
      await this.close();
      const sealedPath = this.path.absolutePath.replace(/\.partial$/, "");
      await rename(this.path.absolutePath, sealedPath);
      const metadata = await fileMetadata(sealedPath);
      this.state = "sealed";
      this.finalRelativePath = this.path.relativePath.replace(/\.partial$/, "");
      this.size = metadata.size;
      this.fileDigest = metadata.digest;
      return {
        state: "sealed",
        relativePath: this.finalRelativePath,
        bytes: metadata.size,
        digest: metadata.digest,
      };
    } catch (error) {
      this.failure ??= error;
      await this.markPartial();
      const metadata = this.metadata();
      return {
        state: "partial",
        relativePath: metadata.relativePath ?? this.path.relativePath,
        ...(metadata.bytes === undefined ? {} : { bytes: metadata.bytes }),
        ...(metadata.digest === undefined ? {} : { digest: metadata.digest }),
        error,
      };
    }
  }

  async markPartial(): Promise<void> {
    await this.flush(false).catch(() => {});
    await this.close().catch(() => {});
    this.state = "partial";
    this.finalRelativePath = this.path.relativePath;
    try {
      const metadata = await fileMetadata(this.path.absolutePath);
      this.size = metadata.size;
      this.fileDigest = metadata.digest;
    } catch {}
  }

  metadata(): {
    state: "recording" | "sealed" | "partial";
    relativePath: string;
    bytes?: number;
    digest?: string;
  } {
    return {
      state: this.state,
      relativePath: this.finalRelativePath,
      ...(this.size === undefined ? {} : { bytes: this.size }),
      ...(this.fileDigest === undefined ? {} : { digest: this.fileDigest }),
    };
  }

  async discard(): Promise<void> {
    await this.close().catch(() => {});
    await rm(this.path.absolutePath, { force: true });
  }

  private async close(): Promise<void> {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    closeSync(fd);
  }
}

function traceStartLine(context: AgentObservationTurnContext, observedAt: string): Buffer | undefined {
  if (!context.trace) return undefined;
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    sequence: 0,
    observedAt,
    elapsedMs: 0,
    type: "turn_start",
    runId: context.runId,
    nodeId: context.nodeId,
    nodeKey: context.nodeKey,
    attemptNo: context.attemptNo,
    turn: context.turn,
    agentKey: context.agentKey,
    sessionName: context.sessionName,
    cwd: context.cwd,
  })}\n`);
}

function mergeTool(
  previous: (AgentObservationToolActivity & { sourceSequence: number }) | undefined,
  event: Extract<AgentTraceEvent, { type: "tool" }>,
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

function evidenceSummary(result: AgentTurnResult): AgentTurnEvidenceSummary {
  const summary = result.summary;
  return {
    eventCount: summary.eventCount,
    availability: summary.availability,
    ...(summary.stopReason === undefined ? {} : { stopReason: summary.stopReason }),
    ...(summary.context === undefined ? {} : { context: summary.context }),
    ...(summary.tokenUsage === undefined ? {} : { tokenUsage: summary.tokenUsage }),
    tools: { totalToolCallCount: summary.tools.totalToolCallCount },
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.acpxRecordId === undefined ? {} : { acpxRecordId: summary.acpxRecordId }),
  };
}

function boundedFailure(value: unknown): AgentJsonValue {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes <= boundedFailureEdgeBytes * 2) return JSON.parse(json) as AgentJsonValue;
  return {
    truncated: true,
    originalBytes: bytes,
    head: utf8Head(json, boundedFailureEdgeBytes),
    tail: utf8Tail(json, boundedFailureEdgeBytes),
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

function utf8Head(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    bytes += next;
    end += character.length;
  }
  return value.slice(0, end);
}

function utf8Tail(value: string, maxBytes: number): string {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const code = value.charCodeAt(characterStart);
    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) characterStart -= 1;
    const character = value.slice(characterStart, start);
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start = characterStart;
  }
  return value.slice(start);
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
    responseText: "",
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

function providerOutcome(result: AgentTurnResult): NonNullable<AgentObservationTurnEvidence["providerStatus"]> {
  return result.status === "failed" && result.failure.kind === "timeout" ? "timed_out" : result.status;
}

function recordLine(record: AgentTurnEvidenceRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`);
}

function parseCompleteEvidence(bytes: Buffer): AgentTurnEvidenceRecord[] {
  return parseCompleteJsonLines(bytes).flatMap(value => {
    if (!value
      || typeof value !== "object"
      || (value as { schemaVersion?: unknown }).schemaVersion !== evidenceSchemaVersion
      || typeof (value as { sequence?: unknown }).sequence !== "number") return [];
    return [value as AgentTurnEvidenceRecord];
  });
}

function parseCompleteJsonLines(bytes: Buffer): unknown[] {
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  return bytes.subarray(0, lastNewline + 1).toString("utf8").split("\n").flatMap(line => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

function nextRecordSequence(records: AgentTurnEvidenceRecord[], indexedSequence: number): number {
  return records.reduce((latest, record) => Math.max(latest, record.sequence), indexedSequence) + 1;
}

function turnEvidence(row: TurnRow): AgentObservationTurnEvidence {
  const traceRelativePath = row.trace_state === "published" ? undefined : row.trace_relative_path ?? undefined;
  const trace = row.trace_state === "none"
    ? undefined
    : {
        state: row.trace_state,
        ...(traceRelativePath ? { relativePath: traceRelativePath } : {}),
        ...(row.trace_bytes === null ? {} : { bytes: row.trace_bytes }),
        ...(row.trace_digest === null ? {} : { digest: row.trace_digest }),
      };
  return {
    runId: row.run_id,
    attemptId: row.attempt_id,
    nodeKey: row.node_key,
    nodeId: row.node_id,
    attemptNo: row.attempt_no,
    turn: row.turn_no,
    promptKind: row.prompt_kind,
    relativePath: row.relative_path,
    state: row.state,
    completeness: row.degraded === 0 ? "complete" : "degraded",
    gapCount: row.gap_count,
    eventCount: row.provider_event_count,
    unknownEventCount: row.unknown_event_count,
    promptBytes: row.prompt_bytes,
    promptDigest: row.prompt_digest,
    lastResponseBytes: row.last_response_bytes,
    lastResponseDigest: row.last_response_digest,
    ...(row.response_at_fence_bytes === null ? {} : { responseAtFenceBytes: row.response_at_fence_bytes }),
    ...(row.response_at_fence_digest === null ? {} : { responseAtFenceDigest: row.response_at_fence_digest }),
    ...(row.fence_event_sequence === null ? {} : { fenceEventSequence: row.fence_event_sequence }),
    ...(row.fenced_at === null ? {} : { fencedAt: row.fenced_at }),
    ...(row.fence_reason === null ? {} : { fenceReason: row.fence_reason }),
    ...(row.final_response_bytes === null ? {} : { finalResponseBytes: row.final_response_bytes }),
    ...(row.final_response_digest === null ? {} : { finalResponseDigest: row.final_response_digest }),
    ...(row.provider_status === null ? {} : { providerStatus: row.provider_status }),
    ...(trace ? { trace } : {}),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.sealed_bytes === null ? {} : { sealedBytes: row.sealed_bytes }),
    ...(row.sealed_digest === null ? {} : { sealedDigest: row.sealed_digest }),
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fileMetadata(path: string): Promise<{ size: number; digest: string }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const info = await stat(path);
  return { size: info.size, digest: `sha256:${hash.digest("hex")}` };
}

async function writeFully(handle: FileHandle, bytes: Buffer, position?: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position === undefined ? null : position + offset,
    );
    if (written.bytesWritten === 0) throw new Error("Private evidence write made no progress.");
    offset += written.bytesWritten;
  }
}

function writeFullySync(fd: number, bytes: Buffer, position: number): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, position + offset);
    if (written === 0) throw new Error("Agent trace write made no progress.");
    offset += written;
  }
}

async function appendSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "a");
  try {
    await writeFully(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function activeKey(attemptId: string, turn: number): string {
  return `${attemptId}\0${turn}`;
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

function safePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

async function ensurePrivateDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!exists(error)) throw error;
  }
  await requireDirectory(path, "Private Runtime directory");
  if (platform !== "win32") await chmod(path, 0o700);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} '${path}' is not a regular directory.`);
}

function contained(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function missing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function exists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
}
