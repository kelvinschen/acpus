import { createHash } from "node:crypto";
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
import { occurrenceRefSelector } from "../scheduler/occurrence-ref.js";
import type {
  AgentCurrentActivity,
  RunInspectionAttention,
  RunInspectionCurrentActivity,
  RunInspectionExcerpt,
  RunInspectionPulse,
  RunInspectionSubject,
  RunInspectionTargetState,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
  RunInspectionTimelineEntry,
  RunInspectionToolActivity,
  RunInspectionVisibility,
} from "./types.js";
import type { ResolvedTargetState } from "./resolved-target.js";

const summaryHeadlineCharacters = 240;
const attentionCharacters = 160;
const timelineDefaultLimit = 12;
const timelineMaximumLimit = 50;
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
  details: ResolvedTargetState;
  includeControls?: true;
  observations?: AgentObservationInspectionProjection;
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
  const document: RunInspectionTargetSummaryDocument = {
    schemaVersion: 2,
    kind: "target",
    run: { id: input.run.id, status: input.run.status, updatedAt: input.run.updatedAt },
    subject,
    state,
    ...(pulse ? { pulse } : {}),
    ...(attention ? { attention } : {}),
    ...(visibility ? { visibility } : {}),
    availableActions: aggregate ? [] : targetActions(input.details, state, input.includeControls === true),
    ...(input.details.summary.counts
      ? { occurrence: { total: input.details.summary.counts.total, counts: input.details.summary.counts } }
      : {}),
  };
  return document;
}

export function projectTimeline(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  page?: number;
  limit?: number;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
}): RunInspectionTimelineDocument {
  const subject = inspectionSubject(input.details);
  const state = inspectionTargetState(input.details);
  const attempt = selectedAttempt(input.details);
  const current = currentActivity(input.details, input.run, input.observations, attempt);
  const entries = projectTimelineEntries(input);
  const recent = timelinePage({
    entries,
    limit: input.limit ?? timelineDefaultLimit,
    page: input.page ?? 1,
    hasOlderSemanticEntries: input.observations.hasOlderEntries,
    olderSemanticEntryCount: input.observations.olderEntryCount,
    retentionOmittedBefore: input.observations.retentionOmittedBefore,
  });
  const visibility = inspectionVisibility(input.details, input.observations);
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: { id: input.run.id, status: input.run.status, updatedAt: input.run.updatedAt },
    subject,
    state,
    ...(visibility ? { visibility } : {}),
    ...(current ? { current } : {}),
    recent,
  };
}

/** The complete retained semantic stream used by follow; ordinary reads page it. */
export function projectTimelineEntries(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
}): RunInspectionTimelineEntry[] {
  const allowedAttemptIds = new Set(timelineAttemptIds(input.details));
  return [
    ...observationTimelineEntries(input.observations, input.details, allowedAttemptIds),
    ...schedulerTimelineEntries(input.events, input.details, input.run, input.observations),
  ].sort(compareTimelineEntries);
}

export function timelineAttemptIds(details: ResolvedTargetState): string[] {
  if (details.target.kind === "attempt") return [details.target.id];
  return [...new Set(details.attempts.map(attempt => attempt.attemptId))].sort();
}

export function targetAttemptId(details: ResolvedTargetState): string | undefined {
  return selectedAttempt(details)?.attemptId;
}

export function inspectionSubject(details: ResolvedTargetState): RunInspectionSubject {
  const aggregate = staticAggregate(details);
  const attempt = aggregate ? undefined : selectedAttempt(details);
  const item = attempt
    ? details.items.find(candidate => candidate.attemptId === attempt.attemptId)
    : details.items.find(candidate => candidate.nodeKey === details.summary.nodeKey || candidate.frameKey === details.summary.frameKey)
      ?? details.items[0];
  const nodeId = details.staticNode?.nodeId ?? attempt?.nodeId ?? item?.nodeId;
  const selector = details.target.ref
    ? occurrenceRefSelector(details.target.ref as `@${string}`, details.target.kind === "attempt" ? attempt?.attemptNo : undefined)
    : undefined;
  return {
    targetKind: details.target.kind,
    id: selector ?? details.target.id,
    ...(selector ? { ref: selector } : {}),
    label: item?.label ?? nodeId ?? details.target.id,
    kind: details.staticNode?.kind ?? item?.kind ?? "node",
    ...(nodeId && nodeId !== details.target.id ? { nodeId } : {}),
  };
}

export function inspectionTargetState(details: ResolvedTargetState): RunInspectionTargetState {
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

function selectedAttempt(details: ResolvedTargetState): RunDynamicAttempt | undefined {
  const selectedAttemptId = details.summary.latestAttempt?.attemptId
    ?? (details.target.kind === "attempt" ? details.target.id : undefined);
  if (selectedAttemptId) {
    return details.attempts.find(attempt => attempt.attemptId === selectedAttemptId);
  }
  return [...details.attempts].sort((left, right) =>
    right.attemptNo - left.attemptNo
      || right.startedAt.localeCompare(left.startedAt)
      || right.attemptId.localeCompare(left.attemptId))[0];
}

function staticAggregate(details: ResolvedTargetState): boolean {
  return details.target.kind === "static-node" && (details.summary.counts?.total ?? 0) > 1;
}

function selectedProgress(run: RunDetails, details: ResolvedTargetState): RunNodeProgress | undefined {
  const attempt = selectedAttempt(details);
  return [...(run.dynamic?.progress ?? [])]
    .filter(progress => attempt
      ? progress.attemptId === attempt.attemptId
      : details.instances.some(instance => instance.nodeKey === progress.nodeKey)
        || details.target.kind === "static-node" && progress.nodeId === details.target.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function targetPulse(
  details: ResolvedTargetState,
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
  const settledActivities = terminal
    ? observations?.entries
      .flatMap(entry => entry.kind === "activity"
        && entry.attemptId === attemptId
        && visibleSummary(entry.summary.text, summaryHeadlineCharacters).length > 0
        ? [entry]
        : [])
    : undefined;
  const settledIntent = settledActivities
    ?.filter(entry => entry.channel === "reported-thought" || entry.channel === "plan")
      .sort((left, right) => left.at.localeCompare(right.at) || left.sourceSequence - right.sourceSequence)
      .at(-1);
  const settledResponse = settledActivities
    ?.filter(entry => entry.channel === "response")
      .sort((left, right) => left.at.localeCompare(right.at) || left.sourceSequence - right.sourceSequence)
      .at(-1);
  const settledActivity = settledIntent ?? settledResponse;
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
    const label = settledActivity.channel === "plan"
      ? "Plan"
      : settledActivity.channel === "reported-thought" ? "Reported thought" : "Response tail";
    const missingPrefix = settledActivity.channel === "response" && settledActivity.summary.truncated ? "…" : "";
    headline = visibleSummary(
      `${label}: ${missingPrefix}${settledActivity.summary.text}`,
      summaryHeadlineCharacters,
    );
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
  const turn = settledActivity?.turn ?? projectedCurrent?.turn ?? number(record(progress?.tools)?.turn) ?? latestTurn?.turn;
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
  details: ResolvedTargetState,
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
  details: ResolvedTargetState,
  state: RunInspectionTargetState,
  includeControls: boolean,
): RunInspectionTargetSummaryDocument["availableActions"] {
  const selector = details.target.ref;
  const attempt = selectedAttempt(details);
  const exactAttemptSelector = selector && attempt
    ? occurrenceRefSelector(selector as `@${string}`, attempt.attemptNo)
    : undefined;
  const navigationTarget = selector ?? details.target.id;
  const controls = includeControls
    ? targetControlActions(details, selector, exactAttemptSelector)
    : [];
  if (state.status === "failed" || state.status === "timed_out") {
    return [{ kind: "inspect-timeline", target: navigationTarget }, ...controls];
  }
  if (state.status === "awaiting" && details.summary.signal) {
    return [
      {
        kind: "signal",
        target: selector ?? details.summary.signal.target,
        ...(details.summary.signal.schemaSummary ? { schemaSummary: details.summary.signal.schemaSummary } : {}),
      },
      { kind: "inspect-timeline", target: navigationTarget },
      ...controls,
    ];
  }
  if (details.staticNode?.kind === "agent" && attempt?.status === "started") {
    const target = exactAttemptSelector ?? attempt.attemptId;
    return [{ kind: "inspect-timeline", target }, ...controls];
  }
  if ((state.status === "running" || state.status === "starting")
    && (details.staticNode?.kind === "task" || compositeKind(details.staticNode?.kind))) {
    return [{ kind: "inspect-timeline", target: navigationTarget }, { kind: "follow-target", target: navigationTarget }, ...controls];
  }
  return controls;
}

function targetControlActions(
  details: ResolvedTargetState,
  selector: string | undefined,
  exactAttemptSelector: string | undefined,
): RunInspectionTargetSummaryDocument["availableActions"] {
  const actions: RunInspectionTargetSummaryDocument["availableActions"] = [];
  if (selector && details.availableControls.some(control => control.type === "retry")) {
    actions.push({ kind: "retry", target: selector });
  }
  if (details.availableControls.some(control => control.type === "cancel")) {
    actions.push({ kind: "cancel", ...(selector ? { target: selector } : {}) });
  }
  if (exactAttemptSelector && details.availableControls.some(control => control.type === "steer")) {
    actions.push({ kind: "steer", target: exactAttemptSelector });
  }
  return actions;
}

function missingSteerEvidence(
  details: ResolvedTargetState,
  observations: AgentObservationInspectionProjection | undefined,
): boolean {
  const attempt = selectedAttempt(details);
  return Boolean(attempt
    && steeredAttempt(attempt)
    && !observations?.turns.some(turn => turn.attemptId === attempt.attemptId));
}

export function inspectionVisibility(
  details: ResolvedTargetState,
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
  details: ResolvedTargetState,
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
  details: ResolvedTargetState,
  allowedAttemptIds: ReadonlySet<string>,
): RunInspectionTimelineEntry[] {
  const attemptNoById = new Map(details.attempts.map(attempt => [attempt.attemptId, attempt.attemptNo]));
  return observations.entries
    .filter(entry => allowedAttemptIds.has(entry.attemptId))
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
  details: ResolvedTargetState,
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
  page: number;
  hasOlderSemanticEntries: boolean;
  olderSemanticEntryCount: number;
  retentionOmittedBefore: number;
}): RunInspectionTimelineDocument["recent"] {
  const limit = Math.min(timelineMaximumLimit, Math.max(1, input.limit));
  const page = Math.max(1, input.page);
  const offset = (page - 1) * limit;
  const end = Math.max(0, input.entries.length - offset);
  const selected = input.entries.slice(Math.max(0, end - limit), end);
  const omittedBefore = Math.max(0, input.entries.length - offset - selected.length) + input.olderSemanticEntryCount;
  const retainedOlder = omittedBefore > 0 || input.hasOlderSemanticEntries;
  const hasOlder = retainedOlder;
  return {
    entries: selected,
    page,
    limit,
    returned: selected.length,
    omittedBefore,
    hasOlder,
    ...(input.retentionOmittedBefore > 0
      ? { retentionOmittedBefore: input.retentionOmittedBefore }
      : {}),
    ...(retainedOlder ? { olderPage: page + 1 } : {}),
  };
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
