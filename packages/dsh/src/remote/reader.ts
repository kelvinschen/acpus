import type {
  StoredActivityNode,
  StoredRunProjection,
} from "../host/run-projection.js";
import {
  LONG_POLL_MS,
  TASK_HISTORY_LIMIT,
  type AcpusTasksResult,
  type AcpusTaskAvailability,
  type ActivityNode,
  type AwaitSessionActivityRevisionResult,
  type DelegatedTaskActivity,
  type DelegatedTaskSummary,
  type ProjectionReaderDependencies,
  type RunCounts,
  type SessionActivityProjection,
} from "./types.js";
import type { ResolvedTaskSelector } from "../task.js";

const IDENTITY_BYTE_LIMIT = 256;

export class AcpusProjectionReader {
  constructor(private readonly dependencies: ProjectionReaderDependencies) {}

  async readSessionActivity(
    sessionId: string,
    task?: ResolvedTaskSelector,
  ): Promise<SessionActivityProjection> {
    const stored = await this.dependencies.sessions.readSession(sessionId);
    const ordered = orderedRuns(stored.runs);
    const summaries = summarize(ordered, stored.runs);
    const current = task === undefined
      ? ordered[0]
      : stored.runs.find(run => run.name === task.name && run.occurrence === task.occurrence);
    return {
      sessionId,
      revision: stored.revision,
      tasks: summaries.slice(0, TASK_HISTORY_LIMIT),
      tasksTruncated: summaries.length > TASK_HISTORY_LIMIT,
      ...(current === undefined ? {} : { task: taskActivity(current) }),
    };
  }

  async readTasks(sessionId: string, name?: string): Promise<AcpusTasksResult> {
    const stored = await this.dependencies.sessions.readSession(sessionId);
    const matching = orderedRuns(stored.runs).filter(run => name === undefined || run.name === name);
    const summaries = summarize(matching, stored.runs);
    return {
      tasks: summaries.slice(0, TASK_HISTORY_LIMIT),
      truncated: summaries.length > TASK_HISTORY_LIMIT,
    };
  }

  awaitSessionActivityRevision(
    sessionId: string,
    afterRevision: number,
    signal?: AbortSignal,
    timeoutMs = LONG_POLL_MS,
  ): Promise<AwaitSessionActivityRevisionResult> {
    return this.awaitRevision(
      sessionId,
      afterRevision,
      signal,
      timeoutMs,
      (id, revision, waitSignal) =>
        this.dependencies.sessions.waitForActivityRevision(id, revision, waitSignal),
    );
  }

  private async awaitRevision(
    sessionId: string,
    afterRevision: number,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    wait: (sessionId: string, afterRevision: number, signal: AbortSignal) => Promise<void>,
  ): Promise<AwaitSessionActivityRevisionResult> {
    const current = await this.dependencies.sessions.readSession(sessionId);
    if (current.revision !== afterRevision) return { revision: current.revision };
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      await wait(sessionId, afterRevision, combined);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (!timeout.aborted) throw error;
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const latest = await this.dependencies.sessions.readSession(sessionId);
    return { revision: latest.revision };
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "object"
    && reason !== null
    && "message" in reason
    && typeof reason.message === "string"
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "Acpus observation was canceled.";
  return new Error(message, { cause: reason });
}

function taskActivity(stored: StoredRunProjection): DelegatedTaskActivity {
  const terminal = stored.status === "completed"
    || stored.status === "failed"
    || stored.status === "canceled";
  return {
    selector: { name: stored.name, occurrence: stored.occurrence },
    generation: stored.generation,
    status: stored.status,
    availability: taskAvailability(stored),
    counts: normalizeCounts(stored.counts),
    startedAt: stored.createdAt,
    ...(terminal ? { finishedAt: stored.updatedAt } : {}),
    tree: projectNodes(stored.activity),
  };
}

function orderedRuns(runs: readonly StoredRunProjection[]): StoredRunProjection[] {
  return [...runs].sort((left, right) => right.generation - left.generation);
}

function summarize(
  runs: readonly StoredRunProjection[],
  allRuns: readonly StoredRunProjection[],
): DelegatedTaskSummary[] {
  const byGeneration = new Map(allRuns.map(run => [run.generation, run] as const));
  return runs.map(run => {
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "canceled";
    const source = run.forkedFromGeneration === undefined
      ? undefined
      : byGeneration.get(run.forkedFromGeneration);
    return {
      task: { name: run.name, occurrence: run.occurrence },
      status: run.status,
      availability: taskAvailability(run),
      counts: normalizeCounts(run.counts),
      startedAt: run.createdAt,
      ...(terminal ? { finishedAt: run.updatedAt } : {}),
      ...(source === undefined
        ? {}
        : { forkedFrom: { name: source.name, occurrence: source.occurrence } }),
    };
  });
}

function taskAvailability(stored: StoredRunProjection): AcpusTaskAvailability {
  if (stored.unavailable === undefined) return { status: "available" };
  return {
    status: "unavailable",
    ...stored.unavailable,
    workspace: stored.workspace,
  };
}

function projectNodes(
  nodes: readonly StoredActivityNode[],
): ActivityNode[] {
  return nodes.map(node => ({
      activityId: node.activityId,
      label: boundedIdentity(node.label),
      kind: boundedIdentity(node.kind),
      status: node.status,
      ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
      ...(node.durationMs === undefined ? {} : { durationMs: node.durationMs }),
      ...(node.progress === undefined ? {} : { progress: node.progress }),
      ...(node.agent === undefined
        ? {}
        : {
            agent: {
              ...(node.agent.name === undefined
                ? {}
                : { name: boundedIdentity(node.agent.name) }),
              ...(node.agent.phase === undefined ? {} : { phase: node.agent.phase }),
              ...(node.agent.turn === undefined ? {} : { turn: node.agent.turn }),
              ...(node.agent.tool === undefined
                ? {}
                : {
                    tool: {
                      name: boundedIdentity(node.agent.tool.name),
                      ...(node.agent.tool.title === undefined
                        ? {}
                        : { title: boundedIdentity(node.agent.tool.title) }),
                      state: node.agent.tool.state,
                    },
                  }),
              ...(node.agent.telemetry === undefined
                ? {}
                : { telemetry: node.agent.telemetry }),
            },
          }),
      children: projectNodes(node.children),
    }));
}

function normalizeCounts(counts: StoredRunProjection["counts"]): RunCounts {
  return {
    total: counts.total,
    notStarted: counts.notStarted ?? 0,
    pending: (counts.pending ?? 0) + (counts.starting ?? 0) + (counts.ready ?? 0),
    running: counts.running ?? 0,
    awaiting: counts.awaiting ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    timedOut: counts.timedOut ?? 0,
    canceled: counts.cancelled ?? 0,
  };
}

function boundedIdentity(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= IDENTITY_BYTE_LIMIT) return value;
  return Buffer.from(value)
    .subarray(0, IDENTITY_BYTE_LIMIT)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}
