import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { openExistingRuntimeStore, type RunInspectionStoreRead } from "../store/store.js";
import {
  inspectionItems,
  normalizedAgentProgressStates,
  progressChanges,
  projectRunInspection,
  semanticChanges,
  terminalRun,
  type NormalizedAgentProgressState,
} from "./projection.js";
import type {
  AgentInspectionState,
  FollowRunInspectionQuery,
  RunInspectionChange,
  RunInspectionDocument,
  RunInspectionEmission,
  RunInspectionError,
  RunInspectionItem,
  RunInspectionPatch,
  RunInspectionQuery,
  RunInspectionSnapshot,
  RunInspectionTargetDocument,
} from "./types.js";

const agentCounterEmissionIntervalMs = 10_000;

type FollowDocument = RunInspectionSnapshot | RunInspectionTargetDocument;

export function getRunInspection(cwd: string, query: RunInspectionQuery): ResultAsync<RunInspectionDocument, RunInspectionError> {
  return ResultAsync.fromPromise(readInspection(cwd, query), error => inspectionError(query.runId, error));
}

export async function* followRunInspection(queryCwd: string, query: FollowRunInspectionQuery): AsyncIterable<Result<RunInspectionEmission, RunInspectionError>> {
  const intervalMs = query.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    yield err({ type: "invalid-query", message: "Inspection follow interval must be an integer of at least 250ms." });
    return;
  }

  const initialResult = await readFollowCycle(queryCwd, query);
  if (initialResult.isErr()) {
    yield err(initialResult.error);
    return;
  }
  let previous = initialResult.value.document;
  let previousRun = initialResult.value.run;
  if (previous.kind === "raw") {
    yield err({ type: "invalid-query", message: "Raw inspection cannot be followed." });
    return;
  }
  let emitted = withoutWorkflowOutput(previous);
  const agentEmissionTimes = initialAgentEmissionTimes(emitted, previousRun);
  yield okEmission({ schemaVersion: 1, kind: "snapshot", cursor: emitted.cursor, document: emitted });
  if (terminalRun(previous.run.status)) {
    yield okEmission({
      schemaVersion: 1,
      kind: "done",
      cursor: previous.cursor,
      run: previous.run,
      ...(initialResult.value.output === undefined ? {} : { output: initialResult.value.output }),
    });
    return;
  }

  while (!query.signal?.aborted) {
    await delay(intervalMs, query.signal);
    if (query.signal?.aborted) return;
    const cycle = await readFollowCycle(queryCwd, query, previous.cursor.eventSequence);
    if (cycle.isErr()) {
      yield err(cycle.error);
      return;
    }
    const { document: current, events } = cycle.value;
    if (current.kind === "raw") {
      yield err({ type: "invalid-query", message: "Raw inspection cannot be followed." });
      return;
    }

    const isTerminal = terminalRun(current.run.status);
    const durableChanges = semanticChanges(events, current, cycle.value.run);
    const progressBaseline = isTerminal ? forceProgressComparison(emitted) : previous;
    const candidateProgress = progressChanges(progressBaseline, current);
    const allowedProgress = coalesceAgentProgress(candidateProgress, emitted, current, agentEmissionTimes, isTerminal);
    const omittedProgress = omittedAgentProgressChange(previousRun, cycle.value.run, current, agentEmissionTimes, isTerminal);
    const allowedAgentItems = new Set(allowedProgress.flatMap(change => change.itemKey ? [change.itemKey] : []));
    const projected = coalescedDocument(emitted, current, allowedAgentItems, isTerminal);
    const delta = itemDelta(inspectionItems(emitted), inspectionItems(projected));
    const patch = inspectionPatch(emitted, projected, delta);
    const changes = [...durableChanges, ...allowedProgress, ...(omittedProgress ? [omittedProgress] : [])];
    const cursorGap = hasCursorGap(previous.cursor.eventSequence, current.cursor.eventSequence, events);
    const projectionDrift = emitted.kind !== projected.kind || !deltaReconstructs(inspectionItems(emitted), inspectionItems(projected), delta);
    const durableRunChanged = durableRunSummaryChanged(emitted.run, projected.run);

    if (cursorGap || projectionDrift) {
      emitted = withoutWorkflowOutput(current);
      resetAgentEmissionTimes(agentEmissionTimes, emitted, cycle.value.run);
      yield okEmission({
        schemaVersion: 1,
        kind: "resync",
        cursor: emitted.cursor,
        reason: cursorGap ? "cursor-gap" : "projection-drift",
        document: emitted,
      });
    } else if (
      (changes.length > 0 || patchChanged(patch) || durableRunChanged)
      && (events.length > 0 || allowedProgress.length > 0 || omittedProgress !== undefined || durableRunChanged)
    ) {
      emitted = projected;
      yield okEmission({
        schemaVersion: 1,
        kind: "update",
        cursor: projected.cursor,
        run: projected.run,
        changes,
        patch,
      });
    }

    previous = current;
    previousRun = cycle.value.run;
    if (isTerminal) {
      yield okEmission({
        schemaVersion: 1,
        kind: "done",
        cursor: current.cursor,
        run: current.run,
        ...(cycle.value.output === undefined ? {} : { output: cycle.value.output }),
      });
      return;
    }
  }
}

function omittedAgentProgressChange(
  previousRun: FollowCycle["run"],
  currentRun: FollowCycle["run"],
  current: FollowDocument,
  emissionTimes: Map<string, number>,
  terminal: boolean,
): RunInspectionChange | undefined {
  if (current.kind !== "snapshot" || !current.omitted) return undefined;
  const previous = new Map(normalizedAgentProgressStates(previousRun).map(state => [state.nodeKey, state]));
  const currentStates = normalizedAgentProgressStates(currentRun);
  const visible = new Set(inspectionItems(current).flatMap(item => item.agent && item.nodeKey ? [item.nodeKey] : []));
  const hidden = currentStates.filter(state => !visible.has(state.nodeKey));
  const changed = hidden.filter(state => meaningfulAgentState(previous.get(state.nodeKey)) !== meaningfulAgentState(state));
  const allowed = changed.filter(state => {
    const before = previous.get(state.nodeKey);
    const at = parsedTime(state.updatedAt);
    const immediate = terminal || !before || structuralAgentState(before) !== structuralAgentState(state);
    const lastAt = emissionTimes.get(state.itemKey);
    if (!immediate && lastAt !== undefined && at - lastAt < agentCounterEmissionIntervalMs) return false;
    emissionTimes.set(state.itemKey, at);
    return true;
  });
  if (allowed.length === 0) return undefined;
  const latest = [...allowed].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
  return {
    at: latest.updatedAt,
    entity: { kind: "progress", id: "omitted-agents" },
    subject: "omitted Agents",
    action: "progress",
    progressVersion: current.cursor.progressVersion,
    message: `${allowed.length} changed outside the compact context budget (${hidden.length} tracked)`,
    summary: { kind: "omitted-agent-progress", changed: allowed.length, tracked: hidden.length },
  };
}

function meaningfulAgentState(state: NormalizedAgentProgressState | undefined): string {
  if (!state) return "";
  const { updatedAt: _updatedAt, ...meaningful } = state;
  const { lastActivityAt: _lastActivityAt, ...telemetry } = meaningful.telemetry;
  return JSON.stringify({ ...meaningful, telemetry });
}

function structuralAgentState(state: NormalizedAgentProgressState): string {
  const { context: _context, tokenUsage: _tokenUsage, lastActivityAt: _lastActivityAt, ...telemetry } = state.telemetry;
  return JSON.stringify({
    attemptId: state.attemptId,
    attemptNo: state.attemptNo,
    status: state.status,
    message: state.message,
    telemetry,
  });
}

function durableRunSummaryChanged(previous: FollowDocument["run"], current: FollowDocument["run"]): boolean {
  const { execution: _previousExecution, ...previousDurable } = previous;
  const { execution: _currentExecution, ...currentDurable } = current;
  return JSON.stringify(previousDurable) !== JSON.stringify(currentDurable);
}

async function readInspection(cwd: string, query: RunInspectionQuery): Promise<RunInspectionDocument> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) throw failure({ type: "runtime-store-not-found", message: "Runtime store was not found." });
  try {
    return projectFromRead(store.readRunInspection(query.runId), query);
  } finally {
    store.close();
  }
}

async function readFollowCycle(cwd: string, query: FollowRunInspectionQuery, after?: number): Promise<ResultAsyncValue> {
  try {
    const store = await openExistingRuntimeStore(cwd);
    if (!store) return err({ type: "runtime-store-not-found", message: "Runtime store was not found." });
    try {
      const read = store.readRunInspection(query.runId, after);
      return ok({
        document: projectFromRead(read, query),
        events: read.events,
        run: read.run!,
        ...(read.run?.output === undefined ? {} : { output: read.run.output }),
      });
    } finally {
      store.close();
    }
  } catch (error) {
    return err(inspectionError(query.runId, error));
  }
}

type FollowCycle = {
  document: RunInspectionDocument;
  events: RunInspectionStoreRead["events"];
  run: NonNullable<RunInspectionStoreRead["run"]>;
  output?: JsonValue;
};
type ResultAsyncValue = Result<FollowCycle, RunInspectionError>;

function projectFromRead(read: RunInspectionStoreRead, query: RunInspectionQuery): RunInspectionDocument {
  if (!read.run) throw failure({ type: "run-not-found", runId: query.runId, message: `Run '${query.runId}' was not found.` });
  if (!read.frozen) throw failure({ type: "inspection-read-failed", runId: query.runId, message: `Frozen workflow for run '${query.runId}' was not found.` });
  const document = projectRunInspection({ ir: read.frozen.ir, run: read.run, artifacts: read.artifacts, cursor: read.cursor, query });
  if (!document && query.mode === "target") throw failure({ type: "target-not-found", runId: query.runId, target: query.target, message: `Run target '${query.target}' was not found.` });
  if (!document) throw failure({ type: "inspection-read-failed", runId: query.runId, message: "Run inspection projection failed." });
  return document;
}

function withoutWorkflowOutput<T extends FollowDocument>(document: T): T {
  if (document.kind !== "snapshot" || document.output === undefined) return document;
  const { output: _output, ...rest } = document;
  return rest as T;
}

function forceProgressComparison<T extends FollowDocument>(document: T): T {
  return { ...document, cursor: { ...document.cursor, progressVersion: Number.MIN_SAFE_INTEGER } };
}

function coalesceAgentProgress(
  changes: RunInspectionChange[],
  emitted: FollowDocument,
  current: FollowDocument,
  emissionTimes: Map<string, number>,
  terminal: boolean,
): RunInspectionChange[] {
  const before = new Map(inspectionItems(emitted).map(item => [item.key, item]));
  const after = new Map(inspectionItems(current).map(item => [item.key, item]));
  return changes.filter(change => {
    if (!change.itemKey) return true;
    const currentItem = after.get(change.itemKey);
    if (!currentItem?.agent) return true;
    const previousItem = before.get(change.itemKey);
    const at = parsedTime(change.at);
    const immediate = terminal
      || !previousItem?.agent
      || !hasLiveAgentState(previousItem.agent) && hasLiveAgentState(currentItem.agent)
      || agentStructuralState(previousItem) !== agentStructuralState(currentItem);
    const lastAt = emissionTimes.get(change.itemKey);
    if (!immediate && lastAt !== undefined && at - lastAt < agentCounterEmissionIntervalMs) return false;
    emissionTimes.set(change.itemKey, at);
    return true;
  });
}

function coalescedDocument(
  emitted: FollowDocument,
  current: FollowDocument,
  allowedAgentItems: ReadonlySet<string>,
  terminal: boolean,
): FollowDocument {
  const before = new Map(inspectionItems(emitted).map(item => [item.key, item]));
  const items = inspectionItems(current).map(item => {
    const previous = before.get(item.key);
    if (!item.agent || !previous?.agent || terminal || allowedAgentItems.has(item.key)) return item;
    return { ...item, agent: previous.agent };
  });
  return withoutWorkflowOutput({ ...current, items } as FollowDocument);
}

function agentStructuralState(item: RunInspectionItem): string {
  if (!item.agent) return "";
  const { context: _context, tokenUsage: _tokenUsage, lastActivityAt: _lastActivityAt, ...agent } = item.agent;
  return JSON.stringify({ status: item.status, attemptNo: item.attemptNo, failure: item.failure, agent });
}

function hasLiveAgentState(agent: AgentInspectionState): boolean {
  return agent.lastActivityAt !== undefined
    || agent.turnCount !== undefined
    || agent.context !== undefined
    || agent.tokenUsage !== undefined
    || agent.tools !== undefined
    || agent.stopReason !== undefined;
}

function initialAgentEmissionTimes(document: FollowDocument, run: FollowCycle["run"]): Map<string, number> {
  const times = new Map<string, number>();
  for (const item of inspectionItems(document)) {
    if (!item.agent || !hasLiveAgentState(item.agent)) continue;
    times.set(item.key, parsedTime(item.agent.lastActivityAt ?? item.updatedAt ?? document.run.updatedAt));
  }
  for (const state of normalizedAgentProgressStates(run)) times.set(state.itemKey, parsedTime(state.updatedAt));
  return times;
}

function resetAgentEmissionTimes(times: Map<string, number>, document: FollowDocument, run: FollowCycle["run"]): void {
  times.clear();
  for (const [key, value] of initialAgentEmissionTimes(document, run)) times.set(key, value);
}

function parsedTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Date.now();
}

function inspectionPatch(
  previous: FollowDocument,
  current: FollowDocument,
  delta: Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder">,
): RunInspectionPatch {
  const patch: RunInspectionPatch = delta;
  if (previous.kind !== "snapshot" || current.kind !== "snapshot") return patch;
  if (JSON.stringify(previous.counts) !== JSON.stringify(current.counts)) patch.counts = current.counts;
  if (JSON.stringify(previous.actions) !== JSON.stringify(current.actions)) patch.actions = current.actions;
  if (JSON.stringify(previous.omitted) !== JSON.stringify(current.omitted)) patch.omitted = current.omitted ?? null;
  if (JSON.stringify(previous.hooks ?? []) !== JSON.stringify(current.hooks ?? [])) patch.hooks = current.hooks ?? [];
  return patch;
}

function patchChanged(patch: RunInspectionPatch): boolean {
  return patch.upsertItems.length > 0
    || patch.removeItemKeys.length > 0
    || patch.itemOrder !== undefined
    || patch.counts !== undefined
    || patch.actions !== undefined
    || patch.omitted !== undefined
    || patch.hooks !== undefined;
}

function itemDelta(previous: RunInspectionItem[], current: RunInspectionItem[]): Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder"> {
  const before = new Map(previous.map(item => [item.key, JSON.stringify(item)]));
  const after = new Set(current.map(item => item.key));
  const delta: Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder"> = {
    upsertItems: current.filter(item => before.get(item.key) !== JSON.stringify(item)),
    removeItemKeys: previous.filter(item => !after.has(item.key)).map(item => item.key),
  };
  const retained = previous.filter(item => after.has(item.key)).map(item => item.key);
  const retainedSet = new Set(retained);
  const appended = current.filter(item => !retainedSet.has(item.key)).map(item => item.key);
  const reconstructedOrder = [...retained, ...appended];
  const currentOrder = current.map(item => item.key);
  if (JSON.stringify(reconstructedOrder) !== JSON.stringify(currentOrder)) delta.itemOrder = currentOrder;
  return delta;
}

function deltaReconstructs(
  previous: RunInspectionItem[],
  current: RunInspectionItem[],
  delta: Pick<RunInspectionPatch, "upsertItems" | "removeItemKeys" | "itemOrder">,
): boolean {
  const removed = new Set(delta.removeItemKeys);
  const replacements = new Map(delta.upsertItems.map(item => [item.key, item]));
  const reconstructed = previous.filter(item => !removed.has(item.key)).map(item => replacements.get(item.key) ?? item);
  const existing = new Set(reconstructed.map(item => item.key));
  for (const item of delta.upsertItems) if (!existing.has(item.key)) reconstructed.push(item);
  if (delta.itemOrder) {
    const order = new Map(delta.itemOrder.map((key, index) => [key, index]));
    reconstructed.sort((left, right) => (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.key) ?? Number.MAX_SAFE_INTEGER));
  }
  return JSON.stringify(reconstructed) === JSON.stringify(current);
}

function hasCursorGap(previous: number, current: number, events: RunInspectionStoreRead["events"]): boolean {
  if (current < previous || events.length !== current - previous) return true;
  return events.some((event, index) => event.sequence !== previous + index + 1);
}

function inspectionError(runId: string, error: unknown): RunInspectionError {
  if (error instanceof InspectionFailure) return error.detail;
  return { type: "inspection-read-failed", runId, message: error instanceof Error ? error.message : String(error), cause: error };
}

class InspectionFailure extends Error {
  constructor(readonly detail: RunInspectionError) {
    super(detail.message);
  }
}

function failure(detail: RunInspectionError): InspectionFailure {
  return new InspectionFailure(detail);
}

function okEmission(value: RunInspectionEmission): Result<RunInspectionEmission, RunInspectionError> {
  return ok(value);
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
