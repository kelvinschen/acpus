import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
  openExistingRuntimeStore,
  withRunInspectionSnapshot,
  type RunInspectionStoreRead,
} from "../store/store.js";
import {
  planCancelControl,
  planRetryControl,
  retryControlTargets,
  settleRetryControlSnapshot,
} from "../scheduler/control-plan.js";
import {
  throwSchedulerStoreResult,
  type SchedulerSnapshot,
} from "../scheduler/store-port.js";
import {
  ambiguousTimelineCandidates,
  projectTargetSummary,
  projectTimeline,
  resolvedTargetIdentity,
  targetAttemptId,
  timelineAttemptIds,
} from "./decision-projection.js";
import { projectAgentExecution } from "./agent-execution-projection.js";
import {
  inspectionItems,
  progressChanges,
  projectRunInspection,
  semanticChanges,
  terminalRun,
} from "./projection.js";
import {
  decodeTimelinePageCursor,
  inspectionTargetFingerprint,
} from "./timeline-cursor.js";
import type {
  FollowRunInspectionQuery,
  FollowableInspectionDocument,
  RunInspectionDelta,
  RunInspectionDocument,
  RunInspectionEmission,
  RunInspectionError,
  RunInspectionPatch,
  RunInspectionQuery,
  RunInspectionSnapshot,
  RunInspectionCurrentActivityPatch,
  RunInspectionControl,
  RunInspectionTargetDetailsDocument,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
} from "./types.js";

const responseEmissionBytes = 512;
const activityEmissionIntervalMs = 10_000;

export function getRunInspection(cwd: string, query: RunInspectionQuery): ResultAsync<RunInspectionDocument, RunInspectionError> {
  return new ResultAsync(readInspection(cwd, query));
}

export async function* followRunInspection(
  cwd: string,
  query: FollowRunInspectionQuery,
): AsyncIterable<Result<RunInspectionEmission, RunInspectionError>> {
  const validation = validateFollowQuery(query);
  if (validation) {
    yield err(validation);
    return;
  }

  const cycle = await readFollowCycle(cwd, query);
  if (cycle.isErr()) {
    yield err(cycle.error);
    return;
  }
  let current = cycle.value.document;
  let cursor = cycle.value.cursor;
  let emitted = withoutWorkflowOutput(current);
  let lastEmissionAt = Date.now();

  yield okEmission({ schemaVersion: 2, kind: "snapshot", document: emitted });

  if (terminalRun(current.run.status)) {
    yield okEmission(doneEmission(query, cycle.value));
    return;
  }

  while (!query.signal?.aborted) {
    await delay(query.intervalMs ?? 3_000, query.signal);
    if (query.signal?.aborted) return;
    const next = await readFollowCycle(cwd, query, cursor.eventSequence);
    if (next.isErr()) {
      yield err(next.error);
      return;
    }
    const previousCurrent = current;
    current = next.value.document;
    const nextCursor = next.value.cursor;
    const isTerminal = terminalRun(current.run.status);
    const cursorGap = hasCursorGap(cursor.eventSequence, nextCursor.eventSequence, next.value.events);
    const projectionDrift = incompatibleProjection(previousCurrent, current);

    if (cursorGap || projectionDrift) {
      emitted = withoutWorkflowOutput(current);
      lastEmissionAt = Date.now();
      yield okEmission({
        schemaVersion: 2,
        kind: "resync",
        reason: cursorGap ? "cursor-gap" : "projection-drift",
        document: emitted,
      });
    } else {
      const nowMs = Date.now();
      const changes = inspectionDeltas(
        emitted,
        current,
        next.value.events,
        next.value.run,
        nextCursor.progressVersion === cursor.progressVersion
          ? undefined
          : nextCursor.progressVersion,
        isTerminal,
        lastEmissionAt,
        nowMs,
      );
      if (changes.length > 0) {
        emitted = withoutWorkflowOutput(current);
        lastEmissionAt = nowMs;
        yield okEmission({ schemaVersion: 2, kind: "delta", changes });
      }
    }
    cursor = nextCursor;
    if (isTerminal) {
      yield okEmission(doneEmission(query, next.value));
      return;
    }
  }
}

async function readInspection(
  cwd: string,
  query: RunInspectionQuery,
): Promise<Result<RunInspectionDocument, RunInspectionError>> {
  const result = await readInspectionCycle(cwd, query);
  return result.map(value => value.document);
}

async function readFollowCycle(
  cwd: string,
  query: FollowRunInspectionQuery,
  eventSequence?: number,
): Promise<Result<FollowCycle, RunInspectionError>> {
  const cycle = await readInspectionCycle(cwd, query, eventSequence);
  if (cycle.isErr()) return err(cycle.error);
  if (!followableDocument(cycle.value.document)) {
    return err({ type: "invalid-query", message: "This inspection view cannot be followed." });
  }
  return ok({ ...cycle.value, document: cycle.value.document });
}

async function readInspectionCycle(
  cwd: string,
  query: RunInspectionQuery,
  eventSequence?: number,
): Promise<Result<InspectionCycle, RunInspectionError>> {
  try {
    const invalid = validateInspectionQuery(query);
    if (invalid) return err(invalid);
    const store = await openExistingRuntimeStore(cwd);
    if (!store) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
    try {
      return await withRunInspectionSnapshot(store, async () => {
        const read = store.readRunInspection(query.runId, eventSequence);
        if (!read.run) {
          return err({
            type: "run-not-found",
            runId: query.runId,
            message: `Run '${query.runId}' was not found.`,
          });
        }
        if (!read.frozen) throw new Error(`Frozen workflow for run '${query.runId}' was not found.`);
        const run = read.run;
        let scheduler: SchedulerSnapshot | undefined;
        const schedulerSnapshot = () => {
          scheduler ??= throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(query.runId));
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

        if (query.mode === "overview" || query.mode === "all" || query.mode === "raw") {
          const document = projectRunInspection({
            ir: read.frozen.ir,
            run,
            artifacts: read.artifacts,
            query,
            ...(query.mode === "raw"
              ? {}
              : { availableControls: retryInspectionControls(retrySchedulerSnapshot()) }),
          });
          if (!document) throw new Error("Run inspection projection failed.");
          return ok(followCycle(read, document));
        }

        const detailsQuery = {
          runId: query.runId,
          mode: "details" as const,
          target: query.target,
          ...("context" in query && query.context ? { context: query.context } : {}),
        };
        const projectedDetails = projectRunInspection({
          ir: read.frozen.ir,
          run,
          artifacts: read.artifacts,
          query: detailsQuery,
        });
        if (!projectedDetails || projectedDetails.kind !== "details") {
          return err({
            type: "target-not-found",
            runId: query.runId,
            target: query.target,
            message: `Run target '${query.target}' was not found.`,
          });
        }
        if (query.mode === "execution") {
          const candidates = ambiguousTimelineCandidates(projectedDetails);
          if (candidates.length > 1) {
            return err({
              type: "target-ambiguous",
              runId: query.runId,
              target: query.target,
              candidateKeys: candidates,
              message: `Run target '${query.target}' matches multiple occurrences: ${candidates.join(", ")}.`,
            });
          }
          const selectedAttemptId = projectedDetails.staticNode?.kind === "agent"
            ? projectedDetails.summary.latestAttempt?.attemptId
            : undefined;
          const observationResult = selectedAttemptId
            ? await store.observationLog.readInspectionProjection({
                runId: query.runId,
                attemptIds: [selectedAttemptId],
                entryLimit: 50,
                latestTurnOnly: true,
              })
            : undefined;
          if (observationResult?.isErr()) throw observationResult.error;
          return ok(followCycle(read, projectAgentExecution({
            details: projectedDetails,
            ...(observationResult?.isOk() ? { observations: observationResult.value } : {}),
          })));
        }
        const details = {
          ...projectedDetails,
          availableControls: targetInspectionControls(
            retrySchedulerSnapshot(),
            schedulerSnapshot(),
            projectedDetails,
          ),
        } satisfies RunInspectionTargetDetailsDocument;
        if (query.mode === "details") return ok(followCycle(read, details));

        if (query.mode === "target") {
          const selectedAgentAttempt = details.staticNode?.kind === "agent"
            ? targetAttemptId(details)
            : undefined;
          const observationResult = selectedAgentAttempt
              ? await store.observationLog.readInspectionProjection({
                runId: query.runId,
                attemptIds: [selectedAgentAttempt],
              })
            : undefined;
          if (observationResult?.isErr()) throw observationResult.error;
          const runDir = details.target.kind === "attempt"
            ? store.getRunDir(query.runId)
            : undefined;
          const document = projectTargetSummary({
            run,
            details,
            ...(observationResult?.isOk() ? { observations: observationResult.value } : {}),
            ...(runDir ? { runDir } : {}),
          });
          return ok(followCycle(read, document));
        }

        const candidates = ambiguousTimelineCandidates(details);
        if (candidates.length > 1) {
          return err({
            type: "target-ambiguous",
            runId: query.runId,
            target: query.target,
            candidateKeys: candidates,
            message: `Run target '${query.target}' matches multiple occurrences: ${candidates.join(", ")}.`,
          });
        }
        const resolved = resolvedTargetIdentity(details);
        const before = query.page?.before ? decodeTimelinePageCursor(query.page.before) : undefined;
        if (query.page?.before && (!before
          || before.runId !== query.runId
          || before.target !== inspectionTargetFingerprint(resolved))) {
          return err({
            type: "invalid-cursor",
            runId: query.runId,
            target: query.target,
            message: "Timeline page cursor does not match the run and resolved target.",
          });
        }
        const observationResult = await store.observationLog.readInspectionProjection({
          runId: query.runId,
          attemptIds: timelineAttemptIds(details),
          entryLimit: 50,
          ...(before?.beforeEntry === undefined
            ? {}
            : { beforeEntry: before.beforeEntry }),
        });
        if (observationResult.isErr()) throw observationResult.error;
        if (before?.beforeEntry && observationResult.value.beforeEntryRetained === false) {
          return err({
            type: "invalid-cursor",
            runId: query.runId,
            target: query.target,
            message: "Timeline page cursor has expired from bounded history.",
          });
        }
        const document = projectTimeline({
          run,
          details,
          query,
          events: store.getCommittedRuntimeEventsAfter(query.runId, 0),
          observations: observationResult.value,
          ...(before ? { before: { at: before.at, id: before.id, ordinal: before.ordinal } } : {}),
        });
        return ok(followCycle(read, document));
      });
    } finally {
      store.close();
    }
  } catch (error) {
    return err(inspectionError(query.runId, error));
  }
}

function retryInspectionControls(snapshot: SchedulerSnapshot): RunInspectionControl[] {
  return retryControlTargets(snapshot)
    .map(({ target }) => ({ type: "retry" as const, target }));
}

function targetInspectionControls(
  retrySnapshot: SchedulerSnapshot,
  cancelSnapshot: SchedulerSnapshot,
  details: RunInspectionTargetDetailsDocument,
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
  return controls;
}

function inspectionControlTarget(
  details: RunInspectionTargetDetailsDocument,
  selectedAttempt: RunInspectionTargetDetailsDocument["attempts"][number] | undefined,
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

type InspectionCycle = {
  document: RunInspectionDocument;
  events: RunInspectionStoreRead["events"];
  cursor: RunInspectionStoreRead["cursor"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  output?: JsonValue;
};

type FollowCycle = Omit<InspectionCycle, "document"> & {
  document: FollowableInspectionDocument;
};

function followCycle(
  read: RunInspectionStoreRead,
  document: RunInspectionDocument,
): InspectionCycle {
  return {
    document,
    events: read.events,
    cursor: read.cursor,
    run: read.run!,
    ...(read.run?.output === undefined ? {} : { output: read.run.output }),
  };
}

function followableDocument(document: RunInspectionDocument): document is FollowableInspectionDocument {
  return document.kind === "snapshot" || document.kind === "target" || document.kind === "timeline";
}

function validateInspectionQuery(query: RunInspectionQuery): RunInspectionError | undefined {
  if ("target" in query && query.target.trim().length === 0) {
    return { type: "invalid-query", message: "Inspection target must not be blank." };
  }
  if (query.mode !== "timeline") return undefined;
  const limit = query.page?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
    return { type: "invalid-query", message: "Timeline limit must be an integer from 1 through 50." };
  }
  return undefined;
}

function validateFollowQuery(query: FollowRunInspectionQuery): RunInspectionError | undefined {
  const invalid = validateInspectionQuery(query);
  if (invalid) return invalid;
  const intervalMs = query.intervalMs ?? 3_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    return { type: "invalid-query", message: "Inspection follow interval must be an integer of at least 250ms." };
  }
  if (query.mode === "timeline" && query.page?.before) {
    return { type: "invalid-query", message: "Timeline pagination cannot be combined with follow." };
  }
  return undefined;
}

function inspectionDeltas(
  previous: FollowableInspectionDocument,
  current: FollowableInspectionDocument,
  events: RunInspectionStoreRead["events"],
  run: NonNullable<RunInspectionStoreRead["run"]>,
  progressVersion: number | undefined,
  terminal: boolean,
  lastEmissionAt: number,
  nowMs: number,
): RunInspectionDelta[] {
  if (previous.kind !== current.kind) return [];
  if (current.kind === "snapshot" && previous.kind === "snapshot") {
    if (!terminal
      && events.length === 0
      && !overviewAgentStructureChanged(previous, current)
      && nowMs - lastEmissionAt < activityEmissionIntervalMs) return [];
    const changes = [
      ...semanticChanges(events, current, run),
      ...(progressVersion === undefined ? [] : progressChanges(previous, current, progressVersion)),
    ];
    const delta = itemDelta(previous.items, current.items);
    const patch = inspectionPatch(previous, current, delta);
    return changes.length === 0 && !patchChanged(patch) && sameDurableRun(previous.run, current.run)
      ? []
      : [{ kind: "overview", run: current.run, changes, patch }];
  }
  if (current.kind === "target" && previous.kind === "target") {
    return targetDeltas(previous, current, terminal, lastEmissionAt, nowMs);
  }
  if (current.kind === "timeline" && previous.kind === "timeline") {
    return timelineDeltas(previous, current, terminal, lastEmissionAt, nowMs);
  }
  return [];
}

function overviewAgentStructureChanged(previous: RunInspectionSnapshot, current: RunInspectionSnapshot): boolean {
  const before = new Map(previous.items.map(item => [item.key, overviewAgentStructure(item)]));
  return current.items.some(item => before.get(item.key) !== overviewAgentStructure(item));
}

function overviewAgentStructure(item: RunInspectionSnapshot["items"][number]): string {
  const { updatedAt: _updatedAt, ...stableItem } = item;
  return JSON.stringify(stableItem);
}

function targetDeltas(
  previous: RunInspectionTargetSummaryDocument,
  current: RunInspectionTargetSummaryDocument,
  terminal: boolean,
  lastEmissionAt: number,
  nowMs: number,
): RunInspectionDelta[] {
  const changes: RunInspectionDelta[] = [];
  const runChanged = previous.run.status !== current.run.status;
  const stateChanged = !equal(previous.state, current.state);
  const attentionChanged = !equal(previous.attention, current.attention);
  const visibilityChanged = !equal(previous.visibility, current.visibility);
  const actionsChanged = !equal(previous.availableActions, current.availableActions);
  const evidenceChanged = !equal(previous.evidence, current.evidence);
  if (runChanged) changes.push({ kind: "run", run: current.run });
  if (stateChanged) changes.push({ kind: "state", state: current.state });
  const pulseChanged = !equal(meaningfulPulse(previous.pulse), meaningfulPulse(current.pulse));
  const pulsePhaseChanged = previous.pulse?.phase !== current.pulse?.phase;
  if (pulseChanged && (terminal
    || pulsePhaseChanged
    || runChanged
    || stateChanged
    || attentionChanged
    || visibilityChanged
    || actionsChanged
    || evidenceChanged
    || nowMs - lastEmissionAt >= activityEmissionIntervalMs)) {
    changes.push({ kind: "pulse", pulse: current.pulse ?? null });
  }
  if (attentionChanged) {
    changes.push({ kind: "attention", attention: current.attention ?? null });
  }
  if (visibilityChanged) changes.push({ kind: "visibility", visibility: current.visibility ?? null });
  if (actionsChanged) {
    changes.push({ kind: "available-actions", availableActions: current.availableActions });
  }
  if (evidenceChanged) changes.push({ kind: "evidence", evidence: current.evidence ?? null });
  return changes;
}

function timelineDeltas(
  previous: RunInspectionTimelineDocument,
  current: RunInspectionTimelineDocument,
  terminal: boolean,
  lastEmissionAt: number,
  nowMs: number,
): RunInspectionDelta[] {
  const changes: RunInspectionDelta[] = [];
  const runChanged = previous.run.status !== current.run.status;
  const stateChanged = !equal(previous.state, current.state);
  const visibilityChanged = !equal(previous.visibility, current.visibility);
  if (runChanged) changes.push({ kind: "run", run: current.run });
  if (stateChanged) changes.push({ kind: "state", state: current.state });
  if (visibilityChanged) changes.push({ kind: "visibility", visibility: current.visibility ?? null });
  const before = new Map(previous.recent.entries.map(entry => [entry.id, JSON.stringify(entry)]));
  const upsert = current.recent.entries.filter(entry => before.get(entry.id) !== JSON.stringify(entry));
  const previousOrder = previous.recent.entries.map(entry => entry.id);
  const currentOrder = current.recent.entries.map(entry => entry.id);
  const pageChanged = !equal(timelinePageMetadata(previous), timelinePageMetadata(current));
  const semanticBoundary = upsert.some(entry =>
    entry.kind !== "activity" || entry.channel === "tool");
  if (upsert.length > 0 || !equal(previousOrder, currentOrder) || pageChanged) {
    changes.push({
      kind: "recent",
      upsert,
      order: currentOrder,
      page: timelinePageMetadata(current),
    });
  }
  if (meaningfulCurrentChanged(
    previous.current,
    current.current,
    terminal || runChanged || stateChanged || visibilityChanged || semanticBoundary,
    lastEmissionAt,
    nowMs,
  )) {
    const patch = currentActivityPatch(previous.current, current.current);
    changes.push(patch
      ? { kind: "current-patch", patch }
      : { kind: "current", current: current.current ?? null });
  }
  return changes;
}

function timelinePageMetadata(
  document: RunInspectionTimelineDocument,
): Omit<RunInspectionTimelineDocument["recent"], "entries"> {
  const { entries: _entries, ...page } = document.recent;
  return page;
}

function currentActivityPatch(
  previous: RunInspectionTimelineDocument["current"],
  current: RunInspectionTimelineDocument["current"],
): RunInspectionCurrentActivityPatch | undefined {
  if (!previous || !current || currentActivityIdentity(previous) !== currentActivityIdentity(current)) {
    return undefined;
  }
  const stable = current.kind === "agent"
    ? new Set(["kind", "attemptId", "attemptNo", "turn", "turnKind"])
    : new Set(["kind"]);
  const changes: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (stable.has(key) || equal(
      (previous as unknown as Record<string, unknown>)[key],
      (current as unknown as Record<string, unknown>)[key],
    )) continue;
    changes[key] = key in current
      ? (current as unknown as Record<string, unknown>)[key]
      : null;
  }
  return (current.kind === "agent"
    ? {
        kind: "agent",
        attemptId: current.attemptId,
        ...(current.attemptNo === undefined ? {} : { attemptNo: current.attemptNo }),
        ...(current.turn === undefined ? {} : { turn: current.turn }),
        ...(current.turnKind === undefined ? {} : { turnKind: current.turnKind }),
        changes,
      }
    : { kind: current.kind, changes }) as RunInspectionCurrentActivityPatch;
}

function currentActivityIdentity(
  current: NonNullable<RunInspectionTimelineDocument["current"]>,
): string {
  return current.kind === "agent"
    ? `${current.kind}\0${current.attemptId}\0${current.attemptNo ?? ""}\0${current.turn ?? ""}\0${current.turnKind ?? ""}`
    : current.kind;
}

function meaningfulCurrentChanged(
  previous: RunInspectionTimelineDocument["current"],
  current: RunInspectionTimelineDocument["current"],
  force: boolean,
  lastEmissionAt: number,
  nowMs: number,
): boolean {
  if (equal(previous, current)) return false;
  if (previous?.kind !== current?.kind || !previous || !current) return true;
  const { updatedAt: _previousUpdatedAt, ...previousMeaningful } = previous;
  const { updatedAt: _currentUpdatedAt, ...currentMeaningful } = current;
  if (equal(previousMeaningful, currentMeaningful)) return false;
  if (force) return true;
  if (previous.phase !== current.phase) return true;
  if (current.kind !== "agent" || previous.kind !== "agent") return true;
  if (toolsRequireImmediateEmission(previous.tools, current.tools)) return true;
  const previousBytes = previous.response?.originalBytes ?? 0;
  const currentBytes = current.response?.originalBytes ?? 0;
  if (currentBytes - previousBytes >= responseEmissionBytes) return true;
  const previousIntentBytes = previous.intent?.excerpt.originalBytes ?? 0;
  const currentIntentBytes = current.intent?.excerpt.originalBytes ?? 0;
  if (previous.intent?.kind !== current.intent?.kind
    || currentIntentBytes - previousIntentBytes >= responseEmissionBytes) return true;
  if (toolPayloadBytes(current.tools) - toolPayloadBytes(previous.tools) >= responseEmissionBytes) return true;
  return nowMs - lastEmissionAt >= activityEmissionIntervalMs;
}

function toolsRequireImmediateEmission(
  previous: Extract<RunInspectionTimelineDocument["current"], { kind: "agent" }>["tools"],
  current: Extract<RunInspectionTimelineDocument["current"], { kind: "agent" }>["tools"],
): boolean {
  const previousActive = previous?.active ?? [];
  const currentActive = current?.active ?? [];
  if (!equal(previousActive.map(toolIdentity), currentActive.map(toolIdentity))) return true;
  const previousStatuses = previousActive
    .map(tool => [toolIdentity(tool), tool.status] as const);
  const currentStatuses = new Map(
    currentActive.map(tool => [toolIdentity(tool), tool.status] as const),
  );
  return previousStatuses.some(([identity, status]) => {
    const next = currentStatuses.get(identity);
    return status !== next && (next === "completed" || next === "failed" || next === "cancelled" || next === "canceled");
  });
}

function toolIdentity(
  tool: NonNullable<Extract<RunInspectionTimelineDocument["current"], { kind: "agent" }>["tools"]>["active"][number] | undefined,
): string {
  return tool ? `${tool.toolCallId ?? ""}\0${tool.name}\0${tool.startedAt ?? ""}` : "";
}

function toolPayloadBytes(
  tools: Extract<RunInspectionTimelineDocument["current"], { kind: "agent" }>["tools"],
): number {
  return (tools?.active ?? [])
    .reduce((total, tool) =>
      total + (tool.input?.originalBytes ?? 0) + (tool.output?.originalBytes ?? 0), 0);
}

function meaningfulPulse(pulse: RunInspectionTargetSummaryDocument["pulse"]): unknown {
  if (!pulse) return undefined;
  const { updatedAt: _updatedAt, ...meaningful } = pulse;
  return meaningful;
}

function inspectionPatch(
  previous: RunInspectionSnapshot,
  current: RunInspectionSnapshot,
  delta: Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder">,
): RunInspectionPatch {
  const patch: RunInspectionPatch = delta;
  if (!equal(previous.counts, current.counts)) patch.counts = current.counts;
  if (!equal(previous.availableActions, current.availableActions)) {
    patch.availableActions = current.availableActions;
  }
  if (!equal(previous.omitted, current.omitted)) patch.omitted = current.omitted ?? null;
  if (!equal(previous.hooks ?? [], current.hooks ?? [])) patch.hooks = current.hooks ?? [];
  return patch;
}

function itemDelta(
  previous: ReturnType<typeof inspectionItems>,
  current: ReturnType<typeof inspectionItems>,
): Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder"> {
  const before = new Map(previous.map(item => [item.key, JSON.stringify(item)]));
  const after = new Set(current.map(item => item.key));
  const delta: Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder"> = {
    upsertItems: current.filter(item => before.get(item.key) !== JSON.stringify(item)),
    removeItemKeys: previous.filter(item => !after.has(item.key)).map(item => item.key),
  };
  const previousRetained = previous.filter(item => after.has(item.key)).map(item => item.key);
  const retained = new Set(previousRetained);
  const reconstructed = [...previousRetained, ...current.filter(item => !retained.has(item.key)).map(item => item.key)];
  const currentOrder = current.map(item => item.key);
  if (!equal(reconstructed, currentOrder)) delta.itemOrder = currentOrder;
  return delta;
}

function patchChanged(patch: RunInspectionPatch): boolean {
  return patch.upsertItems.length > 0
    || patch.removeItemKeys.length > 0
    || patch.itemOrder !== undefined
    || patch.counts !== undefined
    || patch.availableActions !== undefined
    || patch.omitted !== undefined
    || patch.hooks !== undefined;
}

function sameDurableRun(previous: RunInspectionSnapshot["run"], current: RunInspectionSnapshot["run"]): boolean {
  const { execution: _previousExecution, updatedAt: _previousUpdatedAt, ...previousDurable } = previous;
  const { execution: _currentExecution, updatedAt: _currentUpdatedAt, ...currentDurable } = current;
  return equal(previousDurable, currentDurable);
}

function incompatibleProjection(previous: FollowableInspectionDocument, current: FollowableInspectionDocument): boolean {
  if (previous.kind !== current.kind) return true;
  if (previous.kind === "snapshot" && current.kind === "snapshot") return false;
  if (previous.kind === "target" && current.kind === "target") {
    return !equal(previous.subject, current.subject)
      || !equal(previous.occurrence, current.occurrence);
  }
  if (previous.kind === "timeline" && current.kind === "timeline") {
    return !equal(previous.subject, current.subject);
  }
  return true;
}

function withoutWorkflowOutput(document: FollowableInspectionDocument): FollowableInspectionDocument {
  if (document.kind !== "snapshot" || document.output === undefined) return document;
  const { output: _output, ...rest } = document;
  return rest;
}

function doneEmission(query: FollowRunInspectionQuery, cycle: FollowCycle): RunInspectionEmission {
  const includeOutput = query.mode === "overview" || query.mode === "all";
  return {
    schemaVersion: 2,
    kind: "done",
    run: { id: cycle.run.id, status: cycle.run.status },
    ...(includeOutput && cycle.output !== undefined ? { output: cycle.output } : {}),
  };
}

function hasCursorGap(
  previous: number,
  current: number,
  events: RunInspectionStoreRead["events"],
): boolean {
  if (current < previous || events.length !== current - previous) return true;
  return events.some((event, index) => event.sequence !== previous + index + 1);
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

function okEmission(value: RunInspectionEmission): Result<RunInspectionEmission, RunInspectionError> {
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
