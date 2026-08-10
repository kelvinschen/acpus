import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { AgentObservationInspectionProjection, AgentObservationLog } from "../observations/log.js";
import {
  openExistingRuntimeStore,
  withRunInspectionSnapshot,
  type RuntimeStore,
  type RunInspectionStoreRead,
} from "../store/store.js";
import { inspectRuntimeStore } from "../runtime-store-lifecycle.js";
import { findArchivedRun } from "../runtime-history.js";
import {
  planCancelControl,
  planRetryControl,
  settleRetryControlSnapshot,
} from "../scheduler/control-plan.js";
import { steerControlTargets } from "../scheduler/steer-plan.js";
import {
  throwSchedulerStoreResult,
  type SchedulerSnapshot,
} from "../scheduler/store-port.js";
import {
  inspectionSubject,
  inspectionTargetState,
  projectInspectionTargetSummaryView,
  projectInspectionTargetTimelineView,
  targetAttemptId,
} from "./decision-projection.js";
import { projectAgentExecution } from "./agent-execution-projection.js";
import {
  inspectionStaticNodes,
  projectInspectionRunDecisionView,
  projectInspectionRunView,
  resolveTargetState,
  terminalRun,
} from "./projection.js";
import { resolveInspectionTarget } from "./target-resolution.js";
import { deriveOccurrenceRef } from "../scheduler/occurrence-ref.js";
import { projectInspectionForensicsView } from "./forensics-projection.js";
import type { ResolvedTargetState } from "./resolved-target.js";
import type {
  InspectAgentExecutionQuery,
  InspectNodeQuery,
  InspectTargetArtifactsQuery,
  RunInspectionAgentExecutionDocument,
  RunInspectionNodeDocument,
  RunInspectionTargetArtifactsDocument,
  RunInspectionError,
  RunInspectionControl,
  InspectionCandidates,
  InspectionChange,
  InspectionError,
  InspectionObservation,
  InspectionRead,
  InspectionVisibleReason,
  InspectionView,
  InspectionViewQuery,
  ObserveInspectionQuery,
  RuntimeStoreRepairRequiredInspectionError,
  RuntimeStoreUnsupportedInspectionError,
} from "./types.js";

const inspectionObserveReadDelayMs = 1_000;
const inspectionTimelineEntryLimit = 12;
const inspectionTimelineEventLimit = 48;

/** Reads the one coherent public inspection document. */
export function readInspection(
  cwd: string,
  view: InspectionViewQuery,
): ResultAsync<InspectionRead, InspectionError> {
  const invalid = view.kind === "target" ? validateCoherentTarget(view.target) : undefined;
  if (invalid) return invalidCoherentInspection(invalid);
  return new ResultAsync((async () => {
    const active = await withCoherentInspectionRun(cwd, view.runId, state => readCoherentView(state, view));
    if (active.isOk() || active.error.type !== "run-not-found") return active;
    return archivedInspection(cwd, view);
  })());
}

/**
 * Observes durable semantic state.  The initial projection is immediate; later
 * cycles first read only the durable change token and build a view only when it
 * changed.
 */
export async function* observeInspection(
  cwd: string,
  query: ObserveInspectionQuery,
): AsyncIterable<Result<InspectionObservation, InspectionError>> {
  const invalid = validateObserveInspectionQuery(query);
  if (invalid) {
    yield err(invalid);
    return;
  }
  let cycle = await readCoherentCycle(cwd, query.view);
  if (cycle.isErr()) {
    if (cycle.error.type === "run-not-found") {
      const archived = await archivedInspection(cwd, query.view);
      if (archived.isOk() && archived.value.kind === "archived-run") {
        yield err(archivedDetailUnavailable(query.view.runId));
        return;
      }
      if (archived.isErr()) {
        yield err(archived.error);
        return;
      }
    }
    yield err(cycle.error);
    return;
  }
  const initialClose = observationCloseReason(cycle.value, query.until);
  if (initialClose) {
    yield ok({ kind: "closed", reason: initialClose, view: cycle.value.view });
    return;
  }
  yield ok({ kind: "attached", view: cycle.value.view });
  let previous = cycle.value;

  while (!query.signal?.aborted) {
    await delay(inspectionObserveReadDelayMs, query.signal);
    if (query.signal?.aborted) return;
    const token = await readCoherentToken(cwd, query.view.runId);
    if (token.isErr()) {
      yield err(token.error);
      return;
    }
    if (sameInspectionToken(previous.token, token.value)) continue;
    cycle = await readCoherentCycle(cwd, query.view, previous.pinnedTarget, previous.token.eventSequence);
    if (cycle.isErr()) {
      yield err(cycle.error);
      return;
    }
    const close = observationCloseReason(cycle.value, query.until);
    if (close) {
      yield ok({ kind: "closed", reason: close, view: cycle.value.view });
      return;
    }
    const changes = inspectionChanges(previous.changeView, cycle.value.changeView, cycle.value.events, cycle.value.run);
    const timeline = timelineChanges(previous.view, cycle.value.view, changes);
    if (changes.length > 0 || timeline?.length) {
      yield ok({
        kind: "update",
        changes,
        ...(timeline?.length ? { timeline } : {}),
      });
    }
    previous = cycle.value;
  }
}

type CoherentInspectionRun = {
  store: RuntimeStore;
  read: RunInspectionStoreRead;
  run: NonNullable<RunInspectionStoreRead["run"]>;
  frozen: NonNullable<RunInspectionStoreRead["frozen"]>;
};

type CoherentCycle = {
  view: InspectionView;
  changeView: InspectionView;
  token: RunInspectionStoreRead["cursor"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  pinnedTarget?: string;
  events: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>;
};

type CoherentTarget =
  | { kind: "candidates"; candidates: InspectionCandidates }
  | { kind: "resolved"; target: string; details: ResolvedTargetState };

function invalidCoherentInspection<T>(error: InspectionError): ResultAsync<T, InspectionError> {
  return new ResultAsync(Promise.resolve(err(error)));
}

async function archivedInspection(
  cwd: string,
  view: InspectionViewQuery,
): Promise<Result<InspectionRead, InspectionError>> {
  try {
    const lookup = await findArchivedRun(cwd, view.runId);
    if (lookup.kind === "not-found") {
      return err({ type: "run-not-found", runId: view.runId, message: `Run '${view.runId}' was not found.` });
    }
    if (lookup.kind === "unavailable") {
      return err({
        type: "archived-run-lookup-unavailable",
        runId: view.runId,
        message: lookup.message,
      });
    }
    if (view.kind !== "run") return err(archivedDetailUnavailable(view.runId));
    return ok({ kind: "archived-run", run: lookup.run });
  } catch (error) {
    return err({
      type: "read-failed",
      runId: view.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function archivedDetailUnavailable(runId: string): Extract<InspectionError, { type: "archived-run-detail-unavailable" }> {
  return {
    type: "archived-run-detail-unavailable",
    runId,
    command: `acpus runs inspect ${runId}`,
    message: `Archived run '${runId}' only has a summary. Run 'acpus runs inspect ${runId}'.`,
  };
}

function withCoherentInspectionRun<T>(
  cwd: string,
  runId: string,
  project: (state: CoherentInspectionRun) => Result<T, InspectionError> | Promise<Result<T, InspectionError>>,
): ResultAsync<T, InspectionError> {
  return new ResultAsync((async () => {
    let store: RuntimeStore | undefined;
    try {
      const readiness = await runtimeStoreReadiness(cwd, runId);
      if (readiness) return err(readiness);
      store = await openExistingRuntimeStore(cwd);
      if (!store) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
      return await withRunInspectionSnapshot(store, async () => {
        const read = store!.readRunInspection(runId);
        if (!read.run) return err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
        if (!read.frozen) throw new Error(`Frozen workflow for run '${runId}' was not found.`);
        return await project({ store: store!, read, run: read.run, frozen: read.frozen });
      });
    } catch {
      return err(coherentInspectionError(runId));
    } finally {
      store?.close();
    }
  })());
}

async function readCoherentCycle(
  cwd: string,
  view: InspectionViewQuery,
  pinnedTarget?: string,
  afterEventSequence?: number,
): Promise<Result<CoherentCycle, InspectionError>> {
  return withCoherentInspectionRun(cwd, view.runId, async state => {
    const read = await readCoherentView(state, view, pinnedTarget);
    if (read.isErr()) return err(read.error);
    if (read.value.kind === "candidates") {
      return err({
        type: "target-ambiguous",
        runId: view.runId,
        target: view.kind === "target" ? view.target : "root",
        candidates: read.value,
        message: "A blocking inspection needs one exact target selector.",
      });
    }
    if (read.value.kind === "archived-run") throw new Error("Archived runs are not observable.");
    const resolved = view.kind === "target"
      ? resolveCoherentTarget(state, view.target, pinnedTarget)
      : undefined;
    if (resolved?.isErr()) return err(resolved.error);
    if (view.kind === "target" && resolved?.isOk() && resolved.value.kind === "candidates") {
      return err({
        type: "target-ambiguous",
        runId: view.runId,
        target: view.target,
        candidates: resolved.value.candidates,
        message: "A blocking inspection needs one exact target selector.",
      });
    }
    return ok({
      view: read.value,
      changeView: read.value.kind === "run"
        ? projectInspectionRunDecisionView({ ir: state.frozen.ir, run: state.run })
        : read.value,
      token: state.read.cursor,
      run: state.run,
      events: afterEventSequence === undefined
        ? []
        : state.store.getCommittedRuntimeEventsAfter(state.run.id, afterEventSequence),
      ...(resolved?.isOk() && resolved.value.kind === "resolved"
        ? { pinnedTarget: resolved.value.target }
        : {}),
    });
  });
}

async function readCoherentView(
  state: CoherentInspectionRun,
  view: InspectionViewQuery,
  pinnedTarget?: string,
): Promise<Result<InspectionRead, InspectionError>> {
  if (view.kind === "run") {
    const observations = await coherentRunObservations(state);
    return ok(projectInspectionRunView({
      ir: state.frozen.ir,
      run: state.run,
      ...(observations ? { observations } : {}),
    }));
  }
  const resolved = resolveCoherentTarget(state, view.target, pinnedTarget);
  if (resolved.isErr()) return err(resolved.error);
  if (resolved.value.kind === "candidates") return ok(resolved.value.candidates);
  const details = resolved.value.details;
  if (view.detail === "summary") {
    const observations = await coherentTargetObservations(state, details);
    const projected = projectInspectionTargetSummaryView({
      run: state.run,
      details,
      ...(observations ? { observations } : {}),
    });
    const acp = acpSilence(details);
    return ok({
      ...projected,
      ...(acp === undefined ? {} : { acp }),
    });
  }
  if (view.detail === "forensics") {
    return ok(projectInspectionForensicsView({
      frozen: state.frozen,
      run: state.run,
      details,
    }));
  }
  const observations = await readRecentTimelineObservations(
    state.store.observationLog,
    state.run.id,
    recentTimelineAttemptIds(details),
  );
  const projected = projectInspectionTargetTimelineView({
    run: state.run,
    details,
    events: state.store.getInspectionTimelineEvents(
      state.run.id,
      inspectionTimelineNodeKeys(state.run, details),
      inspectionTimelineEventLimit,
    ),
    observations,
  });
  return ok(projected);
}

function acpSilence(details: ResolvedTargetState): { silentForMs: number } | undefined {
  if (details.staticNode?.kind !== "agent") return undefined;
  const attemptId = targetAttemptId(details);
  if (!attemptId) return undefined;
  const progress = details.progress
    .filter(candidate => candidate.attemptId === attemptId && candidate.kind === "agent" && candidate.status === "running" && candidate.acpActivityAt !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!progress?.acpActivityAt) return undefined;
  const anchor = Date.parse(progress.acpActivityAt);
  if (!Number.isFinite(anchor)) return undefined;
  return { silentForMs: Math.max(0, Date.now() - anchor) };
}

function resolveCoherentTarget(
  state: CoherentInspectionRun,
  target: string,
  pinnedTarget?: string,
): Result<CoherentTarget, InspectionError> {
  if (pinnedTarget) {
    const details = resolveTargetState({
      ir: state.frozen.ir,
      run: state.run,
      artifacts: state.read.artifacts,
      target: pinnedTarget,
    });
    return details
      ? ok({ kind: "resolved", target: pinnedTarget, details })
      : err({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
  }
  const staticNodes = inspectionStaticNodes(state.frozen.ir);
  if (target !== "root" && !target.startsWith("@")) {
    const internal = state.run.dynamic?.nodeInstances.some(instance => instance.nodeKey === target)
      || state.run.dynamic?.frames.some(frame => frame.frameKey === target)
      || state.run.dynamic?.attempts.some(attempt => attempt.attemptId === target);
    if (internal) {
      return err({ type: "invalid-query", message: "Inspection target must use an authored id, root, or occurrence selector." });
    }
    if (!staticNodes.some(node => node.nodeId === target)) {
      return err({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
    }
  }
  const resolution = resolveInspectionTarget({
    run: state.run,
    staticNodes,
    target,
  });
  if (resolution.kind === "not-found") {
    return err({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
  }
  if (resolution.kind === "ref-collision") {
    return err({ type: "read-failed", runId: state.run.id, message: `Occurrence reference '${target}' could not be resolved safely.` });
  }
  if (resolution.kind === "candidates") {
    return ok({ kind: "candidates", candidates: resolution.candidates });
  }
  const details = resolveTargetState({
    ir: state.frozen.ir,
    run: state.run,
    artifacts: state.read.artifacts,
    target: resolution.target,
  });
  return details
    ? ok({ kind: "resolved", target: resolution.target, details })
    : err({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
}

async function coherentTargetObservations(
  state: CoherentInspectionRun,
  details: ResolvedTargetState,
): Promise<AgentObservationInspectionProjection | undefined> {
  if (details.staticNode?.kind !== "agent") return undefined;
  const attemptId = targetAttemptId(details);
  if (!attemptId) return undefined;
  const result = await state.store.observationLog.readInspectionProjection({
    runId: state.run.id,
    attemptIds: [attemptId],
    entryLimit: 50,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

async function coherentRunObservations(
  state: CoherentInspectionRun,
): Promise<AgentObservationInspectionProjection | undefined> {
  const attemptIds = state.run.dynamic?.attempts
    .filter(attempt => attempt.status === "started")
    .map(attempt => attempt.attemptId) ?? [];
  if (attemptIds.length === 0) return undefined;
  const result = await state.store.observationLog.readInspectionProjection({
    runId: state.run.id,
    attemptIds,
    latestTurnPerAttempt: true,
    includeOlderCount: false,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

async function readCoherentToken(
  cwd: string,
  runId: string,
): Promise<Result<RunInspectionStoreRead["cursor"], InspectionError>> {
  let store: RuntimeStore | undefined;
  try {
    const readiness = await runtimeStoreReadiness(cwd, runId);
    if (readiness) return err(readiness);
    store = await openExistingRuntimeStore(cwd);
    if (!store) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
    const token = store.readRunInspectionToken(runId);
    return token
      ? ok(token)
      : err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
  } catch {
    return err(coherentInspectionError(runId));
  } finally {
    store?.close();
  }
}

function sameInspectionToken(left: RunInspectionStoreRead["cursor"], right: RunInspectionStoreRead["cursor"]): boolean {
  return left.eventSequence === right.eventSequence
    && left.progressVersion === right.progressVersion
    && left.observationVersion === right.observationVersion;
}

function observationCloseReason(
  cycle: CoherentCycle,
  until: ObserveInspectionQuery["until"],
): Extract<InspectionObservation, { kind: "closed" }>["reason"] | undefined {
  if (cycle.view.kind === "run") {
    if (terminalRun(cycle.view.run.status)) return "subject-terminal";
    if (until === "decision-boundary" && cycle.view.run.status === "paused") return "paused";
    if (until === "decision-boundary" && treeAwaitsInput(cycle.view.tree)) return "awaiting-input";
    return undefined;
  }
  if (terminalInspectionState(cycle.view.state.status)) return "subject-terminal";
  if (until === "subject-terminal") return undefined;
  if (cycle.run.status === "paused") return "paused";
  if (cycle.view.detail === "summary" && cycle.view.attention?.kind === "awaiting-input") return "awaiting-input";
  if (cycle.view.detail === "timeline" && cycle.view.current?.kind === "signal") return "awaiting-input";
  return undefined;
}

function treeAwaitsInput(tree: Extract<InspectionView, { kind: "run" }>["tree"]): boolean {
  return tree.some(entry => (entry.type === "item" && entry.attention?.kind === "awaiting-input")
    || treeAwaitsInput(entry.children));
}

function terminalInspectionState(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "not_selected";
}

export function inspectionChanges(
  previous: InspectionView,
  current: InspectionView,
  events: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>,
  run: NonNullable<RunInspectionStoreRead["run"]>,
): InspectionChange[] {
  if (previous.kind !== "run" || current.kind !== "run") {
    if (current.kind !== "target") return [];
    const previousStatus = previous.kind === "target" ? previous.state.status : undefined;
    const reason = inspectionReason(previousStatus, current.state.status, events, current.subject, run);
    const change = targetInspectionChange(current, reason);
    if (previous.kind === "target" && sameSubject(previous.subject, current.subject)
      && sameDecisionChange(targetInspectionChange(previous), change) && !reason) return [];
    return [change];
  }
  const before = flattenInspectionTree(previous.tree);
  const after = flattenInspectionTree(current.tree);
  const changed = [...after.values()].filter(item => {
    const previousItem = before.get(item.id);
    return !sameDecisionChange(previousItem && treeInspectionChange(previousItem), treeInspectionChange(item))
      || inspectionReason(previousItem?.state.status, item.state.status, events, item.subject, run) !== undefined;
  });
  const candidates = changed.filter(item => !progressOnlyAncestor(item, before.get(item.id), changed));
  return candidates
    .filter(item => !coveredByMeaningfulAncestor(item, candidates, before))
    .map(item => {
      const reason = inspectionReason(before.get(item.id)?.state.status, item.state.status, events, item.subject, run);
      return treeInspectionChange(item, reason);
    });
}

function targetInspectionChange(
  view: Extract<InspectionView, { kind: "target" }>,
  reason?: InspectionVisibleReason,
): InspectionChange {
  return {
    subject: view.subject,
    state: view.state,
    ...(view.detail === "summary" && view.occurrences ? { occurrences: view.occurrences } : {}),
    ...(view.detail === "summary" && view.attention ? { attention: view.attention } : {}),
    ...(view.detail !== "forensics" && view.visibility ? { visibility: view.visibility } : {}),
    ...(reason ? { reason } : {}),
  };
}

function treeInspectionChange(
  item: FlatInspectionTreeEntry,
  reason?: InspectionVisibleReason,
): InspectionChange {
  return {
    subject: item.subject,
    state: item.state,
    ...(item.progress ? { progress: item.progress } : {}),
    ...(item.attention ? { attention: item.attention } : {}),
    ...(reason ? { reason } : {}),
  };
}

function sameDecisionChange(left: InspectionChange | undefined, right: InspectionChange): boolean {
  if (!left) return false;
  const { subject: _leftSubject, reason: _leftReason, ...leftDecision } = left;
  const { subject: _rightSubject, reason: _rightReason, ...rightDecision } = right;
  return JSON.stringify(leftDecision) === JSON.stringify(rightDecision);
}

function inspectionReason(
  previous: string | undefined,
  current: string,
  events: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>,
  subject: import("./types.js").InspectionSubject,
  run: NonNullable<RunInspectionStoreRead["run"]>,
): InspectionVisibleReason | undefined {
  const relevant = events.filter(event => inspectionEventAffectsSubject(event, subject, run));
  const has = (type: string) => relevant.some(event => event.type === type);
  const requeued = (reason: string) => relevant.some(event => event.type === "instance.requeued" && event.payload.reason === reason);
  if (["failed", "timed_out", "cancelled"].includes(previous ?? "") && !["failed", "timed_out", "cancelled"].includes(current)) {
    if (has("control.agent_steer_requested") || requeued("steered")) return "steer";
    if (requeued("paused")) return "resume";
    if (has("instance.retry_requested") || has("frame.retry_requested") || has("group.member_retry_requested")
      || relevant.some(event => event.type === "attempt.started" && Number(event.payload.attemptNo) > 1)) return "retry";
  }
  if (has("control.agent_steer_requested") || requeued("steered")) return "steer";
  if (requeued("paused")) return "resume";
  if (relevant.some(event => event.type === "attempt.superseded")) return "superseded";
  const cancellation = relevant.find(event => event.type.endsWith(".cancelled") && typeof event.payload.cancelReason === "string")?.payload.cancelReason;
  if (cancellation === "operator_cancelled") return "operator-cancelled";
  if (cancellation === "parent_failed") return "parent-cancelled";
  if (cancellation === "race_lost") return "race-selected";
  if (cancellation === "quorum_reached") return "quorum-selected";
  if (has("branch.decided")) return "branch-selected";
  return undefined;
}

function inspectionEventAffectsSubject(
  event: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>[number],
  subject: import("./types.js").InspectionSubject,
  run: NonNullable<RunInspectionStoreRead["run"]>,
): boolean {
  if (!subject.selector) return false;
  return inspectionEventSelectors(event, run).has(subject.selector);
}

function inspectionEventSelectors(
  event: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>[number],
  run: NonNullable<RunInspectionStoreRead["run"]>,
): Set<string> {
  const selectors = new Set<string>();
  const nodeKeys = new Set<string>();
  const attemptIds = new Set<string>();
  const frameKeys = new Set<string>();
  const groupKeys = new Set<string>();
  const payloadString = (key: string) => typeof event.payload[key] === "string" ? event.payload[key] : undefined;
  const add = (value: string | undefined) => { if (value) selectors.add(value); };
  const addNodeKey = (value: string | undefined) => { if (value) nodeKeys.add(value); };
  const addAttempt = (value: string | undefined) => { if (value) attemptIds.add(value); };
  const addFrame = (value: string | undefined) => { if (value) frameKeys.add(value); };
  const addGroup = (value: string | undefined) => { if (value) groupKeys.add(value); };
  add(payloadString("nodeId"));
  addNodeKey(event.nodeKey);
  addNodeKey(payloadString("nodeKey"));
  addAttempt(payloadString("attemptId"));
  addAttempt(payloadString("fencedAttemptId"));
  addAttempt(payloadString("acceptedAttemptId"));
  addFrame(payloadString("frameKey"));
  addGroup(payloadString("groupKey"));
  const memberKey = payloadString("memberKey");
  if (memberKey) {
    const member = run.dynamic?.groupMembers.find(candidate => candidate.memberKey === memberKey);
    addGroup(member?.groupKey);
  }
  for (const attemptId of attemptIds) {
    const attempt = run.dynamic?.attempts.find(candidate => candidate.attemptId === attemptId);
    addNodeKey(attempt?.nodeKey);
  }
  for (const frameKey of frameKeys) {
    const frame = run.dynamic?.frames.find(candidate => candidate.frameKey === frameKey);
    add(frame?.nodeId);
    if (frame?.instancePath) add(deriveOccurrenceRef(frame.instancePath));
    addNodeKey(frame?.nodeKey);
  }
  for (const groupKey of groupKeys) addNodeKey(run.dynamic?.groups.find(candidate => candidate.groupKey === groupKey)?.nodeKey);
  for (const nodeKey of nodeKeys) {
    const instance = run.dynamic?.nodeInstances.find(candidate => candidate.nodeKey === nodeKey);
    add(instance?.nodeId);
    if (instance?.instancePath) {
      const ref = deriveOccurrenceRef(instance.instancePath);
      add(ref);
      for (const attempt of run.dynamic?.attempts.filter(candidate => candidate.nodeKey === nodeKey) ?? []) {
        add(`${ref}#${attempt.attemptNo}`);
      }
    }
  }
  return selectors;
}

function timelineChanges(
  previous: InspectionView,
  current: InspectionView,
  changes: readonly InspectionChange[],
): import("./types.js").TimelineEntry[] | undefined {
  if (previous.kind !== "target" || current.kind !== "target" || current.detail !== "timeline") return undefined;
  const before = new Set(previous.detail === "timeline" ? previous.recent.map(entry => JSON.stringify(entry)) : []);
  const stateKeys = new Set(changes.map(change => `${change.state.status}:${change.subject.label}`));
  const entries = current.recent.filter(entry => !before.has(JSON.stringify(entry)))
    .filter(entry => entry.kind !== "transition" || !stateKeys.has(`${entry.status}:${current.subject.label}`));
  return entries;
}

type FlatInspectionTreeEntry = {
  id: string;
  subject: import("./types.js").InspectionSubject;
  state: import("./types.js").InspectionVisibleState;
  progress?: import("./types.js").InspectionProgress;
  attention?: import("./types.js").InspectionAttention;
  ancestors: string[];
};

function flattenInspectionTree(tree: readonly import("./types.js").InspectionTreeEntry[]): Map<string, FlatInspectionTreeEntry> {
  const result = new Map<string, FlatInspectionTreeEntry>();
  const visit = (entries: readonly import("./types.js").InspectionTreeEntry[], parent: string, ancestors: string[]): void => {
    for (const [index, entry] of entries.entries()) {
      const id = entry.type === "item"
        ? entry.subject.selector ?? `${parent}/${entry.subject.kind}:${entry.subject.label}:${index}`
        : `${parent}/fold:${entry.scope}:${entry.range.start}-${entry.range.end}:${index}`;
      const flat: FlatInspectionTreeEntry = entry.type === "item"
        ? {
            id,
            subject: entry.subject,
            state: entry.state,
            ...(entry.progress ? { progress: entry.progress } : {}),
            ...(entry.attention ? { attention: entry.attention } : {}),
            ancestors,
          }
        : {
            id,
            subject: {
              label: entry.scope === "fanout-items"
                ? `items ${entry.range.start}–${entry.range.end}`
                : `rounds ${entry.range.start}–${entry.range.end}`,
              kind: entry.scope,
            },
            state: entry.state,
            progress: {
              completed: entry.state.status === "completed" ? entry.count : 0,
              total: entry.count,
            },
            ancestors,
          };
      result.set(id, flat);
      visit(entry.children, id, [...ancestors, id]);
    }
  };
  visit(tree, "root", []);
  return result;
}

function progressOnlyAncestor(
  item: FlatInspectionTreeEntry,
  previous: FlatInspectionTreeEntry | undefined,
  changed: readonly FlatInspectionTreeEntry[],
): boolean {
  return changed.some(candidate => candidate.ancestors.includes(item.id))
    && item.progress !== undefined
    && previous !== undefined
    && JSON.stringify(nonProgressComparable(previous)) === JSON.stringify(nonProgressComparable(item));
}

function nonProgressComparable(item: FlatInspectionTreeEntry): unknown {
  return {
    state: item.state,
    ...(item.attention ? { attention: item.attention } : {}),
  };
}

function coveredByMeaningfulAncestor(
  item: FlatInspectionTreeEntry,
  candidates: readonly FlatInspectionTreeEntry[],
  before: ReadonlyMap<string, FlatInspectionTreeEntry>,
): boolean {
  return candidates.some(ancestor => ancestor.id !== item.id
    && item.ancestors.includes(ancestor.id)
    && meaningfulNonProgressChange(ancestor, before.get(ancestor.id))
    && sameSemanticState(ancestor.state, item.state));
}

function meaningfulNonProgressChange(item: FlatInspectionTreeEntry, previous: FlatInspectionTreeEntry | undefined): boolean {
  return previous === undefined
    || JSON.stringify(nonProgressComparable(previous)) !== JSON.stringify(nonProgressComparable(item));
}

function sameSemanticState(
  left: import("./types.js").InspectionVisibleState,
  right: import("./types.js").InspectionVisibleState,
): boolean {
  return left.status === right.status && JSON.stringify(left.failure) === JSON.stringify(right.failure);
}

function sameSubject(left: import("./types.js").InspectionSubject, right: import("./types.js").InspectionSubject): boolean {
  return left.label === right.label && left.selector === right.selector;
}

function validateObserveInspectionQuery(query: ObserveInspectionQuery): InspectionError | undefined {
  const view = query.view as InspectionViewQuery;
  if (view.kind === "target" && view.detail === "forensics") {
    return { type: "invalid-query", message: "Forensics inspection is one-shot and cannot be observed." };
  }
  return query.view.kind === "target" ? validateCoherentTarget(query.view.target) : undefined;
}

function validateCoherentTarget(target: string): InspectionError | undefined {
  if (target.trim().length === 0) return { type: "invalid-query", message: "Inspection target must not be blank." };
  if (target.includes("~") || target.includes("#") && !target.startsWith("@")) {
    return { type: "invalid-query", message: "Inspection target must use an authored id, root, or occurrence selector." };
  }
  if (target.startsWith("@") && !/^@[0-9a-f]{12}(?:#[1-9]\d*)?$/.test(target)) {
    return { type: "invalid-query", message: "Inspection occurrence selector is malformed." };
  }
  return undefined;
}

function coherentInspectionError(runId: string): InspectionError {
  return { type: "read-failed", runId, message: "Inspection could not be read." };
}

export function inspectNode(cwd: string, query: InspectNodeQuery): ResultAsync<RunInspectionNodeDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, state => {
    const resolved = resolveTarget(state, query.target, true);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.candidates));
    const details = resolved.value.details;
    return ok({
      schemaVersion: 2,
      kind: "node",
      run: details.run,
      subject: inspectionSubject(details),
      state: inspectionTargetState(details),
      summary: details.summary,
      availableControls: details.availableControls,
      artifacts: details.artifacts,
    });
  });
}

export function inspectAgentExecution(
  cwd: string,
  query: InspectAgentExecutionQuery,
): ResultAsync<RunInspectionAgentExecutionDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, async state => {
    const resolved = resolveTarget(state, query.target);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.candidates));
    const attemptId = resolved.value.details.staticNode?.kind === "agent"
      ? targetAttemptId(resolved.value.details)
      : undefined;
    const observationResult = attemptId === undefined
      ? undefined
      : await state.store.observationLog.readInspectionProjection({
          runId: query.runId,
          attemptIds: [attemptId],
          entryLimit: 50,
          latestTurnPerAttempt: true,
        });
    if (observationResult?.isErr()) throw observationResult.error;
    return ok(projectAgentExecution({
      details: resolved.value.details,
      ...(observationResult?.isOk() ? { observations: observationResult.value } : {}),
    }));
  });
}

export function inspectTargetArtifacts(
  cwd: string,
  query: InspectTargetArtifactsQuery,
): ResultAsync<RunInspectionTargetArtifactsDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, state => {
    const resolved = resolveTarget(state, query.target);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.candidates));
    const details = resolved.value.details;
    return ok({
      schemaVersion: 2,
      kind: "artifacts",
      run: { id: details.run.id, status: details.run.status, updatedAt: details.run.updatedAt },
      subject: inspectionSubject(details),
      artifacts: details.artifacts,
    });
  });
}

type InspectionRun = {
  store: RuntimeStore;
  read: RunInspectionStoreRead;
  run: NonNullable<RunInspectionStoreRead["run"]>;
  frozen: NonNullable<RunInspectionStoreRead["frozen"]>;
  schedulerSnapshot: () => SchedulerSnapshot;
  retrySchedulerSnapshot: () => SchedulerSnapshot;
};

type ResolvedInspectionTarget =
  | { kind: "resolved"; target: string; details: ResolvedTargetState }
  | { kind: "candidates"; candidates: InspectionCandidates };

function invalidInspection<T>(error: RunInspectionError): ResultAsync<T, RunInspectionError> {
  return new ResultAsync(Promise.resolve(err(error)));
}

function withInspectionRun<T>(
  cwd: string,
  runId: string,
  project: (state: InspectionRun) => Result<T, RunInspectionError> | Promise<Result<T, RunInspectionError>>,
): ResultAsync<T, RunInspectionError> {
  return new ResultAsync((async () => {
    let store: RuntimeStore | undefined;
    try {
      const readiness = await runtimeStoreReadiness(cwd, runId);
      if (readiness) return err(readiness);
      const runtimeStore = await openExistingRuntimeStore(cwd);
      if (!runtimeStore) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
      store = runtimeStore;
      return await withRunInspectionSnapshot(runtimeStore, async () => {
        const read = runtimeStore.readRunInspection(runId);
        if (!read.run) {
          return err({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
        }
        if (!read.frozen) throw new Error(`Frozen workflow for run '${runId}' was not found.`);
        let scheduler: SchedulerSnapshot | undefined;
        const schedulerSnapshot = () => {
          scheduler ??= throwSchedulerStoreResult(runtimeStore.scheduler.tryLoadRunSnapshot(runId));
          return scheduler;
        };
        let retryScheduler: SchedulerSnapshot | undefined;
        const retrySchedulerSnapshot = () => {
          retryScheduler ??= settleRetryControlSnapshot({
            frozen: read.frozen!,
            snapshot: schedulerSnapshot(),
            now: new Date(),
          }).snapshot;
          return retryScheduler;
        };
        return project({
          store: runtimeStore,
          read,
          run: read.run,
          frozen: read.frozen,
          schedulerSnapshot,
          retrySchedulerSnapshot,
        });
      });
    } catch (error) {
      return err(inspectionError(runId, error));
    } finally {
      store?.close();
    }
  })());
}

function resolveTarget(
  state: InspectionRun,
  target: string,
  includeControls = false,
): Result<ResolvedInspectionTarget, RunInspectionError> {
  const resolution = resolveInspectionTarget({
    run: state.run,
    staticNodes: inspectionStaticNodes(state.frozen.ir),
    target,
  });
  if (resolution.kind === "not-found") return err(targetNotFound(state.run.id, target));
  if (resolution.kind === "ref-collision") {
    return err({
      type: "target-ref-collision",
      runId: state.run.id,
      target,
      candidateKeys: resolution.candidateKeys,
      message: `Occurrence reference '${target}' is not unique in this run; use one of: ${resolution.candidateKeys.join(", ")}.`,
    });
  }
  if (resolution.kind === "candidates") return ok({ kind: "candidates", candidates: resolution.candidates });
  const base = resolveTargetState({
    ir: state.frozen.ir,
    run: state.run,
    artifacts: state.read.artifacts,
    target: resolution.target,
  });
  if (!base) return err(targetNotFound(state.run.id, target));
  const controls = includeControls
    ? targetInspectionControls(state.retrySchedulerSnapshot(), state.schedulerSnapshot(), base, state.frozen)
    : base.availableControls;
  return ok({
    kind: "resolved",
    target: resolution.target,
    details: controls === base.availableControls ? base : { ...base, availableControls: controls },
  });
}

function targetNotFound(runId: string, target: string): RunInspectionError {
  return { type: "target-not-found", runId, target, message: `Run target '${target}' was not found.` };
}

function targetAmbiguous(
  runId: string,
  target: string,
  candidates: InspectionCandidates,
): RunInspectionError {
  return {
    type: "target-ambiguous",
    runId,
    target,
    candidates,
    message: `Run target '${target}' matches multiple occurrences. Select one @ref from the candidate view.`,
  };
}

function targetInspectionControls(
  retrySnapshot: SchedulerSnapshot,
  cancelSnapshot: SchedulerSnapshot,
  details: ResolvedTargetState,
  frozen?: NonNullable<RunInspectionStoreRead["frozen"]>,
): RunInspectionControl[] {
  const selectedAttempt = details.target.kind === "attempt"
    ? details.attempts.find(attempt => attempt.attemptId === details.target.id)
    : undefined;
  if (details.target.kind === "attempt") {
    if (!selectedAttempt) return [];
    const latestAttempt = details.attempts
      .filter(attempt => attempt.nodeKey === selectedAttempt.nodeKey)
      .sort((left, right) => right.attemptNo - left.attemptNo)[0];
    if (latestAttempt?.attemptId !== selectedAttempt.attemptId) return [];
  }
  const target = inspectionControlTarget(details, selectedAttempt);
  if (!target) return [];
  const allowRetry = selectedAttempt === undefined
    || selectedAttempt.status === "failed"
    || selectedAttempt.status === "timed_out";
  const allowCancel = selectedAttempt === undefined
    || selectedAttempt.status === "started";
  const controls: RunInspectionControl[] = [];
  if (allowRetry) {
    const retry = planRetryControl(retrySnapshot, target);
    if (retry.isOk()) controls.push({ type: "retry", target: retry.value.resolvedTarget });
  }
  if (allowCancel) {
    const cancel = planCancelControl(cancelSnapshot, target);
    if (cancel.isOk() && cancel.value.events.length > 0 && cancel.value.resolvedTarget) {
      controls.push({ type: "cancel", target: cancel.value.resolvedTarget });
    }
  }
  if (frozen && selectedAttempt
    && steerControlTargets(frozen, cancelSnapshot).some(candidate => candidate.attemptId === selectedAttempt.attemptId)) {
    controls.push({ type: "steer", target: selectedAttempt.attemptId });
  }
  return controls;
}

function inspectionControlTarget(
  details: ResolvedTargetState,
  selectedAttempt: ResolvedTargetState["attempts"][number] | undefined,
): string | undefined {
  const authoredCollision = (nodeId: string | undefined) =>
    details.staticNode?.nodeId === details.target.id
    && nodeId !== details.staticNode.nodeId;
  if (details.target.kind === "attempt") {
    return selectedAttempt && !authoredCollision(selectedAttempt.nodeId)
      ? selectedAttempt.nodeKey
      : undefined;
  }
  if (details.target.kind === "dynamic-node") {
    const instance = details.instances.find(item => item.nodeKey === details.target.id);
    return instance && !authoredCollision(instance.nodeId) ? details.target.id : undefined;
  }
  if (details.target.kind === "frame") {
    const frame = details.frames.find(item => item.frameKey === details.target.id);
    return frame && !authoredCollision(frame.nodeId) ? details.target.id : undefined;
  }
  const candidates = new Set(
    [details.summary.nodeKey, details.summary.frameKey]
      .filter((candidate): candidate is string => candidate !== undefined),
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function validateTargetQuery(target: string): RunInspectionError | undefined {
  if (target.trim().length === 0) {
    return { type: "invalid-query", message: "Inspection target must not be blank." };
  }
  return undefined;
}

function recentTimelineAttemptIds(details: ResolvedTargetState): string[] {
  if (details.target.kind === "attempt") return [details.target.id];
  return [...details.attempts]
    .sort((left, right) => right.attemptNo - left.attemptNo
      || right.startedAt.localeCompare(left.startedAt)
      || right.attemptId.localeCompare(left.attemptId))
    .slice(0, inspectionTimelineEntryLimit)
    .map(attempt => attempt.attemptId);
}

function inspectionTimelineNodeKeys(
  run: NonNullable<RunInspectionStoreRead["run"]>,
  details: ResolvedTargetState,
): string[] {
  const nodeIds = new Set([
    ...details.instances.map(instance => instance.nodeKey),
    ...details.attempts.map(attempt => attempt.nodeKey),
    ...details.frames.flatMap(frame => frame.nodeKey === undefined ? [] : [frame.nodeKey]),
  ]);
  if (details.staticNode) {
    for (const group of run.dynamic?.groups ?? []) {
      if (group.nodeId === details.staticNode.nodeId) nodeIds.add(group.nodeKey);
    }
  }
  return [...nodeIds];
}

async function readRecentTimelineObservations(
  log: AgentObservationLog,
  runId: string,
  attemptIds: readonly string[],
): Promise<AgentObservationInspectionProjection> {
  const result = await log.readInspectionProjection({
    runId,
    attemptIds,
    entryLimit: inspectionTimelineEntryLimit,
    includeOlderCount: false,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

function inspectionError(runId: string, error: unknown): RunInspectionError {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  return {
    type: "inspection-read-failed",
    runId,
    message,
    cause: error,
  };
}

async function runtimeStoreReadiness(
  cwd: string,
  runId: string,
): Promise<RuntimeStoreRepairRequiredInspectionError | RuntimeStoreUnsupportedInspectionError | undefined> {
  const status = await inspectRuntimeStore(cwd);
  if (status.isErr() || status.value.state === "ready") return undefined;
  if (status.value.state === "unsupported") {
    return {
      type: "runtime-store-unsupported",
      runId,
      message: status.value.message,
    };
  }
  return {
    type: "runtime-store-repair-required",
    runId,
    command: "acpus doctor --fix",
    message: `${status.value.message} Run 'acpus doctor --fix'.`,
  };
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
