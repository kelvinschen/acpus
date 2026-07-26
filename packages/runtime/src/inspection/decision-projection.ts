import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type {
  AgentObservationInspectionProjection,
} from "../observations/log.js";
import type { CommittedRuntimeEventRow } from "../hooks/events.js";
import type {
  RunDetails,
  RunDynamicAttempt,
  RunNodeProgress,
} from "../store/store.js";
import {
  normalizeInspectionStatus,
  semanticChanges,
} from "./projection.js";
import { inspectionRevision, timelinePageCursor } from "./revision.js";
import type {
  AgentAttemptEvidenceCapsule,
  AgentCurrentActivity,
  RunInspectionAction,
  RunInspectionAttention,
  RunInspectionCurrentActivity,
  RunInspectionCursor,
  RunInspectionExcerpt,
  RunInspectionPulse,
  RunInspectionQuery,
  RunInspectionSubject,
  RunInspectionTargetDetailsDocument,
  RunInspectionTargetState,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
  RunInspectionTimelineEntry,
  RunInspectionToolActivity,
  RunInspectionVisibility,
} from "./types.js";

const summaryHeadlineCharacters = 240;
const attentionCharacters = 160;
const targetSummaryBytes = 4 * 1024;
const targetEvidenceSummaryBytes = 6 * 1024;
const timelineDefaultLimit = 12;
const timelineMaximumLimit = 50;
const timelinePageBodyBytes = 8 * 1024;
const timelineEntryBytes = 512;
const currentResponseBytes = 1536;
const currentIntentBytes = 768;
const currentToolBytes = 768;
const toolNameCharacters = 160;
const toolStatusCharacters = 64;
const toolCallIdBytes = 128;
const terminalToolStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);

export function projectTargetSummary(input: {
  run: RunDetails;
  details: RunInspectionTargetDetailsDocument;
  cursor: RunInspectionCursor;
  query: Extract<RunInspectionQuery, { mode: "target" }>;
  observations?: AgentObservationInspectionProjection;
  runDir?: string;
}): RunInspectionTargetSummaryDocument {
  const aggregate = staticAggregate(input.details);
  const subject = inspectionSubject(input.details);
  const state = inspectionTargetState(input.details);
  const progress = aggregate ? undefined : selectedProgress(input.run, input.details);
  const pulse = aggregate ? undefined : targetPulse(input.details, progress, input.observations);
  const attention = targetAttention(state, input.details);
  const visibility = input.observations
    ? inspectionVisibility(input.details, input.observations)
    : undefined;
  const evidence = input.details.target.kind === "attempt" && input.observations && input.runDir
    ? evidenceCapsule(input.details, input.observations, input.runDir)
    : undefined;
  const document: RunInspectionTargetSummaryDocument = {
    schemaVersion: 2,
    kind: "target",
    revision: inspectionRevision({
      runId: input.run.id,
      query: input.query,
      resolvedTarget: resolvedTargetIdentity(input.details),
      cursor: input.cursor,
    }),
    run: { id: input.run.id, status: input.run.status, updatedAt: input.run.updatedAt },
    subject,
    state,
    ...(pulse ? { pulse } : {}),
    ...(attention ? { attention } : {}),
    ...(visibility ? { visibility } : {}),
    availableActions: aggregate ? [] : targetActions(input.details, state),
    ...(input.details.summary.counts
      ? { occurrence: { total: input.details.summary.counts.total, counts: input.details.summary.counts } }
      : {}),
    ...(evidence ? { evidence } : {}),
  };
  return boundedTargetSummary(document);
}

function boundedTargetSummary(
  document: RunInspectionTargetSummaryDocument,
): RunInspectionTargetSummaryDocument {
  const budget = document.evidence ? targetEvidenceSummaryBytes : targetSummaryBytes;
  if (Buffer.byteLength(JSON.stringify(document)) <= budget) return document;
  for (const bytes of [512, 128]) {
    const bounded = boundTargetSummaryStrings(document, bytes);
    if (Buffer.byteLength(JSON.stringify(bounded)) <= budget) return bounded;
  }
  const bounded = boundTargetSummaryStrings(document, 64);
  const { occurrence: _occurrence, ...withoutOccurrence } = bounded;
  const pulse = bounded.pulse
    ? (({ headline: _headline, ...value }) => value)(bounded.pulse)
    : undefined;
  return {
    ...withoutOccurrence,
    ...(pulse ? { pulse } : {}),
    ...(bounded.evidence
      ? {
          evidence: {
            ...bounded.evidence,
            omittedTurns: bounded.evidence.turnCount,
            records: [],
          },
        }
      : {}),
  };
}

function boundTargetSummaryStrings(
  document: RunInspectionTargetSummaryDocument,
  bytes: number,
): RunInspectionTargetSummaryDocument {
  return {
    ...document,
    subject: {
      ...document.subject,
      id: boundedString(document.subject.id, bytes),
      label: boundedString(document.subject.label, bytes),
      kind: boundedString(document.subject.kind, bytes),
      ...(document.subject.nodeId ? { nodeId: boundedString(document.subject.nodeId, bytes) } : {}),
      ...(document.subject.nodeKey ? { nodeKey: boundedString(document.subject.nodeKey, bytes) } : {}),
      ...(document.subject.attemptId ? { attemptId: boundedString(document.subject.attemptId, bytes) } : {}),
    },
    state: {
      ...document.state,
      ...(document.state.reason ? { reason: boundedString(document.state.reason, bytes) } : {}),
    },
    ...(document.pulse?.headline
      ? { pulse: { ...document.pulse, headline: boundedString(document.pulse.headline, bytes) } }
      : {}),
    ...(document.attention
      ? { attention: { ...document.attention, summary: boundedString(document.attention.summary, bytes) } }
      : {}),
    availableActions: document.availableActions.map(action => boundSummaryAction(action, bytes)),
    ...(document.evidence
      ? {
          evidence: {
            ...document.evidence,
            directory: boundedString(document.evidence.directory, bytes),
            ...(document.evidence.dispositionReason
              ? { dispositionReason: boundedString(document.evidence.dispositionReason, bytes) }
              : {}),
            records: document.evidence.records.map(record => ({
              ...record,
              file: boundedString(record.file, bytes),
              prompt: {
                ...record.prompt,
                digest: boundedString(record.prompt.digest, bytes),
              },
              ...(record.trace
                ? {
                    trace: {
                      ...record.trace,
                      ...(record.trace.file ? { file: boundedString(record.trace.file, bytes) } : {}),
                      ...(record.trace.digest ? { digest: boundedString(record.trace.digest, bytes) } : {}),
                    },
                  }
                : {}),
            })),
          },
        }
      : {}),
  };
}

function boundSummaryAction(action: RunInspectionAction, bytes: number): RunInspectionAction {
  if (action.kind === "signal") {
    return {
      ...action,
      target: boundedString(action.target, bytes),
      ...(action.schemaSummary ? { schemaSummary: boundedString(action.schemaSummary, bytes) } : {}),
    };
  }
  return action.target === undefined
    ? action
    : { ...action, target: boundedString(action.target, bytes) };
}

function boundedString(value: string, bytes: number): string {
  return excerpt(value, bytes, "head").text;
}

export function projectTimeline(input: {
  run: RunDetails;
  details: RunInspectionTargetDetailsDocument;
  cursor: RunInspectionCursor;
  query: Extract<RunInspectionQuery, { mode: "timeline" }>;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
  before?: { at: string; id: string; ordinal: number };
}): RunInspectionTimelineDocument {
  const subject = inspectionSubject(input.details);
  const state = inspectionTargetState(input.details);
  const attempt = selectedAttempt(input.details);
  const current = currentActivity(input.details, input.run, input.observations, attempt);
  const allowedAttemptIds = new Set(timelineAttemptIds(input.details));
  const observationEntries = observationTimelineEntries(input.observations, input.details, allowedAttemptIds);
  const eventEntries = schedulerTimelineEntries(input.events, input.details, input.run, input.observations);
  const entries = [...observationEntries, ...eventEntries].sort(compareTimelineEntries);
  const recent = timelinePage({
    entries,
    limit: input.query.page?.limit ?? timelineDefaultLimit,
    ...(input.before ? { before: input.before } : {}),
    runId: input.run.id,
    target: resolvedTargetIdentity(input.details),
    hasOlderSemanticEntries: input.observations.hasOlderEntries,
    olderSemanticEntryCount: input.observations.olderEntryCount,
    semanticBoundaryById: new Map(input.observations.entries.map(entry =>
      [entry.id, {
        observationVersion: entry.observationVersion,
        sourceSequence: entry.sourceSequence,
        id: entry.id,
      }] as const)),
    retentionOmittedBefore: input.observations.retentionOmittedBefore,
  });
  const visibility = inspectionVisibility(input.details, input.observations);
  return {
    schemaVersion: 2,
    kind: "timeline",
    revision: inspectionRevision({
      runId: input.run.id,
      query: input.query,
      resolvedTarget: resolvedTargetIdentity(input.details),
      cursor: input.cursor,
    }),
    run: { id: input.run.id, status: input.run.status, updatedAt: input.run.updatedAt },
    subject,
    state,
    ...(visibility ? { visibility } : {}),
    ...(current ? { current } : {}),
    recent,
  };
}

export function timelineEntriesAfter(input: {
  run: RunDetails;
  details: RunInspectionTargetDetailsDocument;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
  afterObservationVersion: number;
}): RunInspectionTimelineEntry[] {
  const allowedAttemptIds = new Set(timelineAttemptIds(input.details));
  const newObservationEntries = observationTimelineEntries(
    input.observations,
    input.details,
    allowedAttemptIds,
    input.afterObservationVersion,
  );
  return [
    ...newObservationEntries,
    ...schedulerTimelineEntries(input.events, input.details, input.run, input.observations),
  ].sort(compareTimelineEntries);
}

export function timelineHasRelevantEvents(input: {
  run: RunDetails;
  details: RunInspectionTargetDetailsDocument;
  events: readonly CommittedRuntimeEventRow[];
}): boolean {
  return schedulerTimelineEntries(input.events, input.details, input.run).length > 0;
}

export function resolvedTargetIdentity(details: RunInspectionTargetDetailsDocument): string {
  if (details.target.kind === "static-node" && !staticAggregate(details)) {
    if (details.summary.nodeKey) return `dynamic-node:${details.summary.nodeKey}`;
    if (details.summary.frameKey) return `frame:${details.summary.frameKey}`;
  }
  return `${details.target.kind}:${details.target.id}`;
}

export function timelineAttemptIds(details: RunInspectionTargetDetailsDocument): string[] {
  if (details.target.kind === "attempt") return [details.target.id];
  return [...new Set(details.attempts.map(attempt => attempt.attemptId))].sort();
}

export function targetAttemptId(details: RunInspectionTargetDetailsDocument): string | undefined {
  return selectedAttempt(details)?.attemptId;
}

export function ambiguousTimelineCandidates(details: RunInspectionTargetDetailsDocument): string[] {
  if (details.target.kind !== "static-node" || details.summary.counts?.total === undefined || details.summary.counts.total <= 1) return [];
  return [...new Set([
    ...details.instances.map(instance => instance.nodeKey),
    ...details.frames.flatMap(frame => frame.nodeKey ? [frame.nodeKey] : []),
  ])].sort();
}

function inspectionSubject(details: RunInspectionTargetDetailsDocument): RunInspectionSubject {
  const aggregate = staticAggregate(details);
  const attempt = aggregate ? undefined : selectedAttempt(details);
  const item = attempt
    ? details.items.find(candidate => candidate.attemptId === attempt.attemptId)
    : details.items.find(candidate => candidate.nodeKey === details.summary.nodeKey || candidate.frameKey === details.summary.frameKey)
      ?? details.items[0];
  const nodeId = details.staticNode?.nodeId ?? attempt?.nodeId ?? item?.nodeId;
  const nodeKey = aggregate ? undefined : attempt?.nodeKey ?? details.summary.nodeKey;
  return {
    targetKind: details.target.kind,
    id: details.target.id,
    label: excerpt(item?.label ?? nodeId ?? details.target.id, 512, "head").text,
    kind: excerpt(details.staticNode?.kind ?? item?.kind ?? "node", 128, "head").text,
    ...(nodeId && nodeId !== details.target.id ? { nodeId } : {}),
    ...(nodeKey && nodeKey !== details.target.id ? { nodeKey } : {}),
    ...(attempt ? { attemptId: attempt.attemptId, attemptNo: attempt.attemptNo } : {}),
  };
}

function inspectionTargetState(details: RunInspectionTargetDetailsDocument): RunInspectionTargetState {
  const aggregate = staticAggregate(details);
  const attempt = aggregate ? undefined : selectedAttempt(details);
  const instance = attempt
    ? details.instances.find(candidate => candidate.nodeKey === attempt.nodeKey)
    : aggregate ? undefined : details.instances.find(candidate => candidate.nodeKey === details.summary.nodeKey) ?? details.instances[0];
  const frame = aggregate ? undefined : details.frames.find(candidate => candidate.frameKey === details.summary.frameKey) ?? details.frames[0];
  const startedAt = attempt?.startedAt ?? frame?.createdAt ?? instance?.createdAt;
  const finishedAt = attempt?.finishedAt
    ?? (attempt ? undefined : frame && terminalStatus(frame.status) ? frame.updatedAt : instance && terminalStatus(instance.status) ? instance.updatedAt : undefined);
  const reason = attempt?.cancelReason ?? attempt?.terminalReason ?? instance?.statusReason ?? frame?.terminalReason;
  return {
    status: normalizeInspectionStatus(details.summary.nodeStatus ?? attempt?.status ?? instance?.status ?? frame?.status ?? "not_started"),
    ...(reason ? { reason: visibleSummary(reason, summaryHeadlineCharacters) } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(attempt?.deadlineAt ? { deadlineAt: attempt.deadlineAt } : {}),
    ...(startedAt && finishedAt ? { durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) } : {}),
  };
}

function selectedAttempt(details: RunInspectionTargetDetailsDocument): RunDynamicAttempt | undefined {
  if (details.target.kind === "attempt") {
    return details.attempts.find(attempt => attempt.attemptId === details.target.id);
  }
  return [...details.attempts].sort((left, right) =>
    right.attemptNo - left.attemptNo || right.startedAt.localeCompare(left.startedAt))[0];
}

function staticAggregate(details: RunInspectionTargetDetailsDocument): boolean {
  return details.target.kind === "static-node" && (details.summary.counts?.total ?? 0) > 1;
}

function selectedProgress(run: RunDetails, details: RunInspectionTargetDetailsDocument): RunNodeProgress | undefined {
  const attempt = selectedAttempt(details);
  return [...(run.dynamic?.progress ?? [])]
    .filter(progress => attempt
      ? progress.attemptId === attempt.attemptId
      : details.instances.some(instance => instance.nodeKey === progress.nodeKey)
        || details.target.kind === "static-node" && progress.nodeId === details.target.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function targetPulse(
  details: RunInspectionTargetDetailsDocument,
  progress: RunNodeProgress | undefined,
  observations: AgentObservationInspectionProjection | undefined,
): RunInspectionPulse | undefined {
  const state = inspectionTargetState(details);
  const attemptId = selectedAttempt(details)?.attemptId;
  const latestTurn = observations?.turns
    .filter(turn => turn.attemptId === attemptId)
    .sort((left, right) => left.turn - right.turn)
    .at(-1);
  const projected = observations?.currents
    .filter(current => current.attemptId === attemptId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  const terminal = terminalInspectionStatus(state.status);
  const projectedCurrent = !terminal ? projected : undefined;
  const projectedTool = projectedCurrent?.tools?.active.at(-1);
  const tools = progressTools(progress);
  const activeTool = terminal
    ? undefined
    : tools.calls.filter(call => !terminalToolStatuses.has(string(call.status) ?? "")).at(-1);
  const intent = terminal ? undefined : progressIntent(progress);
  const response = terminal ? undefined : progress?.output?.tail;
  const settledActivity = terminal
    ? observations?.entries
      .filter(entry => entry.kind === "activity"
        && entry.attemptId === attemptId
        && (entry.channel === "response" || entry.channel === "reported-thought" || entry.channel === "plan"))
      .sort((left, right) => left.at.localeCompare(right.at))
      .at(-1)
    : undefined;
  let phase: RunInspectionPulse["phase"] = "starting";
  if (terminal) phase = "settled";
  else if (projectedCurrent) phase = publicAgentPhase(projectedCurrent.phase);
  else if (activeTool) phase = "tool";
  else if (intent?.kind === "plan") phase = "planning";
  else if (intent) phase = "reported-thought";
  else if (latestTurn?.promptKind === "repair") phase = "output-repair";
  else if (response) phase = "responding";

  let headline: string | undefined;
  if (settledActivity?.kind === "activity") {
    headline = visibleSummary(settledActivity.summary.text, summaryHeadlineCharacters);
  } else if (projectedTool) {
    headline = visibleSummary(
      `${projectedTool.name}${projectedTool.status ? ` ${projectedTool.status}` : ""}`,
      summaryHeadlineCharacters,
    );
  } else if (projectedCurrent?.intent) {
    headline = visibleSummary(projectedCurrent.intent.excerpt.text, summaryHeadlineCharacters);
  } else if (projectedCurrent?.response) {
    headline = visibleSummary(projectedCurrent.response.text, summaryHeadlineCharacters);
  } else if (activeTool) {
    headline = toolHeadline(activeTool);
  } else if (intent) {
    headline = visibleSummary(intent.text, summaryHeadlineCharacters);
  } else if (response) {
    headline = visibleSummary(response, summaryHeadlineCharacters);
  } else if (state.status !== "not_started" && !terminalInspectionStatus(state.status)) {
    headline = "starting";
  }
  const updatedAt = settledActivity?.at ?? projectedCurrent?.updatedAt ?? string(activeTool?.updatedAt) ?? intent?.updatedAt ?? progress?.updatedAt ?? latestTurn?.finishedAt ?? latestTurn?.startedAt
    ?? state.finishedAt ?? details.run.updatedAt;
  const turn = projectedCurrent?.turn ?? number(record(progress?.tools)?.turn) ?? latestTurn?.turn;
  return state.status === "not_started" && !headline
    ? undefined
    : {
        phase,
        ...(headline ? { headline } : {}),
        ...(turn === undefined ? {} : { turn }),
        updatedAt,
      };
}

function progressIntent(progress: RunNodeProgress | undefined): {
  kind: "plan" | "reported-thought";
  text: string;
  updatedAt?: string;
} | undefined {
  const intent = record(progress?.intent);
  const kind = intent?.kind;
  if (!intent || kind !== "plan" && kind !== "reported-thought") return undefined;
  return {
    kind,
    text: eventText(intent.value),
    ...(string(intent.updatedAt) ? { updatedAt: string(intent.updatedAt)! } : {}),
  };
}

function targetAttention(
  state: RunInspectionTargetState,
  details: RunInspectionTargetDetailsDocument,
): RunInspectionAttention | undefined {
  if (state.status === "failed") {
    return {
      code: "terminal_failure",
      summary: visibleSummary(details.summary.failure?.message ?? state.reason ?? "Target failed.", attentionCharacters),
    };
  }
  if (state.status === "timed_out") {
    return {
      code: "timed_out",
      summary: visibleSummary(details.summary.failure?.message ?? state.reason ?? "Target timed out.", attentionCharacters),
    };
  }
  if (state.status === "awaiting") {
    return {
      code: "awaiting_input",
      summary: visibleSummary(details.summary.signal?.promptPreview ?? "Input is required.", attentionCharacters),
    };
  }
  return undefined;
}

function targetActions(
  details: RunInspectionTargetDetailsDocument,
  state: RunInspectionTargetState,
): RunInspectionTargetSummaryDocument["availableActions"] {
  if (state.status === "failed" || state.status === "timed_out") {
    const target = details.summary.nodeKey ?? details.summary.frameKey ?? details.target.id;
    return [
      { kind: "retry", target },
      { kind: "fork", ...(details.summary.nodeKey ? { target: details.summary.nodeKey } : {}) },
    ];
  }
  if (state.status === "awaiting" && details.summary.signal) {
    return [
      {
        kind: "signal",
        target: details.summary.signal.target,
        ...(details.summary.signal.schemaSummary ? { schemaSummary: details.summary.signal.schemaSummary } : {}),
      },
      { kind: "inspect-timeline", target: details.target.id },
    ];
  }
  const attempt = selectedAttempt(details);
  if (details.staticNode?.kind === "agent" && attempt?.status === "started") {
    return [{ kind: "inspect-timeline", target: attempt.attemptId }, { kind: "steer", target: attempt.attemptId }];
  }
  if ((state.status === "running" || state.status === "starting")
    && (details.staticNode?.kind === "task" || compositeKind(details.staticNode?.kind))) {
    const target = attempt?.attemptId ?? details.target.id;
    return [{ kind: "inspect-timeline", target }, { kind: "follow-target", target }];
  }
  return [];
}

function evidenceCapsule(
  details: RunInspectionTargetDetailsDocument,
  observations: AgentObservationInspectionProjection,
  runDir: string,
): AgentAttemptEvidenceCapsule | undefined {
  const attempt = selectedAttempt(details);
  if (!attempt) return undefined;
  const turns = observations.turns
    .filter(turn => turn.attemptId === attempt.attemptId)
    .sort((left, right) => left.turn - right.turn);
  if (turns.length === 0) {
    const unavailableFence = steeredAttempt(attempt);
    if (attempt.status !== "started" && !unavailableFence) return undefined;
    return {
      directory: join(runDir, "evidence", "agents", attempt.attemptId),
      state: unavailableFence ? "partial" : "recording",
      completeness: unavailableFence ? "degraded" : "complete",
      turnCount: 0,
      omittedTurns: 0,
      gapCount: unavailableFence ? 1 : 0,
      schedulerDisposition: attempt.status === "started" ? "pending" : "discarded",
      ...(attempt.cancelReason ?? attempt.terminalReason
        ? { dispositionReason: attempt.cancelReason ?? attempt.terminalReason }
        : {}),
      records: [],
    };
  }
  const selected = turns.length === 1 ? turns : [turns[0]!, turns.at(-1)!];
  const state = turns.some(turn => turn.state === "recording")
    ? "recording"
    : turns.some(turn => turn.state === "partial") ? "partial" : "sealed";
  const schedulerDisposition: AgentAttemptEvidenceCapsule["schedulerDisposition"] = attempt.status === "started"
    ? "pending"
    : attempt.status === "superseded" ? "discarded" : "committed";
  return {
    directory: join(runDir, "evidence", "agents", attempt.attemptId),
    state,
    completeness: turns.some(turn => turn.completeness === "degraded") ? "degraded" : "complete",
    turnCount: turns.length,
    omittedTurns: Math.max(0, turns.length - selected.length),
    gapCount: turns.reduce((total, turn) => total + turn.gapCount, 0),
    ...(turns.at(-1)?.providerStatus ? { providerOutcome: turns.at(-1)!.providerStatus } : {}),
    schedulerDisposition,
    ...(attempt.cancelReason ?? attempt.terminalReason ? { dispositionReason: attempt.cancelReason ?? attempt.terminalReason } : {}),
    records: selected.map(turn => ({
      turn: turn.turn,
      file: basename(turn.relativePath),
      prompt: { kind: turn.promptKind, bytes: turn.promptBytes, digest: turn.promptDigest },
      lastDurableResponseBytes: turn.lastResponseBytes,
      ...(turn.responseAtFenceBytes === undefined ? {} : { responseAtFenceBytes: turn.responseAtFenceBytes }),
      ...(turn.finalResponseBytes === undefined ? {} : { finalObservedResponseBytes: turn.finalResponseBytes }),
      ...(turn.trace === undefined
        ? {}
        : {
            trace: {
              state: turn.trace.state,
              ...(turn.trace.relativePath ? { file: basename(turn.trace.relativePath) } : {}),
              ...(turn.trace.bytes === undefined ? {} : { bytes: turn.trace.bytes }),
              ...(turn.trace.digest === undefined ? {} : { digest: turn.trace.digest }),
            },
          }),
    })),
  };
}

function missingSteerEvidence(
  details: RunInspectionTargetDetailsDocument,
  observations: AgentObservationInspectionProjection | undefined,
): boolean {
  const attempt = selectedAttempt(details);
  return Boolean(attempt
    && steeredAttempt(attempt)
    && !observations?.turns.some(turn => turn.attemptId === attempt.attemptId));
}

function inspectionVisibility(
  details: RunInspectionTargetDetailsDocument,
  observations: AgentObservationInspectionProjection,
): RunInspectionVisibility | undefined {
  if (missingSteerEvidence(details, observations)) {
    return { state: "degraded", reason: "boundary-evidence-unavailable" };
  }
  if (observations.turns.some(turn => turn.gapCount > 0)
    || observations.entries.some(entry => entry.kind === "gap")) {
    return { state: "degraded", reason: "observation-gap" };
  }
  if (observations.turns.some(turn => turn.unknownEventCount > 0)
    || observations.turns.some(turn => turn.completeness === "degraded")
    || observations.currents.some(current => current.completeness === "degraded")) {
    return { state: "degraded", reason: "unrecognized-provider-activity" };
  }
  return undefined;
}

function steeredAttempt(attempt: RunDynamicAttempt): boolean {
  return attempt.status === "superseded"
    && (attempt.cancelReason === "operator_steered" || attempt.terminalReason === "operator_steered");
}

function currentActivity(
  details: RunInspectionTargetDetailsDocument,
  run: RunDetails,
  observations: AgentObservationInspectionProjection,
  attempt: RunDynamicAttempt | undefined,
): RunInspectionCurrentActivity | undefined {
  const state = inspectionTargetState(details);
  const providerStillRecording = attempt
    && observations.turns.some(turn => turn.attemptId === attempt.attemptId && turn.state === "recording");
  if (details.staticNode?.kind === "agent" && attempt
    && (providerStillRecording || ["running", "starting", "awaiting"].includes(state.status))) {
    return currentAgentActivity(attempt, selectedProgress(run, details), observations);
  }
  if (!["running", "starting", "awaiting"].includes(state.status)) return undefined;
  if (details.staticNode?.kind === "signal" && state.status === "awaiting") {
    return {
      kind: "signal",
      phase: "awaiting",
      updatedAt: details.signalWaits.at(-1)?.updatedAt ?? run.updatedAt,
      ...(details.summary.signal?.deadlineAt ? { deadlineAt: details.summary.signal.deadlineAt } : {}),
      ...(details.summary.signal?.promptPreview
        ? { prompt: excerpt(details.summary.signal.promptPreview, currentIntentBytes, "head") }
        : {}),
      ...(details.summary.signal?.schemaSummary ? { schemaSummary: details.summary.signal.schemaSummary } : {}),
    };
  }
  return {
    kind: compositeKind(details.staticNode?.kind) ? "composite" : "task",
    phase: state.status === "starting" ? "starting" : "running",
    updatedAt: details.items.at(-1)?.updatedAt ?? run.updatedAt,
    ...(details.items.at(-1)?.statusReason ? { message: details.items.at(-1)!.statusReason } : {}),
  };
}

function currentAgentActivity(
  attempt: RunDynamicAttempt,
  progress: RunNodeProgress | undefined,
  observations: AgentObservationInspectionProjection,
): AgentCurrentActivity {
  const turns = observations.turns.filter(turn => turn.attemptId === attempt.attemptId)
    .sort((left, right) => left.turn - right.turn);
  const turn = turns.at(-1);
  const projected = observations.currents
    .filter(current => current.attemptId === attempt.attemptId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  if (projected) {
    const active = projected.tools?.active ?? [];
    return {
      kind: "agent",
      attemptId: attempt.attemptId,
      attemptNo: attempt.attemptNo,
      ...(projected.postFence ? { postFence: true } : {}),
      turn: projected.turn,
      turnKind: projected.promptKind,
      phase: publicAgentPhase(projected.phase),
      updatedAt: projected.updatedAt,
      ...(projected.response ? { response: projected.response } : {}),
      ...(projected.intent ? { intent: projected.intent } : {}),
      ...(active.length > 0
        ? { tools: { active, omittedActive: projected.tools?.omittedActive ?? 0 } }
        : {}),
    };
  }
  const response = progress?.output?.tail ?? "";
  const reported = progressIntent(progress);
  const intent = reported
    ? { kind: reported.kind, excerpt: excerpt(reported.text, currentIntentBytes, "tail") }
    : undefined;
  const allTools = progressTools(progress).calls
    .map(call => progressToolActivity(call))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const updatedAt = progress?.updatedAt ?? turn?.finishedAt ?? turn?.startedAt ?? attempt.startedAt;
  const active = allTools.filter(tool => !terminalToolStatuses.has(tool.status ?? ""));
  const selectedActive = active.slice(-2);
  const phase: AgentCurrentActivity["phase"] = selectedActive.length > 0
    ? "tool"
    : intent?.kind === "plan" ? "planning"
      : intent ? "reported-thought"
        : response ? "responding"
          : turn?.promptKind === "repair" ? "output-repair"
            : turn?.state === "sealed" ? "settling" : "starting";
  return {
    kind: "agent",
    attemptId: attempt.attemptId,
    attemptNo: attempt.attemptNo,
    ...(turn ? { turn: turn.turn, turnKind: turn.promptKind } : {}),
    phase,
    updatedAt,
    ...(response ? { response: excerpt(response, currentResponseBytes, "tail") } : {}),
    ...(intent ? { intent } : {}),
    ...(selectedActive.length > 0 ? {
      tools: {
        active: selectedActive,
        omittedActive: Math.max(0, active.length - selectedActive.length),
      },
    } : {}),
  };
}

function progressToolActivity(call: Record<string, unknown> & { updatedAt: string }): RunInspectionToolActivity {
  const toolCallId = string(call.toolCallId);
  const startedAt = string(call.startedAt);
  const status = string(call.status);
  const input = string(call.inputPreview);
  const outputValue = call.outputPreview ?? call.output;
  const output = outputValue === undefined ? undefined : eventText(outputValue);
  return {
    ...(toolCallId ? { toolCallId: publicToolCallId(toolCallId) } : {}),
    name: visibleSummary(toolName(call), toolNameCharacters),
    ...(status ? { status: visibleSummary(status, toolStatusCharacters) } : {}),
    ...boundedToolPayload(
      input === undefined ? undefined : excerpt(input, currentToolBytes, "head"),
      output === undefined ? undefined : excerpt(output, currentToolBytes, "tail"),
      currentToolBytes,
    ),
    ...(startedAt ? { startedAt } : {}),
    updatedAt: call.updatedAt,
    ...(terminalToolStatuses.has(status ?? "") ? { finishedAt: call.updatedAt } : {}),
  };
}

function publicAgentPhase(phase: string): RunInspectionPulse["phase"] {
  if (phase === "thinking") return "reported-thought";
  if (phase === "repairing") return "output-repair";
  if (phase === "starting"
    || phase === "responding"
    || phase === "planning"
    || phase === "tool"
    || phase === "settling"
    || phase === "settled") return phase;
  return "starting";
}

function observationTimelineEntries(
  observations: AgentObservationInspectionProjection,
  details: RunInspectionTargetDetailsDocument,
  allowedAttemptIds: ReadonlySet<string>,
  afterObservationVersion?: number,
): RunInspectionTimelineEntry[] {
  const attemptNoById = new Map(details.attempts.map(attempt => [attempt.attemptId, attempt.attemptNo]));
  return observations.entries
    .filter(entry => allowedAttemptIds.has(entry.attemptId)
      && (afterObservationVersion === undefined || entry.observationVersion > afterObservationVersion))
    .map(entry => entry.kind === "activity"
      ? {
          id: entry.id,
          kind: "activity",
          at: entry.at,
          attemptId: entry.attemptId,
          ...(attemptNoById.get(entry.attemptId) === undefined
            ? {}
            : { attemptNo: attemptNoById.get(entry.attemptId)! }),
          ...(entry.postFence ? { postFence: true as const } : {}),
          turn: entry.turn,
          channel: entry.channel,
          summary: entry.summary,
          ...(entry.tool ? { tool: entry.tool } : {}),
        }
      : {
          id: entry.id,
          kind: "gap",
          at: entry.at,
          dropped: entry.dropped,
          reason: entry.reason,
        });
}

function schedulerTimelineEntries(
  events: readonly CommittedRuntimeEventRow[],
  details: RunInspectionTargetDetailsDocument,
  run: RunDetails,
  observations?: AgentObservationInspectionProjection,
): RunInspectionTimelineEntry[] {
  const identities = new Set([
    details.target.id,
    ...details.instances.map(instance => instance.nodeKey),
    ...details.frames.flatMap(frame => [frame.frameKey, ...(frame.nodeKey ? [frame.nodeKey] : [])]),
    ...details.attempts.flatMap(attempt => [attempt.attemptId, attempt.nodeKey]),
  ]);
  const eventBySequence = new Map(events.map(event => [event.sequence, event]));
  const attemptNoById = new Map(details.attempts.map(attempt => [attempt.attemptId, attempt.attemptNo]));
  const entries: RunInspectionTimelineEntry[] = [];
  const hasOccurrence = details.instances.length > 0
    || details.frames.length > 0
    || details.attempts.length > 0;
  for (const change of semanticChanges(events, details, run)) {
    const globallyRelevant = hasOccurrence && (change.action === "paused" || change.action === "resumed");
    const event = change.sequence === undefined ? undefined : eventBySequence.get(change.sequence);
    if (details.target.kind === "attempt" && !globallyRelevant) {
      const attemptIds = event
        ? [event.payload.attemptId, event.payload.acceptedAttemptId, event.payload.fencedAttemptId]
        : [];
      if (!attemptIds.includes(details.target.id)) continue;
    } else if (!globallyRelevant
      && !identities.has(change.entity.id)
      && !(change.itemKey && details.items.some(item => item.key === change.itemKey))) continue;
    const control = controlAction(change.action);
    if (control) {
      const attemptId = change.entity.kind === "attempt"
        ? change.entity.id
        : typeof event?.payload.fencedAttemptId === "string" ? event.payload.fencedAttemptId : undefined;
      entries.push({
        id: `event:${change.sequence ?? `${change.at}:${change.entity.id}`}`,
        kind: "control",
        at: change.at,
        action: control,
        ...(attemptId ? { attemptId } : {}),
        ...(attemptId && attemptNoById.get(attemptId) !== undefined
          ? { attemptNo: attemptNoById.get(attemptId)! }
          : {}),
        ...(control === "steered"
          ? responseAtFence(observations, attemptId, change.sequence)
          : {}),
      });
      continue;
    }
    entries.push({
      id: `event:${change.sequence ?? `${change.at}:${change.entity.id}`}`,
      kind: "transition",
      at: change.at,
      action: change.action,
      ...(change.status ? { status: change.status } : {}),
      ...(change.entity.kind === "attempt" ? { attemptId: change.entity.id } : {}),
      ...(change.attemptNo === undefined ? {} : { attemptNo: change.attemptNo }),
      ...(change.message ? { summary: excerpt(change.message, timelineEntryBytes, "head") } : {}),
    });
  }
  return entries;
}

function responseAtFence(
  observations: AgentObservationInspectionProjection | undefined,
  attemptId: string | undefined,
  eventSequence: number | undefined,
): Pick<Extract<RunInspectionTimelineEntry, { kind: "control" }>, "responseAtFenceBytes"> {
  if (!observations || !attemptId) return {};
  const turn = observations.turns
    .filter(candidate => candidate.attemptId === attemptId
      && (eventSequence === undefined || candidate.fenceEventSequence === eventSequence))
    .sort((left, right) => right.turn - left.turn)[0];
  return turn?.responseAtFenceBytes === undefined
    ? {}
    : { responseAtFenceBytes: turn.responseAtFenceBytes };
}

function timelinePage(input: {
  entries: RunInspectionTimelineEntry[];
  limit: number;
  before?: { at: string; id: string; ordinal: number };
  runId: string;
  target: string;
  hasOlderSemanticEntries: boolean;
  olderSemanticEntryCount: number;
  semanticBoundaryById: ReadonlyMap<string, {
    observationVersion: number;
    sourceSequence: number;
    id: string;
  }>;
  retentionOmittedBefore: number;
}): RunInspectionTimelineDocument["recent"] {
  const limit = Math.min(timelineMaximumLimit, Math.max(1, input.limit));
  const ordinals = timelineEntryOrdinals(input.entries);
  const eligible = input.before
    ? input.entries.filter(entry =>
        entry.at.localeCompare(input.before!.at) < 0
        || entry.at === input.before!.at
          && (ordinals.get(entry.id) ?? 0) < (ordinals.get(input.before!.id) ?? input.before!.ordinal))
    : input.entries;
  const selected: RunInspectionTimelineEntry[] = [];
  let bytes = 0;
  for (let index = eligible.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const entry = eligible[index]!;
    const entryBytes = timelineEntryBodyBytes(entry);
    if (selected.length > 0 && bytes + entryBytes > timelinePageBodyBytes) break;
    selected.push(entry);
    bytes += entryBytes;
  }
  selected.reverse();
  const omittedBefore = eligible.length - selected.length + input.olderSemanticEntryCount;
  const first = selected[0];
  const hasOlder = omittedBefore > 0 || input.hasOlderSemanticEntries;
  const beforeEntry = selected.reduce<{
    observationVersion: number;
    sourceSequence: number;
    id: string;
  } | undefined>((oldest, entry) => {
    const boundary = input.semanticBoundaryById.get(entry.id);
    return boundary === undefined
      ? oldest
      : oldest === undefined || compareSemanticBoundary(boundary, oldest) < 0 ? boundary : oldest;
  }, undefined);
  return {
    entries: selected,
    returned: selected.length,
    omittedBefore,
    hasOlder,
    ...(input.retentionOmittedBefore > 0
      ? { retentionOmittedBefore: input.retentionOmittedBefore }
      : {}),
    ...(hasOlder && first
      ? {
          olderCursor: timelinePageCursor({
            runId: input.runId,
            target: input.target,
            at: first.at,
            id: first.id,
            ordinal: ordinals.get(first.id) ?? 0,
            ...(beforeEntry === undefined ? {} : { beforeEntry }),
          }),
        }
      : {}),
  };
}

function compareSemanticBoundary(
  left: { observationVersion: number; sourceSequence: number; id: string },
  right: { observationVersion: number; sourceSequence: number; id: string },
): number {
  return left.observationVersion - right.observationVersion
    || left.sourceSequence - right.sourceSequence
    || left.id.localeCompare(right.id);
}

function progressTools(progress: RunNodeProgress | undefined): {
  calls: Array<Record<string, unknown> & { updatedAt: string }>;
} {
  const value = record(progress?.tools);
  const calls = Array.isArray(value?.lastCalls)
    ? value.lastCalls.flatMap(item => {
        const call = record(item);
        if (!call) return [];
        return [{ ...call, updatedAt: string(call.updatedAt) ?? progress?.updatedAt ?? "" }];
      })
    : [];
  return { calls };
}

function toolHeadline(call: Record<string, unknown>): string {
  const status = string(call.status);
  return visibleSummary(`${toolName(call)}${status ? ` ${status}` : ""}`, summaryHeadlineCharacters);
}

function toolName(call: Record<string, unknown>): string {
  return string(call.toolName) ?? string(call.title) ?? string(call.kind) ?? "tool";
}

function boundedToolPayload(
  input: RunInspectionExcerpt | undefined,
  output: RunInspectionExcerpt | undefined,
  budget: number,
): Pick<RunInspectionToolActivity, "input" | "output"> {
  const inputBudget = input && output ? Math.floor(budget / 2) : budget;
  const outputBudget = input && output ? budget - inputBudget : budget;
  return {
    ...(input ? { input: limitExcerpt(input, inputBudget, "head") } : {}),
    ...(output ? { output: limitExcerpt(output, outputBudget, "tail") } : {}),
  };
}

function limitExcerpt(
  value: RunInspectionExcerpt,
  limit: number,
  direction: "head" | "tail",
): RunInspectionExcerpt {
  const limited = excerpt(value.text, limit, direction);
  return {
    ...limited,
    originalBytes: value.originalBytes,
    truncated: value.truncated || limited.truncated,
  };
}

export function inspectionExcerpt(value: string, limit: number, direction: "head" | "tail" = "head"): RunInspectionExcerpt {
  return excerpt(value, limit, direction);
}

function excerpt(value: string, limit: number, direction: "head" | "tail"): RunInspectionExcerpt {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= limit) return { text: value, originalBytes, truncated: false };
  const source = Buffer.from(value);
  let selected = direction === "head" ? source.subarray(0, limit) : source.subarray(source.byteLength - limit);
  while (selected.length > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(selected),
        originalBytes,
        truncated: true,
      };
    } catch {
      // Only the selected edge can split a UTF-8 sequence.
    }
    selected = direction === "head" ? selected.subarray(0, -1) : selected.subarray(1);
  }
  return { text: "", originalBytes, truncated: true };
}

function eventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(eventText).join("");
  const data = record(value);
  if (data) {
    const direct = string(data.text) ?? string(data.content) ?? string(data.value);
    if (direct) return direct;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function visibleSummary(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("")}…`;
}

function terminalStatus(status: string): boolean {
  return ["completed", "failed", "timed_out", "cancelled", "canceled", "superseded"].includes(status);
}

function terminalInspectionStatus(status: RunInspectionTargetState["status"]): boolean {
  return ["completed", "failed", "timed_out", "cancelled", "not_selected"].includes(status);
}

function compositeKind(kind: string | undefined): boolean {
  return kind !== undefined && ["if", "switch", "parallel", "fanout", "loop"].includes(kind);
}

function controlAction(action: string): "steered" | "paused" | "resumed" | "retried" | "cancelled" | undefined {
  if (action === "steered" || action === "paused" || action === "resumed" || action === "cancelled") return action;
  if (action === "retrying") return "retried";
  return undefined;
}

function compareTimelineEntries(left: RunInspectionTimelineEntry, right: RunInspectionTimelineEntry): number {
  return left.at.localeCompare(right.at)
    || timelineFenceOrder(left) - timelineFenceOrder(right)
    || left.id.localeCompare(right.id);
}

function timelineFenceOrder(entry: RunInspectionTimelineEntry): number {
  if (entry.kind === "activity" && entry.postFence) return 2;
  if (entry.kind === "control" && entry.action === "steered") return 1;
  return 0;
}

function timelineEntryOrdinals(entries: readonly RunInspectionTimelineEntry[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  let at: string | undefined;
  let ordinal = 0;
  for (const entry of entries) {
    if (entry.at === at) ordinal += 1;
    else {
      at = entry.at;
      ordinal = 0;
    }
    ordinals.set(entry.id, ordinal);
  }
  return ordinals;
}

function timelineEntryBodyBytes(entry: RunInspectionTimelineEntry): number {
  if (entry.kind === "transition") return Buffer.byteLength(entry.summary?.text ?? "");
  if (entry.kind === "activity") {
    return Buffer.byteLength(entry.summary.text)
      + Buffer.byteLength(entry.tool?.toolCallId ?? "")
      + Buffer.byteLength(entry.tool?.name ?? "")
      + Buffer.byteLength(entry.tool?.status ?? "")
      + Buffer.byteLength(entry.tool?.input?.text ?? "")
      + Buffer.byteLength(entry.tool?.output?.text ?? "");
  }
  return 0;
}

function publicToolCallId(value: string): string {
  if (Buffer.byteLength(value) <= toolCallIdBytes) return value;
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
