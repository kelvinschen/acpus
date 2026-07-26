import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
  openExistingRuntimeStore,
  withRunInspectionSnapshot,
  type RunInspectionStoreRead,
} from "../store/store.js";
import {
  ambiguousTimelineCandidates,
  projectTargetSummary,
  projectTimeline,
  resolvedTargetIdentity,
  targetAttemptId,
  timelineEntriesAfter,
  timelineHasRelevantEvents,
  timelineAttemptIds,
} from "./decision-projection.js";
import {
  inspectionItems,
  progressChanges,
  projectRunInspection,
  semanticChanges,
  terminalRun,
} from "./projection.js";
import {
  decodeInspectionRevision,
  decodeTimelinePageCursor,
  inspectionFingerprint,
  inspectionRevisionWithState,
  inspectionTargetFingerprint,
} from "./revision.js";
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
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineEntry,
  RunInspectionTimelineDocument,
} from "./types.js";

const responseEmissionBytes = 512;
const activityEmissionIntervalMs = 10_000;
const timelineDefaultLimit = 12;
const timelineResumeBodyBytes = 8 * 1024;

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

  const after = query.after ? decodeInspectionRevision(query.after) : undefined;
  if (query.after && !after) {
    yield err(invalidRevision(query, "Inspection revision is invalid."));
    return;
  }
  let cycle = await readFollowCycle(cwd, query, after?.event, after?.observation);
  if (cycle.isErr()) {
    yield err(cycle.error);
    return;
  }
  let current = cycle.value.document;
  let cursor = cycle.value.cursor;
  let emitted = withoutWorkflowOutput(current);
  let lastEmissionAt = Date.now();

  if (after) {
    const invalid = validateAfterRevision(query, after, current);
    if (invalid) {
      yield err(invalid);
      return;
    }
    const cursorGap = hasCursorGap(after.event, cursor.eventSequence, cycle.value.events);
    if (cursorGap) {
      yield okEmission({
        schemaVersion: 2,
        kind: "resync",
        revision: emitted.revision,
        reason: "cursor-gap",
        document: emitted,
      });
    } else if (cycle.value.resumeProjectionDrift) {
      yield okEmission({
        schemaVersion: 2,
        kind: "resync",
        revision: emitted.revision,
        reason: "projection-drift",
        document: emitted,
      });
    } else if (after.event !== cursor.eventSequence
      || after.progress !== cursor.progressVersion
      || after.observation !== cursor.observationVersion) {
      const currentRevision = decodeInspectionRevision(current.revision);
      if (!currentRevision) {
        yield err(invalidRevision(query, "Inspection revision is invalid."));
        return;
      }
      const changes = resumedDeltas(cycle.value, current, {
        observationChanged: after.observation !== cursor.observationVersion,
        activityChanged: after.activity !== currentRevision.activity,
        visibilityChanged: after.visibility !== currentRevision.visibility,
      });
      if (changes.length > 0) {
        yield okEmission({ schemaVersion: 2, kind: "delta", revision: current.revision, changes });
      }
    }
  } else {
    yield okEmission({ schemaVersion: 2, kind: "snapshot", revision: emitted.revision, document: emitted });
  }

  if (terminalRun(current.run.status)) {
    yield okEmission(doneEmission(query, cycle.value));
    return;
  }

  while (!query.signal?.aborted) {
    await delay(query.intervalMs ?? 1_000, query.signal);
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
        revision: emitted.revision,
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
        isTerminal,
        lastEmissionAt,
        nowMs,
      );
      if (changes.length > 0) {
        emitted = withoutWorkflowOutput(current);
        lastEmissionAt = nowMs;
        yield okEmission({ schemaVersion: 2, kind: "delta", revision: current.revision, changes });
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
  afterEventSequence?: number,
  afterObservationVersion?: number,
): Promise<Result<FollowCycle, RunInspectionError>> {
  const cycle = await readInspectionCycle(cwd, query, afterEventSequence, afterObservationVersion);
  if (cycle.isErr()) return err(cycle.error);
  if (!followableDocument(cycle.value.document)) {
    return err({ type: "invalid-query", message: "This inspection view cannot be followed." });
  }
  return ok({ ...cycle.value, document: cycle.value.document });
}

async function readInspectionCycle(
  cwd: string,
  query: RunInspectionQuery,
  afterEventSequence?: number,
  afterObservationVersion?: number,
): Promise<Result<InspectionCycle, RunInspectionError>> {
  try {
    const invalid = validateInspectionQuery(query);
    if (invalid) return err(invalid);
    const store = await openExistingRuntimeStore(cwd);
    if (!store) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
    try {
      return await withRunInspectionSnapshot(store, async () => {
        const read = store.readRunInspection(query.runId, afterEventSequence);
        if (!read.run) {
          return err({
            type: "run-not-found",
            runId: query.runId,
            message: `Run '${query.runId}' was not found.`,
          });
        }
        if (!read.frozen) throw new Error(`Frozen workflow for run '${query.runId}' was not found.`);
        const run = read.run;

        if (query.mode === "overview" || query.mode === "all" || query.mode === "raw") {
          const document = projectRunInspection({
            ir: read.frozen.ir,
            run,
            artifacts: read.artifacts,
            cursor: read.cursor,
            query,
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
        const details = projectRunInspection({
          ir: read.frozen.ir,
          run,
          artifacts: read.artifacts,
          cursor: read.cursor,
          query: detailsQuery,
        });
        if (!details || details.kind !== "details") {
          return err({
            type: "target-not-found",
            runId: query.runId,
            target: query.target,
            message: `Run target '${query.target}' was not found.`,
          });
        }
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
          const document = projectTargetSummary({
            run,
            details,
            cursor: read.cursor,
            query,
            ...(observationResult?.isOk() ? { observations: observationResult.value } : {}),
            ...(details.target.kind === "attempt" && store.getRunDir(query.runId)
              ? { runDir: store.getRunDir(query.runId)! }
              : {}),
          });
          return ok(followCycle(read, document, {
            relevantDurableChanged: timelineHasRelevantEvents({ run, details, events: read.events }),
            relevantObservationChanged: afterObservationVersion !== undefined
              && (observationResult?.isOk()
                ? (observationResult.value.latestRelevantVersion ?? -1) > afterObservationVersion
                : false),
          }));
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
          cursor: read.cursor,
          query,
          events: store.getCommittedRuntimeEventsAfter(query.runId, 0),
          observations: observationResult.value,
          ...(before ? { before: { at: before.at, id: before.id, ordinal: before.ordinal } } : {}),
        });
        const resumedRecent = afterObservationVersion === undefined
          ? undefined
          : timelineEntriesAfter({
              run,
              details,
              events: read.events,
              observations: observationResult.value,
              afterObservationVersion,
            });
        const resumeLimit = query.page?.limit ?? timelineDefaultLimit;
        const omittedAfterRevision = afterObservationVersion !== undefined
          && observationResult.value.retentionFloorVersion !== undefined
          && afterObservationVersion < observationResult.value.retentionFloorVersion;
        const unreadEntriesMayFollowRevision = afterObservationVersion !== undefined
          && observationResult.value.olderEntryCount > 0
          && observationResult.value.oldestObservationVersion !== undefined
          && afterObservationVersion < observationResult.value.oldestObservationVersion;
        const resumeProjectionDrift = resumedRecent !== undefined
          && (resumedRecent.length > resumeLimit
            || Buffer.byteLength(JSON.stringify(resumedRecent)) > timelineResumeBodyBytes
            || omittedAfterRevision
            || unreadEntriesMayFollowRevision);
        return ok(followCycle(read, document, {
          ...(resumedRecent === undefined ? {} : { resumedRecent }),
          resumeProjectionDrift,
          relevantDurableChanged: timelineHasRelevantEvents({ run, details, events: read.events }),
          relevantObservationChanged: afterObservationVersion !== undefined
            && (observationResult.value.latestRelevantVersion ?? -1) > afterObservationVersion,
        }));
      });
    } finally {
      store.close();
    }
  } catch (error) {
    return err(inspectionError(query.runId, error));
  }
}

type InspectionCycle = {
  document: RunInspectionDocument;
  events: RunInspectionStoreRead["events"];
  cursor: RunInspectionStoreRead["cursor"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  output?: JsonValue;
  resumedRecent?: RunInspectionTimelineEntry[];
  resumeProjectionDrift?: boolean;
  relevantDurableChanged?: boolean;
  relevantObservationChanged?: boolean;
};

type FollowCycle = Omit<InspectionCycle, "document"> & {
  document: FollowableInspectionDocument;
};

function followCycle(
  read: RunInspectionStoreRead,
  document: RunInspectionDocument,
  options: {
    resumedRecent?: RunInspectionTimelineEntry[];
    resumeProjectionDrift?: boolean;
    relevantDurableChanged?: boolean;
    relevantObservationChanged?: boolean;
  } = {},
): InspectionCycle {
  const boundDocument = followableDocument(document)
    ? bindResumeState(document)
    : document;
  return {
    document: boundDocument,
    events: read.events,
    cursor: read.cursor,
    run: read.run!,
    ...(read.run?.output === undefined ? {} : { output: read.run.output }),
    ...(options.resumedRecent === undefined ? {} : { resumedRecent: options.resumedRecent }),
    ...(options.resumeProjectionDrift === undefined
      ? {}
      : { resumeProjectionDrift: options.resumeProjectionDrift }),
    ...(options.relevantDurableChanged === undefined
      ? {}
      : { relevantDurableChanged: options.relevantDurableChanged }),
    ...(options.relevantObservationChanged === undefined
      ? {}
      : { relevantObservationChanged: options.relevantObservationChanged }),
  };
}

function followableDocument(document: RunInspectionDocument): document is FollowableInspectionDocument {
  return document.kind === "snapshot" || document.kind === "target" || document.kind === "timeline";
}

function bindResumeState<T extends FollowableInspectionDocument>(document: T): T {
  const activity = document.kind === "snapshot"
    ? document.items.flatMap(item => item.agent ? [{ key: item.key, agent: item.agent }] : [])
    : document.kind === "target"
      ? meaningfulPulse(document.pulse)
      : meaningfulCurrent(document.current);
  const visibility = document.kind === "snapshot" ? null : document.visibility ?? null;
  return {
    ...document,
    revision: inspectionRevisionWithState(document.revision, { activity, visibility }),
  };
}

function meaningfulCurrent(current: RunInspectionTimelineDocument["current"]): unknown {
  if (!current) return null;
  const { updatedAt: _updatedAt, ...meaningful } = current;
  if (current.kind !== "agent" || !current.tools) return meaningful;
  return {
    ...meaningful,
    tools: {
      ...current.tools,
      active: current.tools.active.map(tool => {
        const { updatedAt: _toolUpdatedAt, ...activity } = tool;
        return activity;
      }),
    },
  };
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
  const intervalMs = query.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    return { type: "invalid-query", message: "Inspection follow interval must be an integer of at least 250ms." };
  }
  if (query.mode === "timeline" && query.page?.before) {
    return { type: "invalid-query", message: "Timeline pagination cannot be combined with follow." };
  }
  return undefined;
}

function validateAfterRevision(
  query: FollowRunInspectionQuery,
  previous: NonNullable<ReturnType<typeof decodeInspectionRevision>>,
  current: FollowableInspectionDocument,
): RunInspectionError | undefined {
  const currentRevision = decodeInspectionRevision(current.revision);
  if (!currentRevision
    || previous.runId !== query.runId
    || previous.fingerprint !== inspectionFingerprint(query)
    || previous.fingerprint !== currentRevision.fingerprint
    || previous.target !== currentRevision.target
    || previous.event > currentRevision.event
    || previous.progress > currentRevision.progress
    || previous.observation > currentRevision.observation) {
    return invalidRevision(query, "Inspection revision does not match the run, view, or resolved target.");
  }
  return undefined;
}

function invalidRevision(query: FollowRunInspectionQuery, message: string): RunInspectionError {
  return {
    type: "invalid-cursor",
    runId: query.runId,
    ...("target" in query ? { target: query.target } : {}),
    message,
  };
}

function resumedDeltas(
  cycle: FollowCycle,
  current: FollowableInspectionDocument,
  versions: {
    observationChanged: boolean;
    activityChanged: boolean;
    visibilityChanged: boolean;
  },
): RunInspectionDelta[] {
  const observationChanged = cycle.relevantObservationChanged ?? versions.observationChanged;
  if (current.kind === "snapshot") {
    const changes = semanticChanges(cycle.events, current, cycle.run);
    const changedItemKeys = new Set(changes.flatMap(change => change.itemKey ? [change.itemKey] : []));
    const projectionChanged = versions.activityChanged;
    return changes.length === 0 && !projectionChanged ? [] : [{
      kind: "overview",
      run: current.run,
      changes,
      patch: {
        upsertItems: current.items.filter(item => projectionChanged || changedItemKeys.has(item.key)),
        removeItemKeys: [],
        ...(changes.length > 0 ? {
          counts: current.counts,
          availableActions: current.availableActions,
          omitted: current.omitted ?? null,
          hooks: current.hooks ?? [],
        } : {}),
      },
    }];
  }
  if (current.kind === "target") {
    const durableChanged = cycle.relevantDurableChanged ?? (cycle.events.length > 0);
    return [
      ...(durableChanged
        ? [
            { kind: "run" as const, run: current.run },
            { kind: "state" as const, state: current.state },
            {
              kind: "available-actions" as const,
              availableActions: current.availableActions,
            },
          ]
        : []),
      ...(versions.activityChanged
        ? [{ kind: "pulse" as const, pulse: current.pulse ?? null }]
        : []),
      ...(durableChanged
        ? [{ kind: "attention" as const, attention: current.attention ?? null }]
        : []),
      ...(versions.visibilityChanged
        ? [{ kind: "visibility" as const, visibility: current.visibility ?? null }]
        : []),
      ...(durableChanged || observationChanged
        ? [{ kind: "evidence" as const, evidence: current.evidence ?? null }]
        : []),
    ];
  }
  const durableChanged = cycle.relevantDurableChanged ?? (cycle.events.length > 0);
  const resumedRecent = cycle.resumedRecent ?? [];
  return [
    ...(durableChanged
      ? [
          { kind: "run" as const, run: current.run },
          { kind: "state" as const, state: current.state },
        ]
      : []),
    ...(versions.visibilityChanged
      ? [{ kind: "visibility" as const, visibility: current.visibility ?? null }]
      : []),
    ...(resumedRecent.length > 0
      ? [{
          kind: "recent" as const,
          upsert: resumedRecent,
          order: current.recent.entries.map(entry => entry.id),
          page: timelinePageMetadata(current),
        }]
      : []),
    ...(versions.activityChanged
      ? [{ kind: "current" as const, current: current.current ?? null }]
      : []),
  ];
}

function inspectionDeltas(
  previous: FollowableInspectionDocument,
  current: FollowableInspectionDocument,
  events: RunInspectionStoreRead["events"],
  run: NonNullable<RunInspectionStoreRead["run"]>,
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
    const changes = [...semanticChanges(events, current, run), ...progressChanges(previous, current)];
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
    revision: cycle.document.revision,
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
