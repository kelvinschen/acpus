import type {
  ActivityHoverDetail,
  AgentPresetView,
  CancelSessionTaskResult,
  ResolvedTaskSelector,
  SessionActivityProjection,
} from "../remote/types.js";

export type ProjectionSnapshot = {
  sessions: Record<string, SessionActivityProjection | undefined>;
  connections: Record<string, SessionConnection | undefined>;
  selections: Record<string, SessionTaskSelection | undefined>;
};

export type SessionTaskSelection = {
  committed?: ResolvedTaskSelector;
  pending?: ResolvedTaskSelector;
  error?: { task: ResolvedTaskSelector; reason: "task-unavailable" };
};

export type SessionConnection =
  | { status: "connected"; synchronizedAt: number }
  | {
      status: "disconnected";
      synchronizedAt?: number;
      disconnectedAt: number;
    };

export type SessionConnectionPhase = "connected" | "reconnecting" | "stale" | "unknown";

export type AcpusRemote = {
  readAgentPresets(
    input: Record<string, never>,
  ): Promise<RemoteResult<{ presets: AgentPresetView[] }>>;
  readActivityDetail(
    input: { sessionId: string; generation: number; activityId: string },
  ): Promise<RemoteResult<
    | { status: "available"; detail: ActivityHoverDetail }
    | { status: "rejected"; reason: "task-unavailable" | "node-unavailable" | "detail-unavailable" | "temporarily-unavailable" }
  >>;
  readSessionActivity(
    input: { sessionId: string; task?: ResolvedTaskSelector },
  ): Promise<RemoteResult<SessionActivityProjection>>;
  awaitSessionActivityRevision(
    input: { sessionId: string; afterRevision: number },
    signal?: AbortSignal,
  ): Promise<RemoteResult<{ revision: number }>>;
  cancelSessionTask(
    input: { sessionId: string; generation: number },
  ): Promise<RemoteResult<CancelSessionTaskResult>>;
};

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } };

export type SnapshotStore<T> = {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  set(value: T): void;
};

export class AcpusClientState {
  readonly projections = createStore<ProjectionSnapshot>({
    sessions: {},
    connections: {},
    selections: {},
  });

  private watchedSession: string | undefined;
  private poll: AbortController | undefined;
  private readonly sessionReads = new Map<string, number>();
  private readonly selectionIntents = new Map<string, number>();
  private readonly expandedSessions = new Map<string, boolean>();
  private readonly nodeExpansion = new Map<string, boolean>();
  private readonly hoverDetails = new Map<string, {
    detail: ActivityHoverDetail;
    revision: number;
    terminal: boolean;
  }>();
  private readonly hoverReads = new Map<string, Promise<ActivityHoverDetail | undefined>>();
  private disposed = false;

  constructor(private readonly remote: AcpusRemote) {}

  async readAgentPresets(): Promise<AgentPresetView[]> {
    const result = await this.remote.readAgentPresets({});
    if (!result.ok) throw new Error(result.error.message);
    return result.value.presets;
  }

  activityExpanded(sessionId: string): boolean {
    return this.expandedSessions.get(sessionId) ?? true;
  }

  setActivityExpanded(sessionId: string, expanded: boolean): void {
    this.expandedSessions.set(sessionId, expanded);
  }

  nodeExpanded(
    sessionId: string,
    generation: number,
    activityId: string,
  ): boolean {
    return this.nodeExpansion.get(nodeStateKey(sessionId, generation, activityId)) ?? true;
  }

  setNodeExpanded(
    sessionId: string,
    generation: number,
    activityId: string,
    expanded: boolean,
  ): void {
    this.nodeExpansion.set(nodeStateKey(sessionId, generation, activityId), expanded);
  }

  cachedActivityDetail(
    sessionId: string,
    generation: number,
    activityId: string,
    revision: number,
  ): ActivityHoverDetail | undefined {
    const cached = this.hoverDetails.get(nodeStateKey(sessionId, generation, activityId));
    return cached !== undefined && (cached.terminal || cached.revision === revision)
      ? cached.detail
      : undefined;
  }

  async readActivityDetail(
    sessionId: string,
    generation: number,
    activityId: string,
    revision: number,
    terminal: boolean,
  ): Promise<ActivityHoverDetail | undefined> {
    const cached = this.cachedActivityDetail(sessionId, generation, activityId, revision);
    if (cached !== undefined) return cached;
    const key = hoverReadKey(sessionId, generation, activityId, revision);
    const pending = this.hoverReads.get(key);
    if (pending !== undefined) return pending;
    const read = this.remote.readActivityDetail({ sessionId, generation, activityId })
      .then(result => {
        if (!result.ok || result.value.status !== "available") return undefined;
        this.hoverDetails.set(nodeStateKey(sessionId, generation, activityId), {
          detail: result.value.detail,
          revision,
          terminal,
        });
        return result.value.detail;
      });
    this.hoverReads.set(key, read);
    try {
      return await read;
    } finally {
      if (this.hoverReads.get(key) === read) this.hoverReads.delete(key);
    }
  }

  selectedTask(sessionId: string): ResolvedTaskSelector | undefined {
    return this.projections.getSnapshot().selections[sessionId]?.committed;
  }

  async selectTask(sessionId: string, task: ResolvedTaskSelector): Promise<boolean> {
    const intent = this.nextSelectionIntent(sessionId);
    this.setSelection(sessionId, current => pendingSelection(current, task));
    const applied = await this.syncSession(sessionId, task, intent);
    return applied && sameSelector(this.selectedTask(sessionId), task);
  }

  watchSession(sessionId: string): () => void {
    if (this.disposed) return () => {};
    const previous = this.watchedSession;
    if (previous !== undefined && previous !== sessionId) this.invalidateSession(previous);
    this.watchedSession = sessionId;
    this.poll?.abort();
    const controller = new AbortController();
    this.poll = controller;
    void this.pollSession(sessionId, controller.signal);
    return () => {
      if (this.watchedSession !== sessionId || this.poll !== controller) return;
      this.watchedSession = undefined;
      controller.abort();
      this.poll = undefined;
      this.invalidateSession(sessionId);
    };
  }

  async readSession(sessionId: string): Promise<boolean> {
    const selection = this.projections.getSnapshot().selections[sessionId];
    return this.syncSession(
      sessionId,
      selection?.pending ?? selection?.committed,
      this.selectionIntents.get(sessionId) ?? 0,
    );
  }

  async cancelSessionTask(
    sessionId: string,
    generation: number,
  ): Promise<CancelSessionTaskResult> {
    try {
      const result = await this.remote.cancelSessionTask({ sessionId, generation });
      if (!result.ok) {
        this.setDisconnected(sessionId);
        throw new Error(result.error.message);
      }
      this.commitSession(result.value.projection);
      this.setConnected(sessionId);
      return result.value;
    } catch (error) {
      this.setDisconnected(sessionId);
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watchedSession = undefined;
    this.poll?.abort();
    this.poll = undefined;
    this.sessionReads.clear();
    this.selectionIntents.clear();
    this.expandedSessions.clear();
    this.nodeExpansion.clear();
    this.hoverDetails.clear();
    this.hoverReads.clear();
  }

  private async pollSession(
    sessionId: string,
    signal: AbortSignal,
    readInitially = true,
  ): Promise<void> {
    if (readInitially) await this.syncDesiredSession(sessionId, signal);
    while (!signal.aborted && this.watchedSession === sessionId) {
      const snapshot = this.projections.getSnapshot();
      const projection = snapshot.sessions[sessionId];
      if (projection === undefined || snapshot.connections[sessionId]?.status === "disconnected") {
        await reconnectDelay(signal);
        if (!signal.aborted) await this.syncDesiredSession(sessionId, signal);
        continue;
      }
      let result: Awaited<ReturnType<AcpusRemote["awaitSessionActivityRevision"]>>;
      try {
        result = await this.remote.awaitSessionActivityRevision({
          sessionId,
          afterRevision: projection.revision,
        }, signal);
      } catch {
        if (signal.aborted) return;
        this.setDisconnected(sessionId);
        continue;
      }
      if (signal.aborted || this.watchedSession !== sessionId) return;
      if (!result.ok) {
        this.setDisconnected(sessionId);
        continue;
      }
      if (result.value.revision === projection.revision) {
        this.setConnected(sessionId);
        continue;
      }
      await this.syncDesiredSession(sessionId, signal);
    }
  }

  private syncDesiredSession(sessionId: string, signal: AbortSignal): Promise<boolean> {
    const selection = this.projections.getSnapshot().selections[sessionId];
    return this.syncSession(
      sessionId,
      selection?.pending ?? selection?.committed,
      this.selectionIntents.get(sessionId) ?? 0,
      signal,
    );
  }

  private async syncSession(
    sessionId: string,
    task: ResolvedTaskSelector | undefined,
    intent: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.disposed || signal?.aborted) return false;
    const request = (this.sessionReads.get(sessionId) ?? 0) + 1;
    this.sessionReads.set(sessionId, request);
    try {
      const result = await this.remote.readSessionActivity({
        sessionId,
        ...(task === undefined ? {} : { task }),
      });
      if (!this.readIsCurrent(sessionId, request, intent, signal)) return false;
      if (!result.ok) {
        this.setDisconnected(sessionId);
        return false;
      }
      const projection = result.value;
      const previous = this.projections.getSnapshot().sessions[sessionId];
      const latest = projection.tasks[0]?.task;
      const previousLatest = previous?.tasks[0]?.task;
      if (previousLatest !== undefined && latest !== undefined
        && !sameSelector(previousLatest, latest) && !sameSelector(task, latest)) {
        const latestIntent = this.nextSelectionIntent(sessionId);
        this.setSelection(sessionId, current => pendingSelection(current, latest));
        return this.syncSession(sessionId, latest, latestIntent, signal);
      }
      if (task !== undefined
        && (projection.task === undefined || !sameSelector(projection.task.selector, task))) {
        this.setSelection(sessionId, current => ({
          ...(current.committed === undefined ? {} : { committed: current.committed }),
          error: { task, reason: "task-unavailable" },
        }));
        this.setConnected(sessionId);
        return false;
      }
      this.commitSession(projection);
      this.setConnected(sessionId);
      return true;
    } catch {
      if (!this.readIsCurrent(sessionId, request, intent, signal)) return false;
      this.setDisconnected(sessionId);
      return false;
    }
  }

  private readIsCurrent(
    sessionId: string,
    request: number,
    intent: number,
    signal?: AbortSignal,
  ): boolean {
    return !this.disposed && !signal?.aborted
      && this.sessionReads.get(sessionId) === request
      && (this.selectionIntents.get(sessionId) ?? 0) === intent;
  }

  private commitSession(projection: SessionActivityProjection): void {
    const previous = this.projections.getSnapshot().sessions[projection.sessionId];
    if (previous !== undefined && previous.revision > projection.revision) return;
    this.updateProjections(snapshot => {
      const current = snapshot.sessions[projection.sessionId];
      if (current !== undefined && current.revision > projection.revision) return snapshot;
      return {
        ...snapshot,
        sessions: { ...snapshot.sessions, [projection.sessionId]: projection },
        selections: {
          ...snapshot.selections,
          [projection.sessionId]: projection.task === undefined
            ? {}
            : { committed: projection.task.selector },
        },
      };
    });
  }

  private nextSelectionIntent(sessionId: string): number {
    const next = (this.selectionIntents.get(sessionId) ?? 0) + 1;
    this.selectionIntents.set(sessionId, next);
    return next;
  }

  private invalidateSession(sessionId: string): void {
    this.nextSelectionIntent(sessionId);
    this.sessionReads.set(sessionId, (this.sessionReads.get(sessionId) ?? 0) + 1);
  }

  private setSelection(
    sessionId: string,
    update: (current: SessionTaskSelection) => SessionTaskSelection,
  ): void {
    this.updateProjections(snapshot => ({
      ...snapshot,
      selections: {
        ...snapshot.selections,
        [sessionId]: update(snapshot.selections[sessionId] ?? {}),
      },
    }));
  }

  private setConnected(sessionId: string): void {
    const synchronizedAt = Date.now();
    this.updateProjections(snapshot => {
      const current = snapshot.connections[sessionId];
      if (current?.status === "connected" && current.synchronizedAt === synchronizedAt) {
        return snapshot;
      }
      return {
        ...snapshot,
        connections: {
          ...snapshot.connections,
          [sessionId]: { status: "connected", synchronizedAt },
        },
      };
    });
  }

  private setDisconnected(sessionId: string): void {
    this.updateProjections(snapshot => {
      const current = snapshot.connections[sessionId];
      if (current?.status === "disconnected") return snapshot;
      return {
        ...snapshot,
        connections: {
          ...snapshot.connections,
          [sessionId]: {
            status: "disconnected",
            ...(current === undefined ? {} : { synchronizedAt: current.synchronizedAt }),
            disconnectedAt: Date.now(),
          },
        },
      };
    });
  }

  private updateProjections(
    update: (snapshot: ProjectionSnapshot) => ProjectionSnapshot,
  ): void {
    this.projections.set(update(this.projections.getSnapshot()));
  }
}

function nodeStateKey(sessionId: string, generation: number, activityId: string): string {
  return `${sessionId}\0${generation}\0${activityId}`;
}

function hoverReadKey(
  sessionId: string,
  generation: number,
  activityId: string,
  revision: number,
): string {
  return `${nodeStateKey(sessionId, generation, activityId)}\0${revision}`;
}

function sameSelector(
  left: ResolvedTaskSelector | undefined,
  right: ResolvedTaskSelector | undefined,
): boolean {
  return left?.name === right?.name && left?.occurrence === right?.occurrence;
}

function pendingSelection(
  current: SessionTaskSelection,
  pending: ResolvedTaskSelector,
): SessionTaskSelection {
  return {
    ...(current.committed === undefined ? {} : { committed: current.committed }),
    pending,
  };
}

export function subscribeStore<T>(
  store: SnapshotStore<T>,
): [subscribe: (listener: () => void) => () => void, getSnapshot: () => T] {
  return [listener => store.subscribe(listener), () => store.getSnapshot()];
}

function createStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(value) {
      if (Object.is(snapshot, value)) return;
      snapshot = value;
      for (const listener of listeners) listener();
    },
  };
}

async function reconnectDelay(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const aborted = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, 1_000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export function sessionConnectionPhase(
  connection: SessionConnection | undefined,
  now: number,
): SessionConnectionPhase {
  if (connection === undefined) return "unknown";
  if (connection.status === "connected") return "connected";
  return now - connection.disconnectedAt < 10_000 ? "reconnecting" : "stale";
}
