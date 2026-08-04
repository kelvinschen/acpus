import type { AgentObservationInspectionProjection } from "../observations/log.js";
import type { CommittedRuntimeEventRow } from "../hooks/events.js";
import type { ArtifactRecord, RunDetails } from "../store/store.js";
import { deriveOccurrenceRef, occurrenceRefSelector } from "../scheduler/occurrence-ref.js";
import {
  projectRunSnapshot,
  resolveTargetState,
  terminalRun,
} from "./projection.js";
import { createAgentActivityProjector } from "./agent-activity-projection.js";
import {
  projectTargetSummary,
  projectTimeline,
} from "./decision-projection.js";
import { signalBlocksInspectionTarget } from "./signal-boundary.js";
import type { ResolvedTargetState } from "./resolved-target.js";
import type {
  InspectionActivity,
  InspectionAttention,
  InspectionCounts,
  InspectionFailure,
  InspectionProgress,
  InspectionPulse,
  InspectionRun,
  InspectionSubject,
  InspectionTreeEntry,
  InspectionView,
  InspectionVisibleState,
  RunInspectionItem,
  TimelineEntry,
} from "./types.js";
import type { WorkflowIR } from "@acpus/core/ir";

/** Maps the legacy private projections to the one public coherent document. */
export function projectInspectionRunView(input: {
  ir: WorkflowIR;
  run: RunDetails;
  observations?: AgentObservationInspectionProjection;
}): Extract<InspectionView, { kind: "run" }> {
  const snapshot = projectRunSnapshot({ ir: input.ir, run: input.run });
  const projectAgentActivity = createAgentActivityProjector(input.observations);
  return {
    kind: "run",
    run: inspectionRun(input.run, snapshot.run.failure),
    counts: counts(snapshot.counts),
    tree: projectTree(snapshot.items, input.run, projectAgentActivity, true),
    ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
  };
}

/** Builds the pulse-free run tree used only for incremental decision changes. */
export function projectInspectionRunDecisionView(input: {
  ir: WorkflowIR;
  run: RunDetails;
}): Extract<InspectionView, { kind: "run" }> {
  const snapshot = projectRunSnapshot({ ir: input.ir, run: input.run });
  return {
    kind: "run",
    run: inspectionRun(input.run, snapshot.run.failure),
    counts: counts(snapshot.counts),
    tree: projectTree(snapshot.items, input.run, createAgentActivityProjector(), false),
    ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
  };
}

export function resolveInspectionDetails(input: {
  ir: WorkflowIR;
  run: RunDetails;
  artifacts: ArtifactRecord[];
  target: string;
}): ResolvedTargetState | undefined {
  return resolveTargetState(input);
}

export function projectInspectionTargetSummaryView(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  observations?: AgentObservationInspectionProjection;
}): Extract<InspectionView, { kind: "target"; detail: "summary" }> {
  const document = projectTargetSummary({
    run: input.run,
    details: input.details,
    ...(input.observations ? { observations: input.observations } : {}),
  });
  const subject = subjectFromDetails(input.details);
  const attention = attentionFromSummary(document.attention, input.run, input.details, subject);
  return {
    kind: "target",
    detail: "summary",
    run: { id: input.run.id, status: input.run.status },
    subject,
    state: visibleState(document.state, input.details.summary.failure),
    ...(document.pulse ? { pulse: pulse(document.pulse) } : {}),
    ...(attention ? { attention } : {}),
    ...(document.visibility ? { visibility: { ...document.visibility } } : {}),
    ...(document.occurrence ? { occurrences: counts(document.occurrence.counts) } : {}),
  };
}

export function projectInspectionTargetTimelineView(input: {
  run: RunDetails;
  details: ResolvedTargetState;
  events: readonly CommittedRuntimeEventRow[];
  observations: AgentObservationInspectionProjection;
}): Extract<InspectionView, { kind: "target"; detail: "timeline" }> {
  const document = projectTimeline({
    run: input.run,
    details: input.details,
    events: input.events,
    observations: input.observations,
    limit: 12,
  });
  const subject = subjectFromDetails(input.details);
  return {
    kind: "target",
    detail: "timeline",
    run: { id: input.run.id, status: input.run.status },
    subject,
    state: visibleState(document.state, input.details.summary.failure),
    ...(document.visibility ? { visibility: { ...document.visibility } } : {}),
    ...(document.current ? { current: activity(document.current, input.run, input.details, subject) } : {}),
    recent: document.recent.entries.flatMap(entry => timelineEntry(entry)),
  };
}

function inspectionRun(run: RunDetails, failure?: { origin: InspectionFailure["origin"]; code?: string; message: string }): InspectionRun {
  const end = terminalRun(run.status) ? Date.parse(run.updatedAt) : Date.now();
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    ...(Number.isFinite(end) && Number.isFinite(Date.parse(run.createdAt))
      ? { durationMs: Math.max(0, end - Date.parse(run.createdAt)) }
      : {}),
    ...(run.execution.state ? { liveness: run.execution.state } : {}),
    ...(failure ? { failure: inspectionFailure(failure) } : {}),
    ...(run.fork
      ? {
          fork: {
            sourceRunId: run.fork.sourceRunId,
          },
        }
      : {}),
  };
}

export function boundedInspectionText(value: string, limit = 240): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function projectTree(
  items: readonly RunInspectionItem[],
  run: RunDetails,
  projectAgentActivity: ReturnType<typeof createAgentActivityProjector>,
  includePulse: boolean,
): InspectionTreeEntry[] {
  const byKey = new Map<string, InternalTree>();
  const roots: InternalTree[] = [];
  for (const item of items) {
    const node: InternalTree = { item, entry: treeItem(item, run, projectAgentActivity, includePulse), children: [] };
    byKey.set(item.key, node);
    const parent = item.parentKey ? byKey.get(item.parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return foldTree(pruneTree(roots));
}

type InternalTree = {
  item: RunInspectionItem;
  entry: Extract<InspectionTreeEntry, { type: "item" }>;
  children: InternalTree[];
};

function pruneTree(nodes: readonly InternalTree[]): InternalTree[] {
  return nodes.flatMap(node => {
    if (node.item.scope?.kind === "branch"
      && node.item.scope.ownerKind !== "parallel"
      && node.item.scope.selection === "not_selected") return [];
    const visible = { ...node, children: pruneTree(node.children) };
    if (completedEmptyBranch(visible.item)) return [];
    return collapsibleStructure(visible) ? visible.children : [visible];
  });
}

function completedEmptyBranch(item: RunInspectionItem): boolean {
  return item.status === "completed"
    && item.scope?.kind === "branch"
    && item.scope.empty;
}

function collapsibleStructure(node: InternalTree): boolean {
  const child = node.children[0];
  return node.children.length === 1
    && child !== undefined
    && (node.item.scope?.kind === "branch" || node.item.kind === "if" || node.item.kind === "switch")
    && node.item.status === child.item.status
    && node.entry.attention === undefined
    && node.entry.state.failure === undefined
    && node.entry.progress === undefined
    && node.entry.pulse === undefined;
}

function treeItem(
  item: RunInspectionItem,
  run: RunDetails,
  projectAgentActivity: ReturnType<typeof createAgentActivityProjector>,
  includePulse: boolean,
): Extract<InspectionTreeEntry, { type: "item" }> {
  const selector = item.ref
    ? item.attemptNo === undefined ? item.ref : occurrenceRefSelector(item.ref as `@${string}`, item.attemptNo)
    : item.nodeId;
  const attention = itemAttention(item, selector, run);
  const elapsed = terminalItemStatus(item.status) ? duration(item.startedAt, item.finishedAt) : undefined;
  const pulse = includePulse ? itemPulse(item, run.updatedAt, projectAgentActivity) : undefined;
  return {
    type: "item",
    subject: {
      label: item.label,
      kind: item.kind,
      ...(selector === undefined ? {} : { selector }),
    },
    state: visibleState({
      status: item.status,
      ...(elapsed === undefined ? {} : { durationMs: elapsed }),
    }, item.failure),
    ...(item.composite?.counts ? { progress: progress(item.composite.counts) } : {}),
    ...(pulse ? { pulse } : {}),
    ...(attention ? { attention } : {}),
    children: [],
  };
}

function foldTree(nodes: readonly InternalTree[]): InspectionTreeEntry[] {
  const visible = nodes.map(node => ({
    ...node,
    entry: { ...node.entry, children: foldTree(node.children) },
  }));
  const result: InspectionTreeEntry[] = [];
  for (let index = 0; index < visible.length;) {
    const first = visible[index]!;
    const scope = repeatScope(first.item);
    if (!scope || treeAttention(first.entry)) {
      result.push(first.entry);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < visible.length
      && sameRepeatedScope(repeatScope(visible[end - 1]!.item)!, repeatScope(visible[end]!.item))
      && equivalentRepeated(first.entry, visible[end]!.entry)) end += 1;
    if (end - index < 2) {
      result.push(first.entry);
      index += 1;
      continue;
    }
    const last = visible[end - 1]!;
    result.push({
      type: "fold",
      scope: scope.kind,
      range: { start: scope.value, end: repeatScope(last.item)!.value },
      count: end - index,
      state: foldState(first.entry.state),
      children: removeRepeatIdentity(first.entry.children),
    });
    index = end;
  }
  return result;
}

function repeatScope(item: RunInspectionItem): { kind: "fanout-items" | "loop-rounds"; value: number } | undefined {
  if (item.scope?.kind === "fanout_item") return { kind: "fanout-items", value: item.scope.itemIndex };
  if (item.scope?.kind === "loop_iteration") return { kind: "loop-rounds", value: item.scope.round };
  return undefined;
}

function terminalItemStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "not_selected";
}

function sameRepeatedScope(
  left: { kind: "fanout-items" | "loop-rounds"; value: number },
  right: { kind: "fanout-items" | "loop-rounds"; value: number } | undefined,
): boolean {
  return right?.kind === left.kind && right.value === left.value + 1;
}

function equivalentRepeated(left: InspectionTreeEntry, right: InspectionTreeEntry): boolean {
  return JSON.stringify(stripRepeatIdentity(left, true)) === JSON.stringify(stripRepeatIdentity(right, true));
}

function treeAttention(entry: InspectionTreeEntry): boolean {
  return (entry.type === "item" && entry.attention !== undefined)
    || entry.children.some(treeAttention);
}

function stripRepeatIdentity(entry: InspectionTreeEntry, root = false): unknown {
  if (entry.type === "fold") return {
    type: "fold",
    scope: entry.scope,
    range: root ? undefined : entry.range,
    count: root ? undefined : entry.count,
    state: foldState(entry.state),
    children: entry.children.map(child => stripRepeatIdentity(child)),
  };
  return {
    type: "item",
    subject: root ? { kind: entry.subject.kind } : { label: entry.subject.label, kind: entry.subject.kind },
    state: foldState(entry.state),
    ...(entry.progress ? { progress: entry.progress } : {}),
    ...(entry.pulse ? { pulse: entry.pulse } : {}),
    ...(entry.attention ? { attention: entry.attention } : {}),
    children: entry.children.map(child => stripRepeatIdentity(child)),
  };
}

function foldState(state: InspectionVisibleState): Omit<InspectionVisibleState, "durationMs"> {
  const { durationMs: _durationMs, ...visible } = state;
  return visible;
}

function removeRepeatIdentity(entries: readonly InspectionTreeEntry[]): InspectionTreeEntry[] {
  return entries.map(entry => entry.type === "fold"
    ? { ...entry, state: foldState(entry.state), children: removeRepeatIdentity(entry.children) }
    : {
        ...entry,
        subject: { label: entry.subject.label, kind: entry.subject.kind },
        state: foldState(entry.state),
        children: removeRepeatIdentity(entry.children),
      });
}

function itemPulse(
  item: RunInspectionItem,
  runUpdatedAt: string,
  projectAgentActivity: ReturnType<typeof createAgentActivityProjector>,
): InspectionPulse | undefined {
  if (!item.agent) return undefined;
  const activity = projectAgentActivity({
    status: item.status,
    updatedAt: item.finishedAt ?? item.updatedAt ?? runUpdatedAt,
    ...(item.attemptId ? { attemptId: item.attemptId } : {}),
    ...(item.attemptNo === undefined ? {} : { attemptNo: item.attemptNo }),
  });
  if (!activity) return undefined;
  const tool = activity.current?.tools?.active.at(-1);
  return {
    phase: activity.phase,
    ...(activity.turn === undefined ? {} : { turn: activity.turn }),
    ...(tool
      ? { headline: boundedInspectionText(`${tool.name}${tool.status ? ` ${tool.status}` : ""}`) }
      : {}),
  };
}

function itemAttention(item: RunInspectionItem, selector: string | undefined, run: RunDetails): InspectionAttention | undefined {
  if (item.status === "failed") return { kind: "failure", summary: boundedInspectionText(item.failure?.message ?? "Target failed.") };
  if (item.status === "timed_out") return { kind: "timed-out", summary: boundedInspectionText(item.failure?.message ?? "Target timed out.") };
  if (item.status === "awaiting" && item.signal && selector && signalBlocksInspectionTarget(run, item.nodeKey ?? item.signal.target)) {
    return {
      kind: "awaiting-input",
      summary: boundedInspectionText(item.signal.promptPreview ?? "Input is required."),
      signal: selector,
      ...(item.signal.promptPreview ? { prompt: boundedInspectionText(item.signal.promptPreview) } : {}),
      ...(item.signal.schemaSummary ? { expected: boundedInspectionText(item.signal.schemaSummary) } : {}),
    };
  }
  return undefined;
}

function subjectFromDetails(details: ResolvedTargetState): InspectionSubject {
  const attempt = details.summary.latestAttempt;
  const selector = details.target.ref
    ? occurrenceRefSelector(details.target.ref as `@${string}`, details.target.kind === "attempt" ? attempt?.attemptNo : undefined)
    : details.target.kind === "static-node" ? details.target.id : undefined;
  const item = attempt
    ? details.items.find(candidate => candidate.attemptId === attempt.attemptId)
    : details.items.find(candidate => candidate.nodeKey === details.summary.nodeKey || candidate.frameKey === details.summary.frameKey)
      ?? details.items[0];
  return {
    label: item?.label ?? details.staticNode?.nodeId ?? details.target.id,
    kind: details.staticNode?.kind ?? item?.kind ?? "node",
    ...(selector === undefined ? {} : { selector }),
  };
}

function attentionFromSummary(
  attention: { code: "terminal_failure" | "timed_out" | "awaiting_input"; summary: string } | undefined,
  run: RunDetails,
  details: ResolvedTargetState,
  subject: InspectionSubject,
): InspectionAttention | undefined {
  if (!attention) return undefined;
  if (attention.code === "terminal_failure") return { kind: "failure", summary: boundedInspectionText(attention.summary) };
  if (attention.code === "timed_out") return { kind: "timed-out", summary: boundedInspectionText(attention.summary) };
  const signal = signalSelector(run, details, subject);
  return {
    kind: "awaiting-input",
    summary: boundedInspectionText(attention.summary),
    signal,
    ...(details.summary.signal?.promptPreview ? { prompt: boundedInspectionText(details.summary.signal.promptPreview) } : {}),
    ...(details.summary.signal?.schemaSummary ? { expected: boundedInspectionText(details.summary.signal.schemaSummary) } : {}),
  };
}

function activity(
  current: import("./types.js").RunInspectionCurrentActivity,
  run: RunDetails,
  details: ResolvedTargetState,
  subject: InspectionSubject,
): InspectionActivity {
  if (current.kind === "signal") {
    return {
      kind: "signal",
      phase: "awaiting",
      signal: signalSelector(run, details, subject),
      ...(current.prompt ? { prompt: boundedInspectionText(current.prompt.text) } : {}),
      ...(current.schemaSummary ? { expected: boundedInspectionText(current.schemaSummary) } : {}),
    };
  }
  if (current.kind === "agent") {
    const headline = current.tools?.active.at(-1)?.name
      ?? current.intent?.excerpt.text
      ?? current.response?.text;
    return {
      kind: "agent",
      phase: current.phase,
      ...(current.turn === undefined ? {} : { turn: current.turn }),
      ...(headline ? { headline: boundedInspectionText(headline) } : {}),
    };
  }
  return {
    kind: current.kind,
    phase: current.phase,
    ...(current.message ? { headline: boundedInspectionText(current.message) } : {}),
  };
}

function signalSelector(run: RunDetails, details: ResolvedTargetState, subject: InspectionSubject): string {
  const wait = (run.dynamic?.signalWaits ?? []).find(candidate => candidate.status === "awaiting"
    && (details.signalWaits.some(selected => selected.nodeKey === candidate.nodeKey)
      || details.target.kind === "static-node" && candidate.nodeId === details.target.id));
  const instance = wait
    ? run.dynamic?.nodeInstances.find(candidate => candidate.nodeKey === wait.nodeKey)
    : undefined;
  if (instance?.instancePath) return deriveOccurrenceRef(instance.instancePath);
  if (details.target.ref) return details.target.ref;
  return subject.selector ?? details.summary.signal?.target ?? details.target.id;
}

function timelineEntry(entry: import("./types.js").RunInspectionTimelineEntry): TimelineEntry[] {
  if (entry.kind === "activity") return [{
    kind: "activity",
    at: entry.at,
    channel: entry.channel,
    ...(entry.attemptNo === undefined ? {} : { attempt: entry.attemptNo }),
    ...(entry.turn === undefined ? {} : { turn: entry.turn }),
    summary: boundedInspectionText(entry.tool?.name ?? entry.summary.text),
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

function transitionAction(action: import("./types.js").RunInspectionChange["action"]): Extract<TimelineEntry, { kind: "transition" }>["action"] | undefined {
  if (action === "started" || action === "awaiting" || action === "completed" || action === "failed" || action === "timed_out" || action === "cancelled") return action === "timed_out" ? "timed-out" : action;
  if (action === "retrying") return "retry";
  if (action === "steered") return "steer";
  if (action === "resumed") return "resumed";
  return undefined;
}

function pulse(value: import("./types.js").RunInspectionPulse): InspectionPulse {
  return {
    phase: value.phase,
    ...(value.turn === undefined ? {} : { turn: value.turn }),
    ...(value.headline ? { headline: boundedInspectionText(value.headline) } : {}),
  };
}

function visibleState(
  state: { status: string; durationMs?: number },
  failure?: { origin: InspectionFailure["origin"]; code?: string; message: string },
): InspectionVisibleState {
  return {
    status: state.status as InspectionVisibleState["status"],
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
    ...(failure ? { failure: inspectionFailure(failure) } : {}),
  };
}

function inspectionFailure(value: { origin: InspectionFailure["origin"]; code?: string; message: string }): InspectionFailure {
  return {
    origin: value.origin,
    ...(value.code ? { code: value.code } : {}),
    message: boundedInspectionText(value.message),
  };
}

function counts(value: import("./types.js").RunInspectionStatusCounts): InspectionCounts {
  return { ...value };
}

function progress(value: import("./types.js").RunInspectionStatusCounts): InspectionProgress {
  return { completed: value.completed ?? 0, total: value.total };
}

function duration(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}
