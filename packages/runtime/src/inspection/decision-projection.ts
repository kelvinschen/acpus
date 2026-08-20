import type {
  AgentObservationInspectionProjection,
} from "../observations/log.js";
import type { CommittedRuntimeEventRow } from "../store/committed-event.js";
import type {
  RunDynamicAttempt,
  RunNodeProgress,
} from "../store/inspection-read-model.js";
import type { RunDetails } from "../store/store.js";
import {
  boundedInspectionText,
  inspectionCounts,
  normalizeInspectionStatus,
  semanticChanges,
  visibleInspectionState,
} from "./projection.js";
import { createAgentActivityProjector } from "./agent-activity-projection.js";
import { deriveOccurrenceRef, occurrenceRefSelector } from "../scheduler/occurrence-ref.js";
import { signalBlocksInspectionTarget } from "./signal-boundary.js";
import type {
  InspectionActivity,
  InspectionAttention,
  InspectionPulse,
  InspectionSubject,
  InspectionView,
  RunInspectionCurrentActivity,
  RunInspectionExcerpt,
  RunInspectionPulse,
  RunInspectionSubject,
  RunInspectionTargetState,
  RunInspectionTimelineEntry,
  RunInspectionVisibility,
  TimelineEntry,
} from "./types.js";
import type { ResolvedTargetState } from "./resolved-target.js";

const summaryHeadlineCharacters = 240;
const attentionCharacters = 160;
const timelineRecentLimit = 12;
const timelineEntryBytes = 512;
const currentIntentBytes = 768;
const terminalToolStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);

export function projectInspectionTargetSummaryView(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  observations?: AgentObservationInspectionProjection;
}): Extract<InspectionView, { kind: "target"; detail: "summary" }> {
  const aggregate = staticAggregate(input.details);
  const state = inspectionTargetState(input.details);
  const progress = aggregate || input.details.staticNode?.kind === "agent"
    ? undefined
    : selectedProgress(input.run, input.details);
  const pulse = aggregate
    ? undefined
    : input.details.staticNode?.kind === "agent"
      ? agentTargetPulse(input.details, input.observations)
      : targetPulse(input.details, progress);
  const attention = targetAttention(state, input.details);
  const visibility = input.observations
    ? inspectionVisibility(input.details, input.observations)
    : undefined;
  const subject = inspectionViewSubject(input.details);
  const requiredSignal = requiredTargetSignal(input.run, input.details);
  const visibleAttention = requiredSignal ? signalAttention(requiredSignal) : attention;
  return {
    kind: "target",
    detail: "summary",
    run: { id: input.run.id, status: input.run.status },
    subject,
    state: visibleInspectionState(state, input.details.summary.failure),
    ...(pulse ? { pulse: inspectionPulse(pulse) } : {}),
    ...(visibleAttention ? { attention: visibleAttention } : {}),
    ...(visibility ? { visibility: { ...visibility } } : {}),
    ...(input.details.summary.counts
      ? { occurrences: inspectionCounts(input.details.summary.counts) }
      : {}),
    ...(input.details.summary.agentSession === undefined ? {} : { agentSession: input.details.summary.agentSession }),
    ...(input.details.summary.steer === undefined ? {} : { steer: input.details.summary.steer }),
    availableControls: input.details.availableControls,
  };
}

export function projectInspectionTargetTimelineView(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
}): Extract<InspectionView, { kind: "target"; detail: "timeline" }> {
  const subject = inspectionViewSubject(input.details);
  const state = inspectionTargetState(input.details);
  const attempt = selectedAttempt(input.details);
  const current = currentActivity(input.details, input.run, input.observations, attempt);
  const entries = projectTimelineEntries(input);
  const visibility = inspectionVisibility(input.details, input.observations);
  const requiredSignal = requiredTargetSignal(input.run, input.details);
  const visibleCurrent = requiredSignal
    ? signalActivity(requiredSignal)
    : current?.kind === "signal" || current === undefined
      ? undefined
      : inspectionActivity(current);
  return {
    kind: "target",
    detail: "timeline",
    run: { id: input.run.id, status: input.run.status },
    subject,
    state: visibleInspectionState(state, input.details.summary.failure),
    ...(visibility ? { visibility: { ...visibility } } : {}),
    ...(visibleCurrent ? { current: visibleCurrent } : {}),
    recent: entries.slice(-timelineRecentLimit).flatMap(entry => timelineEntry(entry)),
  };
}

/** The complete retained semantic stream used by follow and bounded one-shot reads. */
function projectTimelineEntries(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
}): RunInspectionTimelineEntry[] {
  const allowedAttemptIds = new Set(timelineAttemptIds(input.details));
  return [
    ...observationTimelineEntries(input.observations, input.details, allowedAttemptIds),
    ...schedulerTimelineEntries(input.events, input.details, input.run),
  ].sort(compareTimelineEntries);
}

function timelineAttemptIds(details: ResolvedTargetState): string[] {
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

export function inspectionViewSubject(details: ResolvedTargetState): InspectionSubject {
  const subject = inspectionSubject(details);
  const selector = subject.ref ?? (details.target.kind === "static-node" ? details.target.id : undefined);
  return {
    label: subject.label,
    kind: subject.kind,
    ...(selector === undefined ? {} : { selector }),
  };
}

type RequiredTargetSignal = {
  selector: string;
  prompt?: string;
};

function requiredTargetSignal(run: RunDetails, details: ResolvedTargetState): RequiredTargetSignal | undefined {
  const rootTarget = details.target.kind === "frame" && details.target.id === "root";
  const targetPath = targetInstancePath(run, details);
  const wait = (run.dynamic?.signalWaits ?? []).find(candidate => {
    if (candidate.status !== "awaiting") return false;
    if (rootTarget) return signalBlocksInspectionTarget(run, candidate.nodeKey);
    const path = run.dynamic?.nodeInstances.find(instance => instance.nodeKey === candidate.nodeKey)?.instancePath;
    if (!targetPath) {
      return details.signalWaits.some(selected => selected.nodeKey === candidate.nodeKey)
        && signalBlocksInspectionTarget(run, candidate.nodeKey);
    }
    return path !== undefined && path.length >= targetPath.length
      && signalBlocksInspectionTarget(run, candidate.nodeKey)
      && targetPath.every((segment, index) => JSON.stringify(segment) === JSON.stringify(path[index]));
  });
  if (!wait) return undefined;
  const instance = run.dynamic?.nodeInstances.find(candidate => candidate.nodeKey === wait.nodeKey);
  return {
    selector: instance?.instancePath ? deriveOccurrenceRef(instance.instancePath) : details.target.ref ?? details.target.id,
    ...(wait.renderedPrompt ? { prompt: wait.renderedPrompt } : {}),
  };
}

function targetInstancePath(run: RunDetails, details: ResolvedTargetState) {
  const nodeKey = details.summary.nodeKey
    ?? details.attempts.find(attempt => attempt.attemptId === details.target.id)?.nodeKey
    ?? details.frames.find(frame => frame.frameKey === details.target.id)?.nodeKey;
  return nodeKey === undefined
    ? details.frames.find(frame => frame.frameKey === details.target.id)?.instancePath
    : run.dynamic?.nodeInstances.find(instance => instance.nodeKey === nodeKey)?.instancePath
      ?? run.dynamic?.frames.find(frame => frame.nodeKey === nodeKey)?.instancePath;
}

function signalAttention(signal: RequiredTargetSignal): InspectionAttention {
  return {
    kind: "awaiting-input",
    summary: boundedInspectionText(signal.prompt ?? "Input is required."),
    signal: signal.selector,
    ...(signal.prompt ? { prompt: boundedInspectionText(signal.prompt) } : {}),
  };
}

function signalActivity(signal: RequiredTargetSignal): InspectionActivity {
  return {
    kind: "signal",
    phase: "awaiting",
    signal: signal.selector,
    ...(signal.prompt ? { prompt: boundedInspectionText(signal.prompt) } : {}),
  };
}

function inspectionActivity(current: Exclude<RunInspectionCurrentActivity, { kind: "signal" }>): InspectionActivity {
  if (current.kind === "agent") {
    const tool = current.tools?.active.at(-1);
    const excerpt = current.intent?.excerpt ?? current.response;
    const headline = tool?.name
      ?? (excerpt ? visibleTailInspectionExcerpt(excerpt, 240) : undefined);
    return {
      kind: "agent",
      phase: current.phase,
      ...(current.turn === undefined ? {} : { turn: current.turn }),
      ...(headline ? { headline: tool ? boundedInspectionText(headline) : headline } : {}),
    };
  }
  return {
    kind: current.kind,
    phase: current.phase,
    ...(current.message ? { headline: boundedInspectionText(current.message) } : {}),
  };
}

function timelineEntry(entry: RunInspectionTimelineEntry): TimelineEntry[] {
  if (entry.kind === "activity") return [{
    kind: "activity",
    at: entry.at,
    channel: entry.channel,
    ...(entry.attemptNo === undefined ? {} : { attempt: entry.attemptNo }),
    ...(entry.turn === undefined ? {} : { turn: entry.turn }),
    summary: entry.tool
      ? boundedInspectionText(entry.tool.name)
      : visibleTailInspectionExcerpt(entry.summary, 240),
  }];
  if (entry.kind === "gap") return [{ kind: "gap", at: entry.at, dropped: entry.dropped, reason: entry.reason }];
  if (entry.kind === "visibility") return [{
    kind: "visibility",
    at: entry.at,
    state: entry.state,
    ...(entry.reason ? { reason: entry.reason } : {}),
  }];
  if (entry.kind === "phase") return [{
    kind: "phase",
    at: entry.at,
    phase: entry.phase,
    ...(entry.attemptNo === undefined ? {} : { attempt: entry.attemptNo }),
    ...(entry.turn === undefined ? {} : { turn: entry.turn }),
  }];
  if (entry.kind === "control") return [{
    kind: "control",
    at: entry.at,
    action: entry.action,
    ...(entry.attemptNo === undefined ? {} : { attempt: entry.attemptNo }),
  }];
  const action = transitionAction(entry.action);
  return action === undefined ? [] : [{
    kind: "transition",
    at: entry.at,
    action,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.attemptNo === undefined ? {} : { attempt: entry.attemptNo }),
    ...(entry.summary ? { summary: boundedInspectionText(entry.summary.text) } : {}),
  }];
}

function transitionAction(
  action: import("./types.js").RunInspectionChange["action"],
): Extract<TimelineEntry, { kind: "transition" }>["action"] | undefined {
  if (action === "started" || action === "awaiting" || action === "completed" || action === "failed" || action === "timed_out" || action === "cancelled") {
    return action === "timed_out" ? "timed-out" : action;
  }
  if (action === "retrying") return "retry";
  if (action === "steered") return "steer";
  if (action === "resumed") return "resumed";
  return undefined;
}

function inspectionPulse(value: RunInspectionPulse): InspectionPulse {
  return {
    phase: value.phase,
    ...(value.turn === undefined ? {} : { turn: value.turn }),
    ...(value.headline ? { headline: boundedInspectionText(value.headline) } : {}),
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
): RunInspectionPulse | undefined {
  const state = inspectionTargetState(details);
  const terminal = terminalInspectionStatus(state.status);
  const tools = progressTools(progress);
  const activeTool = terminal
    ? undefined
    : tools.calls.filter(call => !terminalToolStatuses.has(string(call.status) ?? "")).at(-1);
  const intent = terminal ? undefined : progressIntent(progress);
  const response = terminal ? undefined : progress?.output?.tail;
  let phase: RunInspectionPulse["phase"] = "starting";
  if (terminal) phase = "settled";
  else if (activeTool) phase = "tool";
  else if (intent?.kind === "plan") phase = "planning";
  else if (intent) phase = "reported-thought";
  else if (response) phase = "responding";

  let headline: string | undefined;
  if (activeTool) {
    headline = toolHeadline(activeTool);
  } else if (intent) {
    headline = visibleSummary(intent.text, summaryHeadlineCharacters);
  } else if (response) {
    headline = visibleSummary(response, summaryHeadlineCharacters);
  } else if (state.status !== "not_started" && !terminalInspectionStatus(state.status)) {
    headline = "starting";
  }
  const updatedAt = string(activeTool?.updatedAt) ?? intent?.updatedAt ?? progress?.updatedAt
    ?? state.finishedAt ?? details.run.updatedAt;
  const turn = number(record(progress?.tools)?.turn);
  return state.status === "not_started" && !headline
    ? undefined
    : {
        phase,
        ...(headline ? { headline } : {}),
        ...(turn === undefined ? {} : { turn }),
        updatedAt,
      };
}

function agentTargetPulse(
  details: ResolvedTargetState,
  observations: AgentObservationInspectionProjection | undefined,
): RunInspectionPulse | undefined {
  const state = inspectionTargetState(details);
  const attempt = selectedAttempt(details);
  const activity = createAgentActivityProjector(observations)({
    status: state.status,
    updatedAt: state.finishedAt ?? details.run.updatedAt,
    ...(attempt ? { attemptId: attempt.attemptId, attemptNo: attempt.attemptNo } : {}),
  });
  if (!activity) return undefined;
  const settledActivities = activity.phase === "settled"
    ? observations?.entries
      .flatMap(entry => entry.kind === "activity"
        && entry.attemptId === attempt?.attemptId
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
  const current = activity.current;
  const tool = current?.tools?.active.at(-1);
  let headline = tool
    ? visibleSummary(`${tool.name}${tool.status ? ` ${tool.status}` : ""}`, summaryHeadlineCharacters)
    : current?.intent
      ? visibleTailInspectionExcerpt(current.intent.excerpt, summaryHeadlineCharacters)
      : current?.response
        ? visibleTailInspectionExcerpt(current.response, summaryHeadlineCharacters)
        : undefined;
  if (settledActivity?.kind === "activity") {
    const label = settledActivity.channel === "plan"
      ? "Plan"
      : settledActivity.channel === "reported-thought" ? "Reported thought" : "Response tail";
    const prefix = `${label}: `;
    headline = `${prefix}${visibleTailInspectionExcerpt(
      settledActivity.summary,
      summaryHeadlineCharacters - Array.from(prefix).length,
    )}`;
  }
  const turn = settledActivity?.turn ?? activity.turn;
  return {
    phase: activity.phase,
    ...(headline ? { headline } : {}),
    ...(turn === undefined ? {} : { turn }),
    updatedAt: settledActivity?.at ?? activity.updatedAt,
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
): InspectionAttention | undefined {
  if (state.status === "failed") {
    return {
      kind: "failure",
      summary: visibleSummary(details.summary.failure?.message ?? state.reason ?? "Target failed.", attentionCharacters),
    };
  }
  if (state.status === "timed_out") {
    return {
      kind: "timed-out",
      summary: visibleSummary(details.summary.failure?.message ?? state.reason ?? "Target timed out.", attentionCharacters),
    };
  }
  return undefined;
}

function missingSteerObservation(
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
  if (missingSteerObservation(details, observations)) {
    return { state: "degraded", reason: "observation-gap" };
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
  if (details.staticNode?.kind === "agent") {
    return createAgentActivityProjector(observations)({
      status: state.status,
      updatedAt: state.finishedAt ?? details.items.at(-1)?.updatedAt ?? run.updatedAt,
      ...(attempt ? { attemptId: attempt.attemptId, attemptNo: attempt.attemptNo } : {}),
    })?.current;
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

export function inspectionExcerpt(value: string, limit: number, direction: "head" | "tail" = "head"): RunInspectionExcerpt {
  return excerpt(value, limit, direction);
}

function visibleTailInspectionExcerpt(value: RunInspectionExcerpt, limit: number): string {
  if (limit <= 0) return "";
  const normalized = normalizeSummary(value.text);
  const characters = Array.from(normalized);
  if (value.truncated) {
    const budget = limit - 1;
    return `…${budget === 0 ? "" : characters.slice(-budget).join("")}`;
  }
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
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
  const normalized = normalizeSummary(value);
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("")}…`;
}

function normalizeSummary(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
