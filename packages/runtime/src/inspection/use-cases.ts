import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { AgentObservationInspectionProjection, AgentObservationReadError } from "../observations/log.js";
import {
  type RuntimeReadFailure,
  type RunInspectionStoreRead,
} from "../store/store.js";
import {
  acquireBoundRuntimeReadSession,
  type RuntimeStoreBusy,
  type RuntimeStoreShape,
} from "../store/service.js";
import type { CommittedRuntimeEventRow } from "../store/committed-event.js";
import { findArchivedRun } from "../runtime-history.js";
import {
  planCancelControl,
  planRetryControl,
  settleRetryControlSnapshot,
} from "../scheduler/control-plan.js";
import { steerControlTargets } from "../scheduler/steer-plan.js";
import { planRetrySessionImpact } from "../scheduler/retry-session-impact.js";
import type { AgentTurnProof } from "../execution/agent-turn-registry.js";
import { indexNodes } from "../scheduler/ir-walk.js";
import type { SchedulerSnapshot, SchedulerStoreError } from "../scheduler/store-port.js";
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
import {
  readAgentSessionOwnershipHealth,
  withInspectionOwnershipHealth,
  withObservationOwnershipHealth,
  withStoreReadOwnershipHealth,
} from "./ownership-health.js";
import type {
  InspectAgentExecutionQuery,
  InspectNodeQuery,
  InspectTargetArtifactsQuery,
  RunInspectionAgentExecutionDocument,
  RunInspectionNodeDocument,
  RunInspectionTargetArtifactsDocument,
  RunInspectionTargetSummary,
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
} from "./types.js";

const inspectionObserveReadDelayMs = 1_000;
const inspectionTimelineEntryLimit = 12;
const inspectionTimelineEventLimit = 48;
type AgentTurnProofLookup = (proof: AgentTurnProof) => boolean;

/** Reads the one coherent public inspection document. */
export function readInspection(
  cwd: string,
  view: InspectionViewQuery,
): Effect.Effect<InspectionRead, InspectionError> {
  const invalid = view.kind === "target" ? validateCoherentTarget(view.target) : undefined;
  if (invalid) return Effect.fail(invalid);
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd).pipe(
      Effect.mapError(failure => inspectionRuntimeReadFailure(view.runId, failure)),
    );
    if (!session) return yield* Effect.fail<InspectionError>({
      type: "runtime-store-not-found",
      message: "Runtime store was not found.",
    });
    const active = yield* Effect.result(withCoherentInspectionRunAtStore(
      session.store,
      view.runId,
      state => readCoherentView(state, view),
    ));
    if (Result.isSuccess(active)) {
      const ownership = yield* readAgentSessionOwnershipHealth(cwd, session.store).pipe(
        Effect.mapError(failure => inspectionStoreBusyFailure(view.runId, failure)),
      );
      return withInspectionOwnershipHealth(active.success, ownership);
    }
    if (active.failure.type !== "run-not-found") return yield* Effect.fail(active.failure);
    return yield* archivedInspection(cwd, view);
  }));
}

export function readInspectionAtStore(
  store: RuntimeStoreShape,
  view: InspectionViewQuery,
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<InspectionRead, InspectionError> {
  const invalid = view.kind === "target" ? validateCoherentTarget(view.target) : undefined;
  if (invalid) return Effect.fail(invalid);
  return withCoherentInspectionRunAtStore(
    store,
    view.runId,
    state => readCoherentView(state, view, undefined, provesAgentTurn),
  );
}

/**
 * Observes durable semantic state. The initial projection is immediate; later
 * cycles first read only the durable change token and build a view only when it
 * changed.
 */
export function observeInspection(
  cwd: string,
  query: ObserveInspectionQuery,
): Stream.Stream<InspectionObservation, InspectionError> {
  const invalid = validateObserveInspectionQuery(query);
  if (invalid) return Stream.fail(invalid);
  return Stream.unwrap(acquireBoundRuntimeReadSession(cwd).pipe(
    Effect.mapError(failure => inspectionRuntimeReadFailure(query.view.runId, failure)),
    Effect.flatMap(session => session === undefined
      ? Effect.fail<InspectionError>({ type: "runtime-store-not-found", message: "Runtime store was not found." })
      : Effect.succeed(session)),
    Effect.flatMap(session => Effect.gen(function* () {
      const initialResult = yield* Effect.result(readCoherentCycleAtStore(session.store, query.view));
      const initial = Result.isSuccess(initialResult)
        ? initialResult.success
        : yield* Effect.gen(function* () {
            if (initialResult.failure.type !== "run-not-found") return yield* Effect.fail(initialResult.failure);
            const archived = yield* archivedInspection(cwd, query.view);
            if (archived.kind === "archived-run") {
              return yield* Effect.fail(archivedDetailUnavailable(query.view.runId));
            }
            return yield* Effect.fail(initialResult.failure);
          });
      return observationStreamAtStore(session.store, query, initial).pipe(
        Stream.mapEffect(observation => observation.kind === "update"
          ? Effect.succeed(observation)
          : readAgentSessionOwnershipHealth(cwd, session.store).pipe(
              Effect.mapError(failure => inspectionStoreBusyFailure(query.view.runId, failure)),
              Effect.map(ownership => withObservationOwnershipHealth(observation, ownership)),
            )),
      );
    })),
  ));
}

export function observeInspectionAtStore(
  store: RuntimeStoreShape,
  query: ObserveInspectionQuery,
  provesAgentTurn?: AgentTurnProofLookup,
): Stream.Stream<InspectionObservation, InspectionError> {
  const invalid = validateObserveInspectionQuery(query);
  if (invalid) return Stream.fail(invalid);
  return Stream.unwrap(readCoherentCycleAtStore(store, query.view, undefined, undefined, provesAgentTurn).pipe(
    Effect.map(initial => observationStreamAtStore(store, query, initial, provesAgentTurn)),
  ));
}

type InspectionObservationState = Readonly<{
  previous: CoherentCycle;
  done: boolean;
}>;

function observationStreamAtStore(
  store: RuntimeStoreShape,
  query: ObserveInspectionQuery,
  initial: CoherentCycle,
  provesAgentTurn?: AgentTurnProofLookup,
): Stream.Stream<InspectionObservation, InspectionError> {
  const initialClose = observationCloseReason(initial, query.until);
  if (initialClose) return Stream.succeed({ kind: "closed", reason: initialClose, view: initial.view });
  const state: InspectionObservationState = { previous: initial, done: false };
  const updates = Stream.unfold(
    state,
    state => nextInspectionObservation(store, query, state, provesAgentTurn),
  );
  return Stream.succeed<InspectionObservation>({ kind: "attached", view: initial.view }).pipe(Stream.concat(updates));
}

function nextInspectionObservation(
  store: RuntimeStoreShape,
  query: ObserveInspectionQuery,
  state: InspectionObservationState,
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<readonly [InspectionObservation, InspectionObservationState] | undefined, InspectionError> {
  if (state.done) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    let previous = state.previous;
    while (true) {
      const continueObservation = yield* waitForInspectionCycle(query.signal);
      if (!continueObservation) return undefined;
      const token = yield* readCoherentTokenAtStore(store, query.view.runId);
      if (sameInspectionToken(previous.token, token)) continue;
      const cycle = yield* readCoherentCycleAtStore(
        store,
        query.view,
        previous.pinnedTarget,
        previous.token.eventSequence,
        provesAgentTurn,
      );
      const close = observationCloseReason(cycle, query.until);
      if (close) {
        return [
          { kind: "closed", reason: close, view: cycle.view },
          { previous: cycle, done: true },
        ] as const;
      }
      const changes = inspectionChanges(previous.changeView, cycle.changeView, cycle.events, cycle.run);
      const timeline = timelineChanges(previous.view, cycle.view, changes);
      const activity = query.updates === "activity" && inspectionActivityChanged(previous.view, cycle.view);
      previous = cycle;
      if (changes.length > 0 || timeline?.length || activity) {
        return [
          {
            kind: "update",
            changes,
            ...(timeline?.length ? { timeline } : {}),
            ...(activity ? { activity: true as const } : {}),
          },
          { previous, done: false },
        ] as const;
      }
    }
  });
}

function waitForInspectionCycle(signal: AbortSignal | undefined): Effect.Effect<boolean> {
  if (signal === undefined) return Effect.as(Effect.sleep(inspectionObserveReadDelayMs), true);
  if (signal.aborted) return Effect.succeed(false);
  const aborted = Effect.callback<void>(resume => {
    const onAbort = (): void => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return Effect.raceFirst(
    Effect.as(Effect.sleep(inspectionObserveReadDelayMs), true),
    Effect.as(aborted, false),
  );
}

export function inspectionActivityChanged(
  previous: InspectionView,
  current: InspectionView,
): boolean {
  return JSON.stringify(inspectionActivityProjection(previous))
    !== JSON.stringify(inspectionActivityProjection(current));
}

function inspectionActivityProjection(view: InspectionView): unknown {
  if (view.kind === "run") return treeActivityProjection(view.tree);
  if (view.detail === "summary") return view.pulse;
  if (view.detail === "timeline") return view.current;
  return undefined;
}

function treeActivityProjection(
  tree: readonly import("./types.js").InspectionTreeEntry[],
): unknown[] {
  return tree.map(entry => entry.type === "item"
    ? {
        subject: entry.subject,
        agent: entry.agent === undefined ? undefined : { name: entry.agent.name },
        pulse: entry.pulse,
        children: treeActivityProjection(entry.children),
      }
    : {
        fold: entry.scope,
        range: entry.range,
        children: treeActivityProjection(entry.children),
      });
}

type CoherentInspectionRun = {
  store: RuntimeStoreShape;
  read: RunInspectionStoreRead;
  run: NonNullable<RunInspectionStoreRead["run"]>;
  frozen: NonNullable<RunInspectionStoreRead["frozen"]>;
  schedulerSnapshot(): Effect.Effect<SchedulerSnapshot, InspectionError>;
};

type CoherentCycle = {
  view: InspectionView;
  changeView: InspectionView;
  token: RunInspectionStoreRead["cursor"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  pinnedTarget?: string;
  events: CommittedRuntimeEventRow[];
};

type CoherentTarget =
  | { kind: "candidates"; candidates: InspectionCandidates }
  | { kind: "resolved"; target: string; details: ResolvedTargetState };

function archivedInspection(
  cwd: string,
  view: InspectionViewQuery,
): Effect.Effect<InspectionRead, InspectionError> {
  return Effect.tryPromise({
    try: () => findArchivedRun(cwd, view.runId),
    catch: error => ({
      type: "read-failed" as const,
      runId: view.runId,
      message: error instanceof Error ? error.message : String(error),
    }),
  }).pipe(Effect.flatMap(lookup => {
    if (lookup.kind === "not-found") {
      return Effect.fail<InspectionError>({ type: "run-not-found", runId: view.runId, message: `Run '${view.runId}' was not found.` });
    }
    if (lookup.kind === "unavailable") {
      return Effect.fail<InspectionError>({
        type: "archived-run-lookup-unavailable",
        runId: view.runId,
        message: lookup.message,
      });
    }
    if (view.kind !== "run") return Effect.fail(archivedDetailUnavailable(view.runId));
    return Effect.succeed<InspectionRead>({ kind: "archived-run", run: lookup.run });
  }));
}

function archivedDetailUnavailable(runId: string): Extract<InspectionError, { type: "archived-run-detail-unavailable" }> {
  return {
    type: "archived-run-detail-unavailable",
    runId,
    command: `acpus runs inspect ${runId}`,
    message: `Archived run '${runId}' only has a summary. Run 'acpus runs inspect ${runId}'.`,
  };
}

function withCoherentInspectionRunAtStore<T>(
  store: RuntimeStoreShape,
  runId: string,
  project: (state: CoherentInspectionRun) => Effect.Effect<T, InspectionError>,
): Effect.Effect<T, InspectionError> {
  return store.withRunInspectionSnapshot(Effect.gen(function* () {
    const read = yield* store.readRunInspection(runId).pipe(
      Effect.mapError(failure => inspectionStoreBusyFailure(runId, failure)),
    );
    if (!read.run) return yield* Effect.fail<InspectionError>({
      type: "run-not-found",
      runId,
      message: `Run '${runId}' was not found.`,
    });
    if (!read.frozen) throw new Error(`Frozen workflow for run '${runId}' was not found.`);
    let scheduler: SchedulerSnapshot | undefined;
    const schedulerSnapshot = (): Effect.Effect<SchedulerSnapshot, InspectionError> => scheduler === undefined
      ? loadSchedulerSnapshot(store, runId).pipe(
          Effect.mapError(failure => inspectionStoreBusyFailure(runId, failure)),
          Effect.tap(value => Effect.sync(() => {
            scheduler = value;
          })),
        )
      : Effect.succeed(scheduler);
    return yield* project({ store, read, run: read.run, frozen: read.frozen, schedulerSnapshot });
  })).pipe(
    Effect.catchIf(
      (failure): failure is RuntimeStoreBusy => isRuntimeStoreBusy(failure),
      failure => Effect.fail(inspectionStoreBusyFailure(runId, failure)),
    ),
  );
}

function readCoherentCycleAtStore(
  store: RuntimeStoreShape,
  view: InspectionViewQuery,
  pinnedTarget?: string,
  afterEventSequence?: number,
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<CoherentCycle, InspectionError> {
  return withCoherentInspectionRunAtStore(store, view.runId, state => Effect.gen(function* () {
    const read = yield* readCoherentView(state, view, pinnedTarget, provesAgentTurn);
    if (read.kind === "candidates") {
      return yield* Effect.fail<InspectionError>({
        type: "target-ambiguous",
        runId: view.runId,
        target: view.kind === "target" ? view.target : "root",
        candidates: read,
        message: "A blocking inspection needs one exact target selector.",
      });
    }
    if (read.kind === "archived-run") throw new Error("Archived runs are not observable.");
    const resolved = view.kind === "target"
      ? yield* resolveCoherentTarget(state, view.target, pinnedTarget, provesAgentTurn)
      : undefined;
    if (view.kind === "target" && resolved?.kind === "candidates") {
      return yield* Effect.fail<InspectionError>({
        type: "target-ambiguous",
        runId: view.runId,
        target: view.target,
        candidates: resolved.candidates,
        message: "A blocking inspection needs one exact target selector.",
      });
    }
    const events = afterEventSequence === undefined
      ? []
      : yield* state.store.getCommittedRuntimeEventsAfter(state.run.id, afterEventSequence).pipe(
          Effect.mapError(failure => inspectionStoreBusyFailure(state.run.id, failure)),
        );
    return {
      view: read,
      changeView: read.kind === "run"
        ? projectInspectionRunDecisionView({
            ir: state.frozen.ir,
            run: state.run,
            agentSessions: state.read.agentControl.agentSessions,
          })
        : read,
      token: state.read.cursor,
      run: state.run,
      agentSessions: state.read.agentControl.agentSessions,
      events,
      ...(resolved?.kind === "resolved"
        ? { pinnedTarget: resolved.target }
        : {}),
    };
  }));
}

function readCoherentView(
  state: CoherentInspectionRun,
  view: InspectionViewQuery,
  pinnedTarget?: string,
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<InspectionRead, InspectionError> {
  if (view.kind === "run") {
    return Effect.map(coherentRunObservations(state), observations => projectInspectionRunView({
      ir: state.frozen.ir,
      run: state.run,
      agentSessions: state.read.agentControl.agentSessions,
      ...(observations ? { observations } : {}),
      ...(view.structure === "materialized" ? { structure: "materialized" as const } : {}),
    }));
  }
  return Effect.gen(function* () {
    const resolved = yield* resolveCoherentTarget(state, view.target, pinnedTarget, provesAgentTurn);
    if (resolved.kind === "candidates") return resolved.candidates;
    const details = resolved.details;
    if (view.detail === "summary") {
      const observations = yield* coherentTargetObservations(state, details);
      const projected = projectInspectionTargetSummaryView({
        run: state.run,
        details,
        ...(observations ? { observations } : {}),
      });
      const acp = acpSilence(details);
      return {
        ...projected,
        ...(acp === undefined ? {} : { acp }),
      };
    }
    if (view.detail === "forensics") {
      return projectInspectionForensicsView({
        frozen: state.frozen,
        run: state.run,
        details,
      });
    }
    const observations = yield* readRecentTimelineObservations(
      state.store,
      state.run.id,
      recentTimelineAttemptIds(details),
    );
    const events = yield* state.store.getInspectionTimelineEvents(
      state.run.id,
      inspectionTimelineNodeKeys(state.run, details),
      inspectionTimelineEventLimit,
    ).pipe(Effect.mapError(failure => inspectionStoreBusyFailure(state.run.id, failure)));
    return projectInspectionTargetTimelineView({
      run: state.run,
      details,
      events,
      observations,
    });
  });
}

function acpSilence(details: ResolvedTargetState): { silentForMs: number } | undefined {
  if (details.staticNode?.kind !== "agent") return undefined;
  if (terminalInspectionState(inspectionTargetState(details).status)) return undefined;
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
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<CoherentTarget, InspectionError> {
  if (pinnedTarget) {
    const resolved = resolveTargetState({
      ir: state.frozen.ir,
      run: state.run,
      artifacts: state.read.artifacts,
      target: pinnedTarget,
    });
    return resolved
      ? Effect.map(enrichCoherentTarget(state, resolved, provesAgentTurn), details => ({
          kind: "resolved" as const,
          target: pinnedTarget,
          details,
        }))
      : Effect.fail({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
  }
  const staticNodes = inspectionStaticNodes(state.frozen.ir);
  if (target !== "root" && !target.startsWith("@")) {
    const internal = state.run.dynamic?.nodeInstances.some(instance => instance.nodeKey === target)
      || state.run.dynamic?.frames.some(frame => frame.frameKey === target)
      || state.run.dynamic?.attempts.some(attempt => attempt.attemptId === target);
    if (internal) {
      return Effect.fail({ type: "invalid-query", message: "Inspection target must use an authored id, root, or occurrence selector." });
    }
    if (!staticNodes.some(node => node.nodeId === target)) {
      return Effect.fail({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
    }
  }
  const resolution = resolveInspectionTarget({
    run: state.run,
    staticNodes,
    target,
  });
  if (resolution.kind === "not-found") {
    return Effect.fail({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
  }
  if (resolution.kind === "ref-collision") {
    return Effect.fail({ type: "read-failed", runId: state.run.id, message: `Occurrence reference '${target}' could not be resolved safely.` });
  }
  if (resolution.kind === "candidates") {
    return Effect.succeed({ kind: "candidates", candidates: resolution.candidates });
  }
  const details = resolveTargetState({
    ir: state.frozen.ir,
    run: state.run,
    artifacts: state.read.artifacts,
    target: resolution.target,
  });
  return details
    ? Effect.map(enrichCoherentTarget(state, details, provesAgentTurn), enriched => ({
        kind: "resolved" as const,
        target: resolution.target,
        details: enriched,
      }))
    : Effect.fail({ type: "target-not-found", runId: state.run.id, target, message: `Run target '${target}' was not found.` });
}

function enrichCoherentTarget(
  state: CoherentInspectionRun,
  details: ResolvedTargetState,
  provesAgentTurn?: AgentTurnProofLookup,
): Effect.Effect<ResolvedTargetState, InspectionError> {
  return Effect.map(state.schedulerSnapshot(), snapshot => {
    const agentControl = targetAgentControl(state.read.agentControl, details, selectedAttemptFor(details));
    const retrySnapshot = settleRetryControlSnapshot({
      frozen: state.frozen,
      snapshot,
      now: new Date(),
    }).snapshot;
    return {
      ...details,
      run: { ...details.run, agentSessions: state.read.agentControl.agentSessions },
      summary: {
        ...details.summary,
        ...(agentControl.agentSession === undefined ? {} : { agentSession: agentControl.agentSession }),
        ...(agentControl.steer === undefined ? {} : { steer: agentControl.steer }),
      },
      availableControls: targetInspectionControls(
        retrySnapshot,
        snapshot,
        details,
        state.frozen,
        agentControl.agentSession,
        agentControl.turnProof,
        provesAgentTurn,
      ),
    };
  });
}

function coherentTargetObservations(
  state: CoherentInspectionRun,
  details: ResolvedTargetState,
): Effect.Effect<AgentObservationInspectionProjection | undefined, InspectionError> {
  if (details.staticNode?.kind !== "agent") return Effect.succeed(undefined);
  const attemptId = targetAttemptId(details);
  if (!attemptId) return Effect.succeed(undefined);
  return state.store.observationLog.readInspectionProjection({
    runId: state.run.id,
    attemptIds: [attemptId],
    entryLimit: 50,
  }).pipe(Effect.mapError(failure => inspectionObservationFailure(state.run.id, failure)));
}

function coherentRunObservations(
  state: CoherentInspectionRun,
): Effect.Effect<AgentObservationInspectionProjection | undefined, InspectionError> {
  const attemptIds = state.run.dynamic?.attempts
    .filter(attempt => attempt.status === "started")
    .map(attempt => attempt.attemptId) ?? [];
  if (attemptIds.length === 0) return Effect.succeed(undefined);
  return state.store.observationLog.readInspectionProjection({
    runId: state.run.id,
    attemptIds,
    latestTurnPerAttempt: true,
    includeOlderCount: false,
  }).pipe(Effect.mapError(failure => inspectionObservationFailure(state.run.id, failure)));
}

function readCoherentTokenAtStore(
  store: RuntimeStoreShape,
  runId: string,
): Effect.Effect<RunInspectionStoreRead["cursor"], InspectionError> {
  return store.readRunInspectionToken(runId).pipe(
    Effect.mapError(failure => inspectionStoreBusyFailure(runId, failure)),
    Effect.flatMap(token => token
      ? Effect.succeed(token)
      : Effect.fail<InspectionError>({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` })),
  );
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
  events: CommittedRuntimeEventRow[],
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
  events: CommittedRuntimeEventRow[],
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
  event: CommittedRuntimeEventRow,
  subject: import("./types.js").InspectionSubject,
  run: NonNullable<RunInspectionStoreRead["run"]>,
): boolean {
  if (!subject.selector) return false;
  return inspectionEventSelectors(event, run).has(subject.selector);
}

function inspectionEventSelectors(
  event: CommittedRuntimeEventRow,
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
  if (query.updates !== undefined && query.updates !== "decision" && query.updates !== "activity") {
    return { type: "invalid-query", message: "Inspection updates must be 'decision' or 'activity'." };
  }
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

export function inspectNode(
  cwd: string,
  query: InspectNodeQuery,
): Effect.Effect<RunInspectionNodeDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return Effect.fail(invalid);
  return withInspectionRun(cwd, query.runId, state => Effect.gen(function* () {
    const resolved = yield* resolveTarget(state, query.target, true);
    if (resolved.kind === "candidates") return yield* Effect.fail(targetAmbiguous(query.runId, query.target, resolved.candidates));
    const details = resolved.details;
    return {
      schemaVersion: 2,
      kind: "node",
      run: details.run,
      subject: inspectionSubject(details),
      state: inspectionTargetState(details),
      summary: details.summary,
      availableControls: details.availableControls,
      artifacts: details.artifacts,
    } satisfies RunInspectionNodeDocument;
  }));
}

export function inspectAgentExecution(
  cwd: string,
  query: InspectAgentExecutionQuery,
): Effect.Effect<RunInspectionAgentExecutionDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return Effect.fail(invalid);
  return withInspectionRun(cwd, query.runId, state => Effect.gen(function* () {
    const resolved = yield* resolveTarget(state, query.target);
    if (resolved.kind === "candidates") return yield* Effect.fail(targetAmbiguous(query.runId, query.target, resolved.candidates));
    const attemptId = resolved.details.staticNode?.kind === "agent"
      ? targetAttemptId(resolved.details)
      : undefined;
    const observations = attemptId === undefined
      ? undefined
      : yield* state.store.observationLog.readInspectionProjection({
          runId: query.runId,
          attemptIds: [attemptId],
          entryLimit: 50,
          latestTurnPerAttempt: true,
        }).pipe(Effect.mapError(failure => runInspectionObservationFailure(query.runId, failure)));
    return projectAgentExecution({
      details: resolved.details,
      ...(observations === undefined ? {} : { observations }),
    });
  }));
}

export function inspectTargetArtifacts(
  cwd: string,
  query: InspectTargetArtifactsQuery,
): Effect.Effect<RunInspectionTargetArtifactsDocument, RunInspectionError> {
  const invalid = validateTargetQuery(query.target);
  if (invalid) return Effect.fail(invalid);
  return withInspectionRun(cwd, query.runId, state => Effect.gen(function* () {
    const resolved = yield* resolveTarget(state, query.target);
    if (resolved.kind === "candidates") return yield* Effect.fail(targetAmbiguous(query.runId, query.target, resolved.candidates));
    const details = resolved.details;
    return {
      schemaVersion: 2,
      kind: "artifacts",
      run: { id: details.run.id, status: details.run.status, updatedAt: details.run.updatedAt },
      subject: inspectionSubject(details),
      artifacts: details.artifacts,
    } satisfies RunInspectionTargetArtifactsDocument;
  }));
}

type InspectionRun = {
  store: RuntimeStoreShape;
  read: RunInspectionStoreRead;
  run: NonNullable<RunInspectionStoreRead["run"]>;
  frozen: NonNullable<RunInspectionStoreRead["frozen"]>;
  schedulerSnapshot(): Effect.Effect<SchedulerSnapshot, RunInspectionError>;
  retrySchedulerSnapshot(): Effect.Effect<SchedulerSnapshot, RunInspectionError>;
};

type ResolvedInspectionTarget =
  | { kind: "resolved"; target: string; details: ResolvedTargetState }
  | { kind: "candidates"; candidates: InspectionCandidates };

function withInspectionRun<T>(
  cwd: string,
  runId: string,
  project: (state: InspectionRun) => Effect.Effect<T, RunInspectionError>,
): Effect.Effect<T, RunInspectionError> {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd).pipe(
      Effect.mapError(failure => inspectionRuntimeReadFailure(runId, failure)),
    );
    if (!session) return yield* Effect.fail<RunInspectionError>({
      type: "runtime-store-not-found",
      message: "Runtime store was not found.",
    });
    const runtimeStore = session.store;
    const ownership = yield* readAgentSessionOwnershipHealth(cwd, runtimeStore).pipe(
      Effect.mapError(failure => inspectionStoreBusyFailure(runId, failure)),
    );
    return yield* runtimeStore.withRunInspectionSnapshot(Effect.gen(function* () {
      const read = withStoreReadOwnershipHealth(
        yield* runtimeStore.readRunInspection(runId),
        ownership,
      );
      if (!read.run) return yield* Effect.fail<RunInspectionError>({
        type: "run-not-found",
        runId,
        message: `Run '${runId}' was not found.`,
      });
      if (!read.frozen) throw new Error(`Frozen workflow for run '${runId}' was not found.`);
      let scheduler: SchedulerSnapshot | undefined;
      const schedulerSnapshot = (): Effect.Effect<SchedulerSnapshot, RunInspectionError> => scheduler === undefined
        ? loadSchedulerSnapshot(runtimeStore, runId).pipe(
            Effect.mapError(failure => inspectionStoreBusyFailure(runId, failure)),
            Effect.tap(value => Effect.sync(() => {
              scheduler = value;
            })),
          )
        : Effect.succeed(scheduler);
      let retryScheduler: SchedulerSnapshot | undefined;
      const retrySchedulerSnapshot = (): Effect.Effect<SchedulerSnapshot, RunInspectionError> => retryScheduler === undefined
        ? schedulerSnapshot().pipe(Effect.map(snapshot => {
            retryScheduler = settleRetryControlSnapshot({
              frozen: read.frozen!,
              snapshot,
              now: new Date(),
            }).snapshot;
            return retryScheduler;
          }))
        : Effect.succeed(retryScheduler);
      return yield* project({
        store: runtimeStore,
        read,
        run: read.run,
        frozen: read.frozen,
        schedulerSnapshot,
        retrySchedulerSnapshot,
      });
    })).pipe(
      Effect.catchIf(
        (failure): failure is RuntimeStoreBusy => isRuntimeStoreBusy(failure),
        failure => Effect.fail(inspectionStoreBusyFailure(runId, failure)),
      ),
    );
  }));
}

function resolveTarget(
  state: InspectionRun,
  target: string,
  includeControls = false,
): Effect.Effect<ResolvedInspectionTarget, RunInspectionError> {
  const resolution = resolveInspectionTarget({
    run: state.run,
    staticNodes: inspectionStaticNodes(state.frozen.ir),
    target,
  });
  if (resolution.kind === "not-found") return Effect.fail(targetNotFound(state.run.id, target));
  if (resolution.kind === "ref-collision") {
    return Effect.fail({
      type: "target-ref-collision",
      runId: state.run.id,
      target,
      candidateKeys: resolution.candidateKeys,
      message: `Occurrence reference '${target}' is not unique in this run; use one of: ${resolution.candidateKeys.join(", ")}.`,
    });
  }
  if (resolution.kind === "candidates") return Effect.succeed({ kind: "candidates", candidates: resolution.candidates });
  const base = resolveTargetState({
    ir: state.frozen.ir,
    run: state.run,
    artifacts: state.read.artifacts,
    target: resolution.target,
  });
  if (!base) return Effect.fail(targetNotFound(state.run.id, target));
  return Effect.gen(function* () {
    const agentControl = targetAgentControl(state.read.agentControl, base, selectedAttemptFor(base));
    const controls = includeControls
      ? targetInspectionControls(
          yield* state.retrySchedulerSnapshot(),
          yield* state.schedulerSnapshot(),
          base,
          state.frozen,
          agentControl.agentSession,
        )
      : base.availableControls;
    return {
      kind: "resolved" as const,
      target: resolution.target,
      details: {
        ...base,
        run: { ...base.run, agentSessions: state.read.agentControl.agentSessions },
        summary: {
          ...base.summary,
          ...(agentControl.agentSession === undefined ? {} : { agentSession: agentControl.agentSession }),
          ...(agentControl.steer === undefined ? {} : { steer: agentControl.steer }),
        },
        availableControls: controls,
      },
    };
  });
}

function selectedAttemptFor(details: ResolvedTargetState): ResolvedTargetState["attempts"][number] | undefined {
  return details.target.kind === "attempt"
    ? details.attempts.find(attempt => attempt.attemptId === details.target.id)
    : undefined;
}

function targetAgentControl(
  control: RunInspectionStoreRead["agentControl"],
  details: ResolvedTargetState,
  selectedAttempt: ResolvedTargetState["attempts"][number] | undefined,
): {
  agentSession?: RunInspectionTargetSummary["agentSession"];
  steer?: RunInspectionTargetSummary["steer"];
  turnProof?: AgentTurnProof;
} {
  const attemptIds = new Set(selectedAttempt
    ? [selectedAttempt.attemptId]
    : details.attempts.map(attempt => attempt.attemptId));
  const agentSession = control.agentSessions.filter(session => attemptIds.has(session.currentBinding.attemptId))
    .sort((left, right) => right.generation - left.generation)[0];
  const nodeKey = selectedAttempt?.nodeKey ?? details.summary.nodeKey;
  const steer = nodeKey === undefined
    ? undefined
    : control.steers.filter(candidate => candidate.nodeKey === nodeKey).at(-1)?.projection;
  const turnProof = agentSession === undefined
    ? undefined
    : control.turnProofs.find(candidate => candidate.attemptId === agentSession.currentBinding.attemptId);
  return {
    ...(agentSession === undefined ? {} : { agentSession }),
    ...(steer === undefined ? {} : { steer }),
    ...(turnProof === undefined ? {} : { turnProof }),
  };
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
  agentSession?: RunInspectionTargetSummary["agentSession"],
  turnProof?: AgentTurnProof,
  provesAgentTurn?: AgentTurnProofLookup,
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
  const effectiveAttempt = selectedAttempt ?? details.attempts
    .filter(attempt => details.summary.nodeKey === undefined || attempt.nodeKey === details.summary.nodeKey)
    .sort((left, right) => right.attemptNo - left.attemptNo)[0];
  const agentNode = frozen && details.staticNode?.kind === "agent"
    ? indexNodes(frozen.ir.root).get(details.staticNode.nodeId)
    : undefined;
  const controls: RunInspectionControl[] = [];
  if (agentNode?.kind === "agent") {
    const active = effectiveAttempt?.status === "started";
    if (active && frozen
      && effectiveAttempt
      && agentSession !== undefined
      && (agentSession.checkpoint.value === "owned_in_flight" || agentSession.checkpoint.value === "provider_observed")
      && turnProof !== undefined
      && provesAgentTurn?.(turnProof) === true
      && steerControlTargets(frozen, cancelSnapshot).some(candidate => candidate.attemptId === effectiveAttempt.attemptId)) {
      controls.push({
        type: "steer",
        target: effectiveAttempt.attemptId,
        delivery: "interrupt_continue",
        effect: "cancel_drain_then_continue",
      });
      const cancel = planCancelControl(cancelSnapshot, target);
      if (Result.isSuccess(cancel) && cancel.success.events.length > 0 && cancel.success.resolvedTarget) {
        controls.push({ type: "cancel", target: cancel.success.resolvedTarget });
      }
      return controls;
    }
  }
  const allowRetry = selectedAttempt === undefined
    || selectedAttempt.status === "failed"
    || selectedAttempt.status === "timed_out";
  const allowCancel = selectedAttempt === undefined
    || selectedAttempt.status === "started";
  if (allowRetry) {
    const retry = planRetryControl(retrySnapshot, target);
    const impact = Result.isSuccess(retry) && frozen !== undefined
      ? planRetrySessionImpact({ frozen, snapshot: retrySnapshot, reexecutedNodeKeys: retry.success.reexecutedNodeKeys })
      : undefined;
    if (Result.isSuccess(retry) && impact !== undefined && Result.isSuccess(impact)) controls.push({ type: "retry", target: retry.success.resolvedTarget });
  }
  if (allowCancel) {
    const cancel = planCancelControl(cancelSnapshot, target);
    if (Result.isSuccess(cancel) && cancel.success.events.length > 0 && cancel.success.resolvedTarget) {
      controls.push({ type: "cancel", target: cancel.success.resolvedTarget });
    }
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

function readRecentTimelineObservations(
  store: RuntimeStoreShape,
  runId: string,
  attemptIds: readonly string[],
): Effect.Effect<AgentObservationInspectionProjection, InspectionError> {
  return store.observationLog.readInspectionProjection({
    runId,
    attemptIds,
    entryLimit: inspectionTimelineEntryLimit,
    includeOlderCount: false,
  }).pipe(Effect.mapError(failure => inspectionObservationFailure(runId, failure)));
}

function loadSchedulerSnapshot(
  store: RuntimeStoreShape,
  runId: string,
): Effect.Effect<SchedulerSnapshot, RuntimeStoreBusy> {
  return store.scheduler.tryLoadRunSnapshot(runId).pipe(
    Effect.catchIf(
      (failure): failure is SchedulerStoreError => !isRuntimeStoreBusy(failure),
      failure => Effect.die(failure),
    ),
  );
}

function inspectionObservationFailure(
  runId: string,
  failure: AgentObservationReadError | RuntimeStoreBusy,
): InspectionError {
  return isRuntimeStoreBusy(failure)
    ? inspectionStoreBusyFailure(runId, failure)
    : { type: "read-failed", runId, message: failure.message };
}

function runInspectionObservationFailure(
  runId: string,
  failure: AgentObservationReadError | RuntimeStoreBusy,
): RunInspectionError {
  return isRuntimeStoreBusy(failure)
    ? inspectionStoreBusyFailure(runId, failure)
    : {
        type: "inspection-read-failed",
        runId,
        message: failure.message,
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      };
}

function inspectionStoreBusyFailure(
  runId: string,
  failure: RuntimeStoreBusy,
): Extract<InspectionError, { type: "runtime-store-unavailable" }> {
  return {
    type: "runtime-store-unavailable",
    runId,
    message: failure.message,
  };
}

function isRuntimeStoreBusy(failure: unknown): failure is RuntimeStoreBusy {
  return typeof failure === "object" && failure !== null
    && "type" in failure && failure.type === "runtime-store-busy";
}

function inspectionRuntimeReadFailure(
  runId: string,
  failure: RuntimeReadFailure,
): Extract<InspectionError, { type: RuntimeReadFailure["type"] }> {
  if (failure.type === "runtime-store-repair-required") {
    return {
      ...failure,
      runId,
    };
  }
  return {
    ...failure,
    runId,
  };
}
