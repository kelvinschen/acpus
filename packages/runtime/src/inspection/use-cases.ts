import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { AgentObservationInspectionProjection, AgentObservationLog } from "../observations/log.js";
import {
  openExistingRuntimeStore,
  withRunInspectionSnapshot,
  type RuntimeStore,
  type RunInspectionStoreRead,
} from "../store/store.js";
import {
  canCancelRun,
  planCancelControl,
  planRetryControl,
  retryControlTargets,
  settleRetryControlSnapshot,
} from "../scheduler/control-plan.js";
import { steerControlTargets } from "../scheduler/steer-plan.js";
import {
  throwSchedulerStoreResult,
  type SchedulerSnapshot,
} from "../scheduler/store-port.js";
import {
  inspectionSubject,
  projectEvidence,
  projectTargetSummary,
  projectTimeline,
  projectTimelineEntries,
  targetAttemptId,
  timelineAttemptIds,
} from "./decision-projection.js";
import { projectAgentExecution } from "./agent-execution-projection.js";
import {
  inspectionStaticNodes,
  normalizeInspectionStatus,
  projectRawInspection,
  projectRunSnapshot,
  projectTargetTopology,
  resolveTargetState,
  terminalRun,
} from "./projection.js";
import { resolveInspectionTarget } from "./target-resolution.js";
import { occurrenceRefSelector } from "../scheduler/occurrence-ref.js";
import type { ResolvedTargetState } from "./resolved-target.js";
import type {
  InspectAgentExecutionQuery,
  InspectEvidenceQuery,
  InspectNodeQuery,
  InspectRawQuery,
  InspectRunQuery,
  InspectTargetArtifactsQuery,
  InspectTargetQuery,
  InspectTimelineQuery,
  InspectTargetResult,
  RunInspectionEvidenceCandidatesDocument,
  RunInspectionEvidenceDocument,
  RunInspectionCandidatesDocument,
  RunInspectionAgentExecutionDocument,
  RunInspectionNodeDocument,
  RunInspectionRaw,
  RunInspectionSnapshot,
  RunInspectionTargetArtifactsDocument,
  RunInspectionTimelineDocument,
  RunInspectionError,
  RunInspectionControl,
  RunInspectionCurrentActivity,
  RunInspectionTargetState,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineEntry,
  WatchInspectionEmission,
  WatchInspectionQuery,
} from "./types.js";

const inspectionFollowReadDelayMs = 250;

export function inspectRun(
  cwd: string,
  query: InspectRunQuery,
): ResultAsync<RunInspectionSnapshot, RunInspectionError> {
  return withInspectionRun(cwd, query.runId, state => ok(projectRunSnapshot({
    ir: state.frozen.ir,
    run: state.run,
    ...(query.includeAllTopology ? { includeAllTopology: true } : {}),
    ...(query.includeControls
      ? { availableControls: inspectionControls(state.frozen, state.schedulerSnapshot(), state.retrySchedulerSnapshot()) }
      : {}),
  })));
}

export function inspectTarget(
  cwd: string,
  query: InspectTargetQuery,
): ResultAsync<InspectTargetResult, RunInspectionError> {
  const invalid = validateTargetPageQuery(query);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, async state => {
    const resolved = resolveTarget(state, query.target, pageInput(query), query.includeControls === true);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return ok(resolved.value.document);
    if (query.includeAllTopology) {
      const document = projectTargetTopology({
        ir: state.frozen.ir,
        run: state.run,
        target: resolved.value.target,
        ...(query.includeControls
          ? {
              includeControls: true,
              availableControls: inspectionControls(state.frozen, state.schedulerSnapshot(), state.retrySchedulerSnapshot()),
            }
          : {}),
      });
      return document === undefined
        ? err(targetNotFound(query.runId, query.target))
        : ok(document);
    }
    const observations = await targetObservations(state, resolved.value.details);
    return ok(projectTargetSummary({
      run: state.run,
      details: resolved.value.details,
      ...(query.includeControls ? { includeControls: true } : {}),
      ...(observations ? { observations } : {}),
    }));
  });
}

export function inspectTimeline(
  cwd: string,
  query: InspectTimelineQuery,
): ResultAsync<RunInspectionTimelineDocument, RunInspectionError> {
  const invalid = validateTargetPageQuery(query);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, state => readTimeline(state, query.target, pageInput(query))
    .then(result => result.map(value => value.document)));
}

export function inspectEvidence(
  cwd: string,
  query: InspectEvidenceQuery,
): ResultAsync<RunInspectionEvidenceDocument | RunInspectionEvidenceCandidatesDocument, RunInspectionError> {
  const invalid = validateTargetPageQuery(query);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, async state => {
    const resolved = resolveTarget(state, query.target, pageInput(query));
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.document));
    const attempts = evidenceAttempts(resolved.value.details);
    if (attempts.length === 0) {
      return err({
        type: "target-not-found",
        runId: query.runId,
        target: query.target,
        message: `Run target '${query.target}' has no Agent attempt evidence.`,
      });
    }
    if (resolved.value.details.target.kind !== "attempt" && attempts.length > 1) {
      return ok(evidenceCandidates(state.run, resolved.value.details, query.target, attempts, pageInput(query)));
    }
    const attempt = attempts[0]!;
    const exact = resolved.value.details.target.kind === "attempt"
      ? resolved.value.details
      : resolveTargetState({
          ir: state.frozen.ir,
          run: state.run,
          artifacts: state.read.artifacts,
          target: attempt.attemptId,
        });
    if (!exact) throw new Error("Evidence target projection failed.");
    const observationResult = await state.store.observationLog.readInspectionProjection({
      runId: query.runId,
      attemptIds: [attempt.attemptId],
      entryLimit: 50,
    });
    if (observationResult.isErr()) throw observationResult.error;
    const document = projectEvidence({
      details: exact,
      observations: observationResult.value,
      runDir: state.store.getRunDir(query.runId) ?? throwMissingRunDirectory(query.runId),
      page: query.page ?? 1,
      limit: query.limit ?? 12,
    });
    if (!document) throw new Error("Evidence projection failed.");
    return ok(document);
  });
}

export function inspectRaw(cwd: string, query: InspectRawQuery): ResultAsync<RunInspectionRaw, RunInspectionError> {
  return withInspectionRun(cwd, query.runId, state => ok(projectRawInspection({
    ir: state.frozen.ir,
    run: state.run,
    artifacts: state.read.artifacts,
  })));
}

export function inspectNode(cwd: string, query: InspectNodeQuery): ResultAsync<RunInspectionNodeDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return invalidInspection(invalid);
  return withInspectionRun(cwd, query.runId, state => {
    const resolved = resolveTarget(state, query.target, undefined, true);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.document));
    const details = resolved.value.details;
    return ok({
      schemaVersion: 2,
      kind: "node",
      run: details.run,
      subject: inspectionSubject(details),
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
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.document));
    const attemptId = resolved.value.details.staticNode?.kind === "agent"
      ? targetAttemptId(resolved.value.details)
      : undefined;
    const observationResult = attemptId === undefined
      ? undefined
      : await state.store.observationLog.readInspectionProjection({
          runId: query.runId,
          attemptIds: [attemptId],
          entryLimit: 50,
          latestTurnOnly: true,
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
    if (resolved.value.kind === "candidates") return err(targetAmbiguous(query.runId, query.target, resolved.value.document));
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

export async function* watchInspection(
  cwd: string,
  query: WatchInspectionQuery,
): AsyncIterable<Result<WatchInspectionEmission, RunInspectionError>> {
  yield* followInspection(cwd, query);
}

function pageInput(query: { page?: number; limit?: number }): { number?: number; limit?: number } | undefined {
  return query.page === undefined && query.limit === undefined
    ? undefined
    : {
        ...(query.page === undefined ? {} : { number: query.page }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      };
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
  | { kind: "candidates"; document: RunInspectionCandidatesDocument };

type WatchDocument =
  | RunInspectionSnapshot
  | RunInspectionTargetSummaryDocument
  | RunInspectionTimelineDocument;

function invalidInspection<T>(error: RunInspectionError): ResultAsync<T, RunInspectionError> {
  return new ResultAsync(Promise.resolve(err(error)));
}

function withInspectionRun<T>(
  cwd: string,
  runId: string,
  project: (state: InspectionRun) => Result<T, RunInspectionError> | Promise<Result<T, RunInspectionError>>,
  eventSequence?: number,
): ResultAsync<T, RunInspectionError> {
  return new ResultAsync((async () => {
    let store: RuntimeStore | undefined;
    try {
      const runtimeStore = await openExistingRuntimeStore(cwd);
      if (!runtimeStore) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
      store = runtimeStore;
      return await withRunInspectionSnapshot(runtimeStore, async () => {
        const read = runtimeStore.readRunInspection(runId, eventSequence);
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
  page?: { number?: number; limit?: number },
  includeControls = false,
): Result<ResolvedInspectionTarget, RunInspectionError> {
  const resolution = resolveInspectionTarget({
    run: state.run,
    staticNodes: inspectionStaticNodes(state.frozen.ir),
    target,
    ...(page === undefined ? {} : { page }),
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
  if (resolution.kind === "candidates") return ok({ kind: "candidates", document: resolution.document });
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
  candidates: RunInspectionCandidatesDocument,
): RunInspectionError {
  return {
    type: "target-ambiguous",
    runId,
    target,
    candidates,
    message: `Run target '${target}' matches multiple occurrences. Select one @ref from the candidate view.`,
  };
}

async function targetObservations(
  state: InspectionRun,
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

async function readTimeline(
  state: InspectionRun,
  target: string,
  page?: { number?: number; limit?: number },
): Promise<Result<{ document: RunInspectionTimelineDocument; target: FollowTarget; timelineEntries: RunInspectionTimelineEntry[] }, RunInspectionError>> {
  const resolved = resolveTarget(state, target, page);
  if (resolved.isErr()) return err(resolved.error);
  if (resolved.value.kind === "candidates") return err(targetAmbiguous(state.run.id, target, resolved.value.document));
  const events = state.store.getCommittedRuntimeEventsAfter(state.run.id, 0);
  const observations = await readRetainedTimelineObservations(
    state.store.observationLog,
    state.run.id,
    timelineAttemptIds(resolved.value.details),
  );
  const document = projectTimeline({
    run: state.run,
    details: resolved.value.details,
    ...(page?.number === undefined ? {} : { page: page.number }),
    ...(page?.limit === undefined ? {} : { limit: page.limit }),
    events,
    observations,
  });
  return ok({
    document,
    target: followTarget(state.run, resolved.value.target, resolved.value.details),
    timelineEntries: projectTimelineEntries({ run: state.run, details: resolved.value.details, events, observations }),
  });
}

async function* followInspection(
  cwd: string,
  query: WatchInspectionQuery,
): AsyncIterable<Result<WatchInspectionEmission, RunInspectionError>> {
  const validation = validateWatchQuery(query);
  if (validation) {
    yield err(validation);
    return;
  }
  let cycle = await readWatchCycle(cwd, query.view);
  if (cycle.isErr()) {
    yield err(cycle.error);
    return;
  }
  const subject = followSubject(query.view, cycle.value);
  if (atDecisionBoundary(subject, cycle.value)) {
    yield okEmission({ schemaVersion: 2, kind: "view", document: cycle.value.document });
    return;
  }
  yield okEmission({ schemaVersion: 2, kind: "view", document: cycle.value.document });
  const fixedView = pinFollowView(query.view, cycle.value);
  let cursor = cycle.value.cursor;
  let timeline = cycle.value.timelineEntries;
  const seenTimelineEntryIds = new Set(timeline?.map(entry => entry.id));

  while (!query.signal?.aborted) {
    await delay(inspectionFollowReadDelayMs, query.signal);
    if (query.signal?.aborted) return;
    const next = await readWatchCycle(cwd, fixedView, cursor.eventSequence);
    if (next.isErr()) {
      yield err(next.error);
      return;
    }
    const discontinuity = sequenceDiscontinuity(cursor.eventSequence, next.value.cursor.eventSequence, next.value.events);
    if (discontinuity) {
      yield err({
        type: "inspection-sequence-discontinuity",
        runId: fixedView.runId,
        expected: discontinuity.expected,
        actual: discontinuity.actual,
        message: `Inspection event sequence is discontinuous: expected ${discontinuity.expected}, received ${discontinuity.actual}.`,
      });
      return;
    }
    if (fixedView.kind === "timeline") {
      for (const entry of followTimelineEntries(
        timeline,
        next.value.timelineEntries ?? [],
        cycle.value.document,
        next.value.document,
        next.value.cursor,
      )) {
        if (seenTimelineEntryIds.has(entry.id)) continue;
        seenTimelineEntryIds.add(entry.id);
        yield okEmission({ schemaVersion: 2, kind: "timeline-entry", entry });
      }
    }
    cursor = next.value.cursor;
    if (atDecisionBoundary(subject, next.value)) {
      yield okEmission({ schemaVersion: 2, kind: "view", document: next.value.document });
      return;
    }
    timeline = next.value.timelineEntries;
    cycle = next;
  }
}

async function readWatchCycle(
  cwd: string,
  view: WatchInspectionQuery["view"],
  eventSequence?: number,
): Promise<Result<FollowCycle, RunInspectionError>> {
  if (view.kind === "run") {
    return withInspectionRun(cwd, view.runId, state => ok(followCycle(state.read, projectRunSnapshot({
      ir: state.frozen.ir,
      run: state.run,
      ...(view.includeAllTopology ? { includeAllTopology: true } : {}),
      ...(view.includeControls
        ? { availableControls: inspectionControls(state.frozen, state.schedulerSnapshot(), state.retrySchedulerSnapshot()) }
        : {}),
    }))), eventSequence);
  }
  if (view.kind === "target") {
    return withInspectionRun(cwd, view.runId, async state => {
      const resolved = resolveTarget(state, view.target, undefined, view.includeControls === true);
      if (resolved.isErr()) return err(resolved.error);
      if (resolved.value.kind === "candidates") return err(targetAmbiguous(view.runId, view.target, resolved.value.document));
      const target = followTarget(state.run, resolved.value.target, resolved.value.details);
      const observations = view.includeAllTopology
        ? undefined
        : await targetObservations(state, resolved.value.details);
      const document = view.includeAllTopology
        ? projectTargetTopology({
            ir: state.frozen.ir,
            run: state.run,
            target: resolved.value.target,
            ...(view.includeControls
              ? { includeControls: true, availableControls: inspectionControls(state.frozen, state.schedulerSnapshot(), state.retrySchedulerSnapshot()) }
              : {}),
          })
        : projectTargetSummary({
            run: state.run,
            details: resolved.value.details,
            ...(view.includeControls ? { includeControls: true } : {}),
            ...(observations
              ? { observations }
              : {}),
          });
      return document === undefined
        ? err(targetNotFound(view.runId, view.target))
        : ok(followCycle(state.read, document, { target }));
    }, eventSequence);
  }
  return withInspectionRun(cwd, view.runId, async state => {
    const timeline = await readTimeline(state, view.target, view.limit === undefined ? undefined : { limit: view.limit });
    return timeline.map(value => followCycle(state.read, value.document, {
      target: value.target,
      timelineEntries: value.timelineEntries,
    }));
  }, eventSequence);
}

function retryInspectionControls(snapshot: SchedulerSnapshot): RunInspectionControl[] {
  return retryControlTargets(snapshot)
    .map(({ target }) => ({ type: "retry" as const, target }));
}

function inspectionControls(
  frozen: NonNullable<RunInspectionStoreRead["frozen"]>,
  snapshot: SchedulerSnapshot,
  retrySnapshot: SchedulerSnapshot,
): RunInspectionControl[] {
  const controls: RunInspectionControl[] = [
    ...retryInspectionControls(retrySnapshot),
    ...cancelInspectionControls(snapshot),
    ...steerControlTargets(frozen, snapshot).map(target => ({ type: "steer" as const, target: target.attemptId })),
    ...(canCancelRun(snapshot) ? [{ type: "cancel" as const }] : []),
  ];
  const seen = new Set<string>();
  return controls.filter(control => {
    const key = `${control.type}:${control.target ?? "run"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cancelInspectionControls(snapshot: SchedulerSnapshot): RunInspectionControl[] {
  const targets = [
    ...Object.values(snapshot.projection.frames)
      .filter(frame => frame.frameKey !== "root")
      .map(frame => frame.frameKey),
    ...Object.values(snapshot.projection.instances).map(instance => instance.nodeKey),
  ].sort();
  return targets.flatMap(target => {
    const plan = planCancelControl(snapshot, target);
    return plan.isOk() && plan.value.resolvedTarget
      ? [{ type: "cancel" as const, target: plan.value.resolvedTarget }]
      : [];
  });
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

function evidenceAttempts(details: ResolvedTargetState): ResolvedTargetState["attempts"] {
  if (details.staticNode?.kind !== "agent") return [];
  if (details.target.kind === "attempt") {
    return details.attempts.filter(attempt => attempt.attemptId === details.target.id);
  }
  return [...details.attempts].sort((left, right) => left.attemptNo - right.attemptNo
    || left.startedAt.localeCompare(right.startedAt)
    || left.attemptId.localeCompare(right.attemptId));
}

function evidenceCandidates(
  run: NonNullable<RunInspectionStoreRead["run"]>,
  details: ResolvedTargetState,
  target: string,
  attempts: readonly ResolvedTargetState["attempts"][number][],
  page: { number?: number; limit?: number } | undefined,
): RunInspectionEvidenceCandidatesDocument {
  const number = page?.number ?? 1;
  const limit = page?.limit ?? 12;
  const start = (number - 1) * limit;
  const entries = attempts.slice(start, start + limit).map(attempt => {
    const item = details.items.find(candidate => candidate.attemptId === attempt.attemptId)
      ?? details.items.find(candidate => candidate.nodeKey === attempt.nodeKey);
    const ref = item?.ref ?? details.target.ref;
    if (!ref) throw new Error(`Evidence attempt '${attempt.attemptId}' has no occurrence reference.`);
    return {
      target: occurrenceRefSelector(ref as `@${string}`, attempt.attemptNo),
      attemptNo: attempt.attemptNo,
      status: normalizeInspectionStatus(attempt.status),
      breadcrumb: item?.path.join(" › ") ?? item?.label ?? details.summary.nodeId ?? details.target.id,
    };
  });
  return {
    schemaVersion: 2,
    kind: "evidence-candidates",
    run: { id: run.id, status: run.status, updatedAt: run.updatedAt },
    target,
    candidates: {
      entries,
      page: number,
      limit,
      total: attempts.length,
      hasMore: start + entries.length < attempts.length,
      ...(start + entries.length < attempts.length ? { nextPage: number + 1 } : {}),
    },
  };
}

type InspectionCycle = {
  document: WatchDocument;
  events: RunInspectionStoreRead["events"];
  cursor: RunInspectionStoreRead["cursor"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  target?: FollowTarget;
  timelineEntries?: RunInspectionTimelineEntry[];
};

type FollowCycle = InspectionCycle;

type FollowTarget = {
  target: string;
  exactAttempt: boolean;
  state: RunInspectionTargetState;
  awaitingSignal: boolean;
};

type FollowSubject =
  | { kind: "run" }
  | { kind: "target"; target: string; exactAttempt: boolean };

function followCycle(
  read: RunInspectionStoreRead,
  document: WatchDocument,
  options: { target?: FollowTarget; timelineEntries?: RunInspectionTimelineEntry[] } = {},
): InspectionCycle {
  return {
    document,
    events: read.events,
    cursor: read.cursor,
    run: read.run!,
    ...(options.target ? { target: options.target } : {}),
    ...(options.timelineEntries ? { timelineEntries: options.timelineEntries } : {}),
  };
}

function followTarget(
  run: NonNullable<RunInspectionStoreRead["run"]>,
  target: string,
  details: ResolvedTargetState,
): FollowTarget {
  const document = projectTargetSummary({ run, details });
  return {
    target,
    exactAttempt: details.target.kind === "attempt",
    state: document.state,
    awaitingSignal: document.availableActions.some(action => action.kind === "signal"),
  };
}

function followSubject(view: WatchInspectionQuery["view"], cycle: FollowCycle): FollowSubject {
  if (view.kind === "run") return { kind: "run" };
  if (!cycle.target) throw new Error("Follow target was not resolved.");
  return {
    kind: "target",
    target: cycle.target.target,
    exactAttempt: cycle.target.exactAttempt,
  };
}

function pinFollowView(
  view: WatchInspectionQuery["view"],
  cycle: FollowCycle,
): WatchInspectionQuery["view"] {
  return view.kind === "run" || !cycle.target
    ? view
    : { ...view, target: cycle.target.target };
}

function atDecisionBoundary(subject: FollowSubject, cycle: FollowCycle): boolean {
  if (subject.kind === "run") {
    return terminalRun(cycle.document.run.status) || projectedHardAttention(cycle.document);
  }
  const target = cycle.target;
  return target !== undefined && (terminalTarget(target.state.status) || target.awaitingSignal);
}

function projectedHardAttention(document: WatchDocument): boolean {
  if (document.kind !== "snapshot") return false;
  if (document.run.failure !== undefined) return true;
  const signalItems = new Set(document.availableActions
    .filter((action): action is Extract<typeof action, { kind: "signal" }> => action.kind === "signal")
    .map(action => action.itemKey));
  return document.items.some(item => item.status === "failed"
    || item.status === "timed_out"
    || item.status === "awaiting" && (item.signal !== undefined || signalItems.has(item.key)));
}

function terminalTarget(status: RunInspectionTargetState["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "not_selected";
}

function validateTargetQuery(target: string): RunInspectionError | undefined {
  if (target.trim().length === 0) {
    return { type: "invalid-query", message: "Inspection target must not be blank." };
  }
  return undefined;
}

function validateTargetPageQuery(query: { target: string; page?: number; limit?: number }): RunInspectionError | undefined {
  const target = validateTargetQuery(query.target);
  if (target) return target;
  const limit = query.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
    return { type: "invalid-query", message: "Inspection limit must be an integer from 1 through 50." };
  }
  const page = query.page;
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) {
    return { type: "invalid-query", message: "Inspection page must be a positive safe integer." };
  }
  return undefined;
}

function validateWatchQuery(query: WatchInspectionQuery): RunInspectionError | undefined {
  if (query.view.kind === "run") return undefined;
  const target = validateTargetQuery(query.view.target);
  if (target) return target;
  if (query.view.kind !== "timeline") return undefined;
  const { limit } = query.view;
  return limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    ? { type: "invalid-query", message: "Inspection limit must be an integer from 1 through 50." }
    : undefined;
}

async function readRetainedTimelineObservations(
  log: AgentObservationLog,
  runId: string,
  attemptIds: readonly string[],
): Promise<AgentObservationInspectionProjection> {
  let beforeEntry: { observationVersion: number; sourceSequence: number; id: string } | undefined;
  let latest: AgentObservationInspectionProjection | undefined;
  const entries: AgentObservationInspectionProjection["entries"] = [];

  while (true) {
    const result = await log.readInspectionProjection({
      runId,
      attemptIds,
      entryLimit: 50,
      ...(beforeEntry === undefined ? {} : { beforeEntry }),
    });
    if (result.isErr()) throw result.error;
    const projection = result.value;
    latest ??= projection;
    entries.push(...projection.entries);
    if (!projection.hasOlderEntries) {
      return {
        ...latest,
        entries,
        olderEntryCount: 0,
        hasOlderEntries: false,
        ...(entries.length === 0 ? {} : { oldestObservationVersion: Math.min(...entries.map(entry => entry.observationVersion)) }),
      };
    }
    const oldest = projection.entries[0];
    if (!oldest) throw new Error(`Observation history for run '${runId}' has no paging boundary.`);
    beforeEntry = {
      observationVersion: oldest.observationVersion,
      sourceSequence: oldest.sourceSequence,
      id: oldest.id,
    };
  }
}

function followTimelineEntries(
  previous: readonly RunInspectionTimelineEntry[] | undefined,
  current: readonly RunInspectionTimelineEntry[],
  previousDocument: WatchDocument,
  currentDocument: WatchDocument,
  cursor: RunInspectionStoreRead["cursor"],
): RunInspectionTimelineEntry[] {
  const known = new Set(previous?.map(entry => entry.id));
  const entries = current.filter(entry => !known.has(entry.id));
  const phase = phaseEntry(previousDocument, currentDocument, cursor);
  const visibility = visibilityEntry(previousDocument, currentDocument, cursor);
  if (phase) entries.push(phase);
  if (visibility) entries.push(visibility);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.at.localeCompare(right.entry.at) || left.index - right.index)
    .map(({ entry }) => entry);
}

function phaseEntry(
  previous: WatchDocument,
  current: WatchDocument,
  cursor: RunInspectionStoreRead["cursor"],
): Extract<RunInspectionTimelineEntry, { kind: "phase" }> | undefined {
  if (current.kind !== "timeline" || !current.current || current.current.kind === "signal") return undefined;
  const before = previous.kind === "timeline" ? previous.current : undefined;
  if (samePhase(before, current.current)) return undefined;
  const activity = current.current;
  const identity = activity.kind === "agent"
    ? `${activity.attemptId}:${activity.attemptNo ?? ""}:${activity.turn ?? ""}`
    : activity.kind;
  return {
    id: `follow:phase:${cursor.eventSequence}:${cursor.observationVersion}:${identity}:${activity.phase}`,
    kind: "phase",
    at: activity.updatedAt,
    ...(activity.kind === "agent" ? {
      attemptId: activity.attemptId,
      ...(activity.attemptNo === undefined ? {} : { attemptNo: activity.attemptNo }),
      ...(activity.turn === undefined ? {} : { turn: activity.turn }),
    } : {}),
    phase: activity.phase,
  };
}

function samePhase(
  previous: RunInspectionCurrentActivity | undefined,
  current: Exclude<RunInspectionCurrentActivity, { kind: "signal" }>,
): boolean {
  if (!previous || previous.kind === "signal" || previous.kind !== current.kind) return false;
  if (previous.phase !== current.phase) return false;
  if (current.kind !== "agent") return true;
  return previous.kind === "agent"
    && previous.attemptId === current.attemptId
    && previous.attemptNo === current.attemptNo
    && previous.turn === current.turn
    && previous.turnKind === current.turnKind;
}

function visibilityEntry(
  previous: WatchDocument,
  current: WatchDocument,
  cursor: RunInspectionStoreRead["cursor"],
): Extract<RunInspectionTimelineEntry, { kind: "visibility" }> | undefined {
  if (previous.kind !== "timeline" || current.kind !== "timeline" || equal(previous.visibility, current.visibility)) return undefined;
  const visibility = current.visibility;
  return {
    id: `follow:visibility:${cursor.eventSequence}:${cursor.observationVersion}:${visibility?.reason ?? "restored"}`,
    kind: "visibility",
    at: current.current?.updatedAt ?? current.run.updatedAt,
    state: visibility ? "degraded" : "restored",
    ...(visibility ? { reason: visibility.reason } : {}),
  };
}

function sequenceDiscontinuity(
  previous: number,
  current: number,
  events: RunInspectionStoreRead["events"],
): { expected: number; actual: number } | undefined {
  if (current === previous && events.length === 0) return undefined;
  if (current < previous) return { expected: previous, actual: current };
  let expected = previous + 1;
  for (const event of events) {
    if (event.sequence !== expected) return { expected, actual: event.sequence };
    expected += 1;
  }
  return expected - 1 === current
    ? undefined
    : { expected, actual: current };
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

function throwMissingRunDirectory(runId: string): never {
  throw new Error(`Run directory for '${runId}' was not found.`);
}

function okEmission(value: WatchInspectionEmission): Result<WatchInspectionEmission, RunInspectionError> {
  return ok(value);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
