import { tryParseDurationMs } from "@acpus/core/ir";
import {
  followRunInspection,
  type FollowableInspectionDocument,
  type FollowRunInspectionQuery,
  type RunInspectionChange,
  type RunInspectionEmission,
  type RunInspectionError,
  type RunInspectionItem,
  type RunStatus,
} from "@acpus/runtime";
import type { Writable } from "node:stream";
import { usageError } from "./errors.js";
import { writeJsonLine } from "./output.js";
import {
  applyRunInspectionUpdate,
  formatRunInspectionChanges,
  formatRunInspectionDelta,
  formatRunInspectionCheckpoint,
  formatRunInspectionDocument,
  formatRunInspectionHeader,
  formatTerminalOutput,
} from "./run-inspection-surface.js";

const defaultFollowIntervalMs = 1_000;
const minimumFollowIntervalMs = 250;
const checkpointIntervalMs = 30_000;
const overviewTranscriptContextLimit = 20;
const transcriptOmissionIntervalMs = 30_000;

export function parseFollowInterval(value: string | undefined): number {
  if (value === undefined) return defaultFollowIntervalMs;
  const parsed = tryParseDurationMs(value);
  if (parsed.isErr()) throw usageError("--interval must be a duration such as 250ms, 1s, or 5s.");
  if (parsed.value < minimumFollowIntervalMs) throw usageError("--interval must be at least 250ms.");
  return parsed.value;
}

export type RunFollowOutcome =
  | { kind: "done"; run: { id: string; status: RunStatus } }
  | { kind: "detached" }
  | { kind: "error"; error: RunInspectionError };

export async function followRun(
  cwd: string,
  query: FollowRunInspectionQuery,
  options: {
    phase: "inspect" | "run";
    format: "text" | "ndjson";
    stdout: Writable;
    stderr: Writable;
  },
): Promise<RunFollowOutcome> {
  const controller = new AbortController();
  let detached = false;
  const onAbort = (): void => {
    detached = true;
    controller.abort();
  };
  process.once("SIGINT", onAbort);
  const presenter = new RunFollowPresenter(
    options,
    query.runId,
    query.mode,
    query.mode === "timeline" ? query.page?.limit ?? 12 : 12,
  );

  try {
    const source = followRunInspection(cwd, { ...query, signal: controller.signal });
    for await (const event of withPresentationTicks(source, options.format === "text" ? 1_000 : undefined)) {
      if (event.kind === "tick") {
        presenter.tick();
        continue;
      }
      const result = event.result;
      if (result.isErr()) {
        writeFollowError(result.error, options);
        return { kind: "error", error: result.error };
      }
      presenter.emission(result.value);
      if (result.value.kind === "done") return { kind: "done", run: result.value.run };
    }
  } catch (error) {
    const failure: RunInspectionError = {
      type: "inspection-read-failed",
      runId: query.runId,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    };
    writeFollowError(failure, options);
    return { kind: "error", error: failure };
  } finally {
    controller.abort();
    process.off("SIGINT", onAbort);
  }

  if (detached) {
    const stream = options.format === "ndjson" ? options.stderr : options.stdout;
    stream.write(`Detached from run ${query.runId}. Background daemon continues running.\n`);
    stream.write(`Resume: ${resumeCommand(query, presenter.revision ?? query.after)}\n`);
    stream.write(`Cancel: acpus runs cancel ${query.runId}\n`);
    return { kind: "detached" };
  }

  const failure: RunInspectionError = {
    type: "inspection-read-failed",
    runId: query.runId,
    message: "Run inspection follow ended before a terminal status.",
  };
  writeFollowError(failure, options);
  return { kind: "error", error: failure };
}

type FollowOptions = Parameters<typeof followRun>[2];

class RunFollowPresenter {
  private document: FollowableInspectionDocument | undefined;
  private renderedLines = 0;
  private outputWritten = false;
  private lastWriteAt = Date.now();
  private readonly transcriptContextAliases = new Set<string>();
  private transcriptContextCount = 0;
  private readonly pendingTranscriptOmissions = new Map<string, RunInspectionChange>();
  private lastTranscriptOmissionAt: number | undefined;
  revision: string | undefined;

  constructor(
    private readonly options: FollowOptions,
    private readonly runId: string,
    private readonly mode: FollowRunInspectionQuery["mode"],
    private readonly timelineLimit: number,
  ) {}

  emission(emission: RunInspectionEmission): void {
    this.revision = emission.revision;
    if (this.options.format === "ndjson") {
      this.writeJson(emission);
      return;
    }

    if (emission.kind === "snapshot" || emission.kind === "resync") {
      this.document = withoutTerminalOutput(emission.document);
      if (this.mode === "overview" && !isTty(this.options.stdout) && this.document.kind === "snapshot") {
        this.resetTranscriptBudget(this.document.items);
      }
      const resync = emission.kind === "resync" && !isTty(this.options.stdout)
        ? `Resynced inspection (${emission.reason}).\n`
        : "";
      const text = `${resync}${formatRunInspectionDocument(this.document)}`;
      if (isTty(this.options.stdout)) this.renderedLines = redraw(this.options.stdout, text, this.renderedLines);
      else this.options.stdout.write(text);
      this.lastWriteAt = Date.now();
      return;
    }

    if (emission.kind === "delta") {
      const previousDocument = this.document;
      if (this.document) {
        this.document = applyRunInspectionUpdate(this.document, emission, this.timelineLimit);
      }
      if (isTty(this.options.stdout)) {
        if (this.document) {
          this.renderedLines = redraw(
            this.options.stdout,
            formatRunInspectionDocument(this.document),
            this.renderedLines,
          );
        } else {
          this.options.stdout.write(formatRunInspectionDelta(emission));
        }
      } else {
        const text = this.formatPipeDelta(emission, previousDocument);
        if (text) {
          this.options.stdout.write(text);
          this.lastWriteAt = Date.now();
        }
      }
      return;
    }

    if (!isTty(this.options.stdout)) {
      const omitted = this.flushTranscriptOmissions(emission.run.id);
      if (omitted) this.options.stdout.write(omitted);
    }
    if (this.document && isTty(this.options.stdout)) {
      this.document = terminalStateDocument(this.document, emission.run.status);
      this.renderedLines = redraw(
        this.options.stdout,
        formatRunInspectionDocument(this.document),
        this.renderedLines,
      );
    } else if (this.mode === "overview" || this.mode === "all") {
      if (this.document?.kind === "snapshot") {
        this.options.stdout.write(formatRunInspectionHeader({
          ...this.document.run,
          status: emission.run.status,
        }));
      } else {
        this.options.stdout.write(`Run ${emission.run.id}  ${emission.run.status}\n`);
      }
    }
    if (!this.outputWritten) {
      this.options.stdout.write(formatTerminalOutput(emission.output));
      this.outputWritten = true;
    }
  }

  tick(nowMs = Date.now()): void {
    if (!this.document) return;
    if (isTty(this.options.stdout)) {
      this.renderedLines = redraw(
        this.options.stdout,
        formatRunInspectionDocument(this.document, nowMs),
        this.renderedLines,
      );
      return;
    }
    const omitted = this.flushTranscriptOmissionsIfDue(this.document.run.id, nowMs);
    if (omitted) {
      this.options.stdout.write(omitted);
      this.lastWriteAt = nowMs;
      return;
    }
    if (nowMs - this.lastWriteAt < checkpointIntervalMs) return;
    this.options.stdout.write(formatRunInspectionCheckpoint(this.document, nowMs));
    this.lastWriteAt = nowMs;
  }

  private formatPipeDelta(
    emission: Extract<RunInspectionEmission, { kind: "delta" }>,
    previousDocument?: FollowableInspectionDocument,
  ): string {
    let output = "";
    for (const delta of emission.changes) {
      if (delta.kind !== "overview") {
        output += formatRunInspectionDelta({ ...emission, changes: [delta] }, previousDocument, this.runId);
        continue;
      }
      const document = this.document?.kind === "snapshot" ? this.document : undefined;
      const items = document?.items ?? delta.patch.upsertItems;
      const changes = coalesceTerminalAgentChanges(delta.changes, items);
      const transcript = this.mode === "overview"
        ? this.limitTranscriptChanges(changes, items)
        : { changes, omitted: [], shownContextKeys: [] };
      output += formatRunInspectionChanges(transcript.changes, {
        kind: "snapshot",
        run: delta.run,
        items,
        availableActions: document?.availableActions ?? delta.patch.availableActions ?? [],
      });
      output += this.recordTranscriptOmissions(
        transcript.omitted,
        transcript.shownContextKeys,
        delta.run.id,
      );
    }
    return output;
  }

  private writeJson(emission: RunInspectionEmission): void {
    const record = emission.kind === "snapshot" || emission.kind === "resync"
      ? { ...emission, document: withoutTerminalOutput(emission.document) }
      : emission;
    writeJsonLine(this.options.stdout, {
      ok: this.options.phase === "inspect" || emission.kind !== "done" || emission.run.status === "completed",
      phase: this.options.phase,
      ...record,
    });
  }

  private resetTranscriptBudget(items: readonly RunInspectionItem[]): void {
    this.transcriptContextAliases.clear();
    this.transcriptContextCount = 0;
    this.pendingTranscriptOmissions.clear();
    this.lastTranscriptOmissionAt = undefined;
    for (const item of items) {
      if (item.role !== "instance" && item.role !== "frame") continue;
      for (const alias of itemContextAliases(item)) this.transcriptContextAliases.add(alias);
      if (!protectedItem(item)) this.transcriptContextCount += 1;
    }
  }

  private limitTranscriptChanges(
    changes: readonly RunInspectionChange[],
    items: readonly RunInspectionItem[],
  ): { changes: RunInspectionChange[]; omitted: RunInspectionChange[]; shownContextKeys: string[] } {
    const itemsByKey = new Map(items.map(item => [item.key, item]));
    const groups = new Map<string, TranscriptContextGroup>();
    for (const change of changes) {
      const item = change.itemKey ? itemsByKey.get(change.itemKey) : undefined;
      if (!dynamicTranscriptChange(change, item)) continue;
      const key = transcriptContextKey(change);
      const group = groups.get(key) ?? { aliases: new Set<string>(), protected: false, last: change };
      for (const alias of changeContextAliases(change)) group.aliases.add(alias);
      group.protected ||= protectedChange(change);
      group.last = change;
      groups.set(key, group);
    }

    const selected = new Set<string>();
    for (const [key, group] of groups) {
      if (!group.protected && !hasAlias(this.transcriptContextAliases, group.aliases)) continue;
      selected.add(key);
      for (const alias of group.aliases) this.transcriptContextAliases.add(alias);
    }
    for (const [key, group] of groups) {
      if (selected.has(key)) continue;
      if (hasAlias(this.transcriptContextAliases, group.aliases)) {
        selected.add(key);
        for (const alias of group.aliases) this.transcriptContextAliases.add(alias);
        continue;
      }
      if (this.transcriptContextCount >= overviewTranscriptContextLimit) continue;
      selected.add(key);
      this.transcriptContextCount += 1;
      for (const alias of group.aliases) this.transcriptContextAliases.add(alias);
    }

    const omitted = [...groups].filter(([key]) => !selected.has(key));
    return {
      changes: changes.filter(change => {
        const item = change.itemKey ? itemsByKey.get(change.itemKey) : undefined;
        return !dynamicTranscriptChange(change, item) || selected.has(transcriptContextKey(change));
      }),
      omitted: omitted.map(([, group]) => group.last),
      shownContextKeys: [...selected],
    };
  }

  private recordTranscriptOmissions(
    changes: readonly RunInspectionChange[],
    shownContextKeys: readonly string[],
    runId: string,
    nowMs = Date.now(),
  ): string {
    for (const key of shownContextKeys) this.pendingTranscriptOmissions.delete(key);
    for (const change of changes) this.pendingTranscriptOmissions.set(transcriptContextKey(change), change);
    if (this.pendingTranscriptOmissions.size === 0) return "";
    if (this.lastTranscriptOmissionAt !== undefined
      && nowMs - this.lastTranscriptOmissionAt < transcriptOmissionIntervalMs) return "";
    return this.flushTranscriptOmissions(runId, nowMs);
  }

  private flushTranscriptOmissionsIfDue(runId: string, nowMs: number): string {
    if (this.pendingTranscriptOmissions.size === 0) return "";
    if (this.lastTranscriptOmissionAt !== undefined
      && nowMs - this.lastTranscriptOmissionAt < transcriptOmissionIntervalMs) return "";
    return this.flushTranscriptOmissions(runId, nowMs);
  }

  private flushTranscriptOmissions(runId: string, nowMs = Date.now()): string {
    if (this.pendingTranscriptOmissions.size === 0) return "";
    const text = formatTranscriptOmission([...this.pendingTranscriptOmissions.values()], runId);
    this.pendingTranscriptOmissions.clear();
    this.lastTranscriptOmissionAt = nowMs;
    return text;
  }
}

function coalesceTerminalAgentChanges(
  changes: readonly RunInspectionChange[],
  items: readonly RunInspectionItem[],
): RunInspectionChange[] {
  const byIdentity = new Map<string, RunInspectionItem>();
  for (const item of items) {
    for (const identity of [item.key, item.nodeKey, item.attemptId]) {
      if (identity) byIdentity.set(identity, item);
    }
  }
  const result = changes.map(change => ({ ...change }));
  const removed = new Set<number>();
  const durableByItem = new Map<string, number[]>();

  for (const [index, change] of result.entries()) {
    const item = agentItem(change, byIdentity);
    if (!item || !terminalDurableChange(change)) continue;
    const key = `${item.key}:${change.status}`;
    durableByItem.set(key, [...(durableByItem.get(key) ?? []), index]);
  }

  for (const [index, progress] of result.entries()) {
    const item = agentItem(progress, byIdentity);
    if (!item || !terminalAgentProgress(progress)) continue;
    const candidates = durableByItem.get(`${item.key}:${progress.status}`) ?? [];
    const durableIndex = [...candidates].reverse()
      .find(candidate => compatibleAttempt(result[candidate]!, progress));
    if (durableIndex === undefined) continue;
    result[durableIndex] = mergeTerminalChange(result[durableIndex]!, progress);
    removed.add(index);
  }

  return result.filter((_, index) => !removed.has(index));
}

function agentItem(
  change: RunInspectionChange,
  byIdentity: ReadonlyMap<string, RunInspectionItem>,
): RunInspectionItem | undefined {
  const item = (change.itemKey ? byIdentity.get(change.itemKey) : undefined)
    ?? byIdentity.get(change.entity.id);
  return item?.agent ? item : undefined;
}

function terminalDurableChange(change: RunInspectionChange): boolean {
  return change.sequence !== undefined
    && change.status !== undefined
    && ["completed", "failed", "timed_out", "cancelled"].includes(change.status)
    && ["completed", "failed", "timed_out", "cancelled"].includes(change.action);
}

function terminalAgentProgress(change: RunInspectionChange): boolean {
  return change.action === "progress"
    && change.progressVersion !== undefined
    && change.summary === undefined
    && change.status !== undefined
    && ["completed", "failed", "timed_out", "cancelled"].includes(change.status);
}

function compatibleAttempt(left: RunInspectionChange, right: RunInspectionChange): boolean {
  return left.attemptNo === undefined
    || right.attemptNo === undefined
    || left.attemptNo === right.attemptNo;
}

function mergeTerminalChange(
  durable: RunInspectionChange,
  progress: RunInspectionChange,
): RunInspectionChange {
  const message = [durable.message, progress.message]
    .filter((value, index, values): value is string => (
      value !== undefined && values.indexOf(value) === index
    ))
    .join(" · ");
  return {
    ...durable,
    ...(durable.attemptNo === undefined && progress.attemptNo !== undefined
      ? { attemptNo: progress.attemptNo }
      : {}),
    ...(message ? { message } : {}),
  };
}

type TranscriptContextGroup = {
  aliases: Set<string>;
  protected: boolean;
  last: RunInspectionChange;
};

function dynamicTranscriptChange(
  change: RunInspectionChange,
  item: RunInspectionItem | undefined,
): boolean {
  if (change.entity.kind === "run" || change.entity.kind === "control") return false;
  return item?.role !== "static" && item?.role !== "fold";
}

function protectedChange(change: RunInspectionChange): boolean {
  return change.summary?.kind === "omitted-agent-progress"
    || change.status === "failed"
    || change.status === "timed_out"
    || change.status === "awaiting"
    || change.action === "failed"
    || change.action === "timed_out"
    || change.action === "awaiting"
    || change.action === "retrying"
    || change.action === "requeued"
    || change.action === "steered"
    || (change.attemptNo ?? 1) > 1;
}

function protectedItem(item: RunInspectionItem): boolean {
  return item.status === "failed"
    || item.status === "timed_out"
    || item.status === "awaiting"
    || (item.attemptNo ?? 1) > 1;
}

function transcriptContextKey(change: RunInspectionChange): string {
  return change.subject.replace(/\s+\([^()]+\)$/, "")
    || change.itemKey
    || change.entity.id;
}

function changeContextAliases(change: RunInspectionChange): string[] {
  return [
    `subject:${transcriptContextKey(change)}`,
    `entity:${change.entity.id}`,
    ...(change.itemKey ? [`item:${change.itemKey}`] : []),
  ];
}

function itemContextAliases(item: RunInspectionItem): string[] {
  return [
    `item:${item.key}`,
    ...(item.nodeKey ? [`entity:${item.nodeKey}`] : []),
    ...(item.frameKey ? [`entity:${item.frameKey}`] : []),
  ];
}

function hasAlias(known: Set<string>, aliases: Set<string>): boolean {
  return [...aliases].some(alias => known.has(alias));
}

function formatTranscriptOmission(
  changes: readonly RunInspectionChange[],
  runId: string,
): string {
  if (changes.length === 0) return "";
  const counts = new Map<string, number>();
  for (const change of changes) {
    const status = finalChangeStatus(change);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = [
    "not-started",
    "pending",
    "starting",
    "ready",
    "running",
    "awaiting",
    "completed",
    "failed",
    "timed-out",
    "canceled",
    "mixed",
    "updated",
  ];
  const summary = [...counts]
    .sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (leftIndex < 0 ? order.length : leftIndex)
        - (rightIndex < 0 ? order.length : rightIndex)
        || left.localeCompare(right);
    })
    .map(([status, count]) => `${status}=${count}`)
    .join("  ");
  return `… ${changes.length} contexts omitted (${summary})  `
    + `More: acpus runs inspect ${runId} --all --follow\n`;
}

function finalChangeStatus(change: RunInspectionChange): string {
  if (change.status) {
    return change.status.replaceAll("_", "-").replace("cancelled", "canceled");
  }
  if (["started", "progress", "advanced", "resumed"].includes(change.action)) return "running";
  if (change.action === "ready" || change.action === "requeued") return "ready";
  if (change.action === "awaiting") return "awaiting";
  if (change.action === "completed" || change.action === "consumed") return "completed";
  if (change.action === "failed") return "failed";
  if (change.action === "timed_out") return "timed-out";
  if (change.action === "cancelled") return "canceled";
  return "updated";
}

function terminalStateDocument(
  document: FollowableInspectionDocument,
  status: RunStatus,
): FollowableInspectionDocument {
  return {
    ...document,
    run: { ...document.run, status },
  } as FollowableInspectionDocument;
}

function withoutTerminalOutput(document: FollowableInspectionDocument): FollowableInspectionDocument {
  if (document.kind !== "snapshot" || document.output === undefined) return document;
  const snapshot = { ...document };
  delete snapshot.output;
  return snapshot;
}

function resumeCommand(query: FollowRunInspectionQuery, revision: string | undefined): string {
  const target = "target" in query ? ` --target ${query.target}` : "";
  const timeline = query.mode === "timeline" ? " --timeline" : query.mode === "all" ? " --all" : "";
  const limit = query.mode === "timeline" && query.page?.limit !== undefined
    ? ` --limit ${query.page.limit}`
    : "";
  const after = revision ? ` --after ${revision}` : "";
  return `acpus runs inspect ${query.runId}${target}${timeline}${limit} --follow${after}`;
}

function writeFollowError(error: RunInspectionError, options: FollowOptions): void {
  if (options.format === "ndjson") {
    writeJsonLine(options.stdout, {
      schemaVersion: 2,
      ok: false,
      phase: options.phase,
      kind: "error",
      error: publicInspectionError(error),
    });
  } else {
    options.stderr.write(`Inspection failed: ${error.message}\n`);
  }
}

function publicInspectionError(error: RunInspectionError): object {
  if (error.type !== "inspection-read-failed") return error;
  return { type: error.type, runId: error.runId, message: error.message };
}

type FollowResult = ReturnType<typeof followRunInspection> extends AsyncIterable<infer Result> ? Result : never;
type PresentationEvent = { kind: "result"; result: FollowResult } | { kind: "tick" };

async function* withPresentationTicks(
  source: ReturnType<typeof followRunInspection>,
  intervalMs: number | undefined,
): AsyncIterable<PresentationEvent> {
  const queue: PresentationEvent[] = [];
  let sourceDone = false;
  let sourceError: unknown;
  let wake: (() => void) | undefined;
  const push = (event: PresentationEvent): void => {
    if (event.kind === "tick" && queue.some(entry => entry.kind === "tick")) return;
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const pump = (async (): Promise<void> => {
    try {
      for await (const result of source) push({ kind: "result", result });
    } catch (error) {
      sourceError = error;
    } finally {
      sourceDone = true;
      wake?.();
      wake = undefined;
    }
  })();
  const timer = intervalMs === undefined ? undefined : setInterval(() => push({ kind: "tick" }), intervalMs);
  try {
    while (!sourceDone || queue.length > 0) {
      const event = queue.shift();
      if (event) yield event;
      else await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
    await pump;
    if (sourceError !== undefined) throw sourceError;
  } finally {
    if (timer) clearInterval(timer);
  }
}

function redraw(stream: Writable, text: string, renderedLines: number): number {
  if (renderedLines > 0 && isTty(stream)) stream.write(`\r\x1b[${renderedLines}A\x1b[J`);
  stream.write(text);
  if (!isTty(stream)) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return Math.max(1, newlines + (text.endsWith("\n") ? 0 : 1));
}

function isTty(stream: Writable): boolean {
  return (stream as Writable & { isTTY?: boolean }).isTTY === true;
}
