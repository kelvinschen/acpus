import { describe, expect, it, vi } from "vitest";
import { AcpusClientState, type AcpusRemote } from "../src/client/state.js";
import type { SessionActivityProjection } from "../src/remote/types.js";

describe("Acpus Client task projection ownership", () => {
  it("reads the latest Agent Preset catalog through the Remote boundary", async () => {
    const presets = [{
      id: "dsh",
      guidance: "Coordinate delegated work.",
      scope: "host" as const,
      agent: { use: "dsh" },
    }];
    const readAgentPresets = vi.fn(async () => ({
      ok: true as const,
      value: { presets },
    }));
    const state = new AcpusClientState(remoteStub({ readAgentPresets }));

    await expect(state.readAgentPresets()).resolves.toEqual(presets);
    expect(readAgentPresets).toHaveBeenCalledWith({});
  });

  it("surfaces Agent Preset Remote failures for the retry UI", async () => {
    const state = new AcpusClientState(remoteStub({
      readAgentPresets: vi.fn(async () => ({
        ok: false as const,
        error: { message: "catalog unavailable" },
      })),
    }));

    await expect(state.readAgentPresets()).rejects.toThrow("catalog unavailable");
  });

  it("remembers expansion independently for each session", () => {
    const state = new AcpusClientState(remoteStub());

    expect(state.activityExpanded("session-1")).toBe(true);
    expect(state.activityExpanded("session-2")).toBe(true);
    state.setActivityExpanded("session-1", false);
    expect(state.activityExpanded("session-1")).toBe(false);
    expect(state.activityExpanded("session-2")).toBe(true);
  });

  it("defaults every node open and preserves explicit per-run overrides", () => {
    const state = new AcpusClientState(remoteStub());

    expect(state.nodeExpanded("session-1", 1, "node-1")).toBe(true);
    state.setNodeExpanded("session-1", 1, "node-1", false);
    expect(state.nodeExpanded("session-1", 1, "node-1")).toBe(false);
    expect(state.nodeExpanded("session-1", 2, "node-1")).toBe(true);
    expect(state.nodeExpanded("session-2", 1, "node-1")).toBe(true);
  });

  it("deduplicates concurrent Agent detail reads for one activity revision", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readActivityDetail = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        value: {
          status: "available" as const,
          detail: { kind: "agent" as const, agent: "codex" },
        },
      };
    });
    const state = new AcpusClientState(remoteStub({ readActivityDetail }));

    const first = state.readActivityDetail("session-1", 1, "node-1", 4, false);
    const second = state.readActivityDetail("session-1", 1, "node-1", 4, false);
    expect(readActivityDetail).toHaveBeenCalledOnce();
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "agent", agent: "codex" },
      { kind: "agent", agent: "codex" },
    ]);
  });

  it("caches terminal Agent hover details across activity revisions", async () => {
    const readActivityDetail = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: "available" as const,
        detail: { kind: "agent" as const, agent: "codex", result: { kind: "completed-without-output" as const } },
      },
    }));
    const state = new AcpusClientState(remoteStub({ readActivityDetail }));

    await state.readActivityDetail("session-1", 1, "node-1", 4, true);

    expect(state.cachedActivityDetail("session-1", 1, "node-1", 99))
      .toMatchObject({ agent: "codex" });
    expect(readActivityDetail).toHaveBeenCalledOnce();
  });

  it("switches historical tasks atomically without replacing the long poll", async () => {
    let releaseSelection: (() => void) | undefined;
    const selectionGate = new Promise<void>(resolve => { releaseSelection = resolve; });
    const polls: AbortSignal[] = [];
    const readSessionActivity = vi.fn(async input => {
      if (input.task?.name === "review") await selectionGate;
      return {
        ok: true as const,
        value: historyProjection(input.sessionId, input.task?.name === "review" ? "review" : "current"),
      };
    });
    const state = new AcpusClientState(remoteStub({
      readSessionActivity,
      awaitSessionActivityRevision: vi.fn(async (_input, signal) => {
        if (signal === undefined) throw new Error("Expected cancellation.");
        polls.push(signal);
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false as const, error: { message: "aborted" } };
      }),
    }));
    const stop = state.watchSession("session-1");
    await vi.waitFor(() => expect(polls).toHaveLength(1));

    const switching = state.selectTask("session-1", { name: "review", occurrence: 1 });
    await vi.waitFor(() => expect(state.projections.getSnapshot().selections["session-1"]?.pending)
      .toEqual({ name: "review", occurrence: 1 }));
    expect(state.selectedTask("session-1")).toEqual({ name: "current", occurrence: 1 });
    expect(state.projections.getSnapshot().sessions["session-1"]?.task?.selector)
      .toEqual({ name: "current", occurrence: 1 });
    expect(polls).toHaveLength(1);
    expect(polls[0]?.aborted).toBe(false);

    releaseSelection?.();
    await expect(switching).resolves.toBe(true);
    expect(state.selectedTask("session-1")).toEqual({ name: "review", occurrence: 1 });
    expect(polls).toHaveLength(1);
    stop();
  });

  it("keeps the committed task and connection when a historical target is missing", async () => {
    const readSessionActivity = vi.fn(async input => {
      const current = historyProjection(input.sessionId, "current");
      if (input.task === undefined) return { ok: true as const, value: current };
      const { task: _task, ...withoutTask } = current;
      return { ok: true as const, value: withoutTask };
    });
    const state = new AcpusClientState(remoteStub({ readSessionActivity }));
    await state.readSession("session-1");

    await expect(state.selectTask("session-1", { name: "review", occurrence: 1 }))
      .resolves.toBe(false);

    const snapshot = state.projections.getSnapshot();
    expect(snapshot.sessions["session-1"]?.task?.selector)
      .toEqual({ name: "current", occurrence: 1 });
    expect(snapshot.selections["session-1"]?.error).toEqual({
      task: { name: "review", occurrence: 1 },
      reason: "task-unavailable",
    });
    expect(snapshot.connections["session-1"]?.status).toBe("connected");
  });

  it("commits only the latest of multiple rapid historical selections", async () => {
    let releaseReview: (() => void) | undefined;
    let releaseArchive: (() => void) | undefined;
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
    const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
    const readSessionActivity = vi.fn(async input => {
      if (input.task?.name === "review") await reviewGate;
      if (input.task?.name === "archive") await archiveGate;
      return {
        ok: true as const,
        value: threeTaskProjection(input.sessionId, input.task?.name ?? "current"),
      };
    });
    const state = new AcpusClientState(remoteStub({ readSessionActivity }));
    await state.readSession("session-1");

    const review = state.selectTask("session-1", { name: "review", occurrence: 1 });
    const archive = state.selectTask("session-1", { name: "archive", occurrence: 1 });
    releaseReview?.();
    await expect(review).resolves.toBe(false);
    expect(state.selectedTask("session-1")).toEqual({ name: "current", occurrence: 1 });
    releaseArchive?.();
    await expect(archive).resolves.toBe(true);
    expect(state.selectedTask("session-1")).toEqual({ name: "archive", occurrence: 1 });
  });

  it("lets a new admission supersede a pending historical selection", async () => {
    let selectionReads = 0;
    let releaseFirstSelection: (() => void) | undefined;
    const firstSelectionGate = new Promise<void>(resolve => { releaseFirstSelection = resolve; });
    const readSessionActivity = vi.fn(async input => {
      if (input.task?.name === "review") {
        selectionReads += 1;
        if (selectionReads === 1) await firstSelectionGate;
        return { ok: true as const, value: newAdmissionProjection(input.sessionId, "review") };
      }
      if (input.task?.name === "new-task") {
        return { ok: true as const, value: newAdmissionProjection(input.sessionId, "new-task") };
      }
      return { ok: true as const, value: historyProjection(input.sessionId, "current") };
    });
    const state = new AcpusClientState(remoteStub({ readSessionActivity }));
    await state.readSession("session-1");
    const historical = state.selectTask("session-1", { name: "review", occurrence: 1 });

    await state.readSession("session-1");
    expect(state.selectedTask("session-1")).toEqual({ name: "new-task", occurrence: 1 });
    releaseFirstSelection?.();
    await expect(historical).resolves.toBe(false);
    expect(state.selectedTask("session-1")).toEqual({ name: "new-task", occurrence: 1 });
  });

  it("owns only one long poll and aborts it on session change and disposal", async () => {
    const polls: AbortSignal[] = [];
    const remote = remoteStub({
      awaitSessionActivityRevision: vi.fn(async (_input, signal) => {
        if (signal === undefined) throw new Error("Expected cancellation.");
        polls.push(signal);
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: false as const, error: { message: "aborted" } };
      }),
    });
    const state = new AcpusClientState(remote);
    const stopFirst = state.watchSession("session-1");
    await vi.waitFor(() => expect(polls).toHaveLength(1));

    const stopSecond = state.watchSession("session-2");
    await vi.waitFor(() => expect(polls).toHaveLength(2));
    expect(polls[0]?.aborted).toBe(true);
    expect(polls[1]?.aborted).toBe(false);
    expect(state.projections.getSnapshot().connections["session-1"]?.status)
      .toBe("connected");

    stopFirst();
    expect(polls[1]?.aborted).toBe(false);
    stopSecond();
    expect(polls[1]?.aborted).toBe(true);

    const stopThird = state.watchSession("session-3");
    await vi.waitFor(() => expect(polls).toHaveLength(3));
    state.dispose();
    expect(polls[2]?.aborted).toBe(true);
    stopThird();
  });

  it("ignores a historical snapshot that returns after its session is replaced", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readSessionActivity = vi.fn(async input => {
      if (input.sessionId === "session-1" && input.task !== undefined) await gate;
      return {
        ok: true as const,
        value: historyProjection(input.sessionId, input.task?.name === "review" ? "review" : "current"),
      };
    });
    const state = new AcpusClientState(remoteStub({
      readSessionActivity,
      awaitSessionActivityRevision: vi.fn(async (_input, signal) => {
        if (signal === undefined) throw new Error("Expected cancellation.");
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false as const, error: { message: "aborted" } };
      }),
    }));
    const stopFirst = state.watchSession("session-1");
    await vi.waitFor(() => expect(state.selectedTask("session-1"))
      .toEqual({ name: "current", occurrence: 1 }));
    const selection = state.selectTask("session-1", { name: "review", occurrence: 1 });

    const stopSecond = state.watchSession("session-2");
    release?.();
    await expect(selection).resolves.toBe(false);
    expect(state.selectedTask("session-1")).toEqual({ name: "current", occurrence: 1 });
    expect(state.projections.getSnapshot().connections["session-1"]?.status).toBe("connected");
    stopFirst();
    stopSecond();
  });

  it("retains a terminal task until the next task projection replaces it", async () => {
    const terminal = taskProjection("session-1", 1, "completed", "finished");
    const next = taskProjection("session-1", 2, "running", "next");
    let publishNext: (() => void) | undefined;
    const update = new Promise<void>(resolve => {
      publishNext = resolve;
    });
    let calls = 0;
    const state = new AcpusClientState(remoteStub({
      awaitSessionActivityRevision: vi.fn(async (_input, signal) => {
        calls += 1;
        if (calls === 1) {
          await update;
          return {
            ok: true as const,
            value: { revision: next.revision },
          };
        }
        if (signal === undefined) throw new Error("Expected cancellation.");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }),
      readSessionActivity: vi.fn(async () => ({
        ok: true as const,
        value: calls === 0 ? terminal : next,
      })),
    }));

    const stop = state.watchSession("session-1");
    await vi.waitFor(() =>
      expect(state.projections.getSnapshot().sessions["session-1"]?.task?.status)
        .toBe("completed")
    );
    expect(state.projections.getSnapshot().sessions["session-1"]?.task?.tree[0])
      .toMatchObject({ label: "finished" });

    publishNext?.();
    await vi.waitFor(() =>
      expect(state.projections.getSnapshot().sessions["session-1"]?.task?.status)
        .toBe("running")
    );
    expect(state.projections.getSnapshot().sessions["session-1"]?.task?.tree[0])
      .toMatchObject({ label: "next" });
    stop();
  });

  it("does not replace a newer projection with a stale read", async () => {
    let resolveFirst: ((result: Awaited<ReturnType<AcpusRemote["readSessionActivity"]>>) => void)
      | undefined;
    const first = new Promise<Awaited<ReturnType<AcpusRemote["readSessionActivity"]>>>(resolve => {
      resolveFirst = resolve;
    });
    const readSessionActivity = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ok: true as const, value: projection("session-1", 2) });
    const state = new AcpusClientState(remoteStub({ readSessionActivity }));

    const stale = state.readSession("session-1");
    await state.readSession("session-1");
    resolveFirst?.({ ok: true, value: projection("session-1", 1) });
    await stale;

    expect(state.projections.getSnapshot().sessions["session-1"]?.revision).toBe(2);
  });

  it("retains the last projection and fully resynchronizes after a transport failure", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const awaitSessionActivityRevision = vi.fn(async (_input, signal) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, error: { message: "connection reset" } };
        if (signal === undefined) throw new Error("Expected cancellation.");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      });
      const readSessionActivity = vi.fn(async input => ({
        ok: true as const,
        value: projection(input.sessionId, 1),
      }));
      const state = new AcpusClientState(remoteStub({
        awaitSessionActivityRevision,
        readSessionActivity,
      }));
      const stop = state.watchSession("session-1");

      await vi.advanceTimersByTimeAsync(0);
      expect(state.projections.getSnapshot().sessions["session-1"]?.revision).toBe(1);
      expect(state.projections.getSnapshot().connections["session-1"]?.status)
        .toBe("disconnected");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(readSessionActivity).toHaveBeenCalledTimes(2);
      expect(awaitSessionActivityRevision).toHaveBeenCalledTimes(2);
      expect(state.projections.getSnapshot().connections["session-1"]?.status)
        .toBe("connected");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the original disconnect time across failed resynchronization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      let reads = 0;
      const state = new AcpusClientState(remoteStub({
        readSessionActivity: vi.fn(async input => {
          reads += 1;
          return reads === 1
            ? { ok: true as const, value: projection(input.sessionId, 1) }
            : { ok: false as const, error: { message: "offline" } };
        }),
        awaitSessionActivityRevision: vi.fn(async () => ({
          ok: false as const,
          error: { message: "connection reset" },
        })),
      }));
      const stop = state.watchSession("session-1");

      await vi.advanceTimersByTimeAsync(0);
      const disconnected = state.projections.getSnapshot().connections["session-1"];
      expect(disconnected).toMatchObject({
        status: "disconnected",
        synchronizedAt: 10_000,
        disconnectedAt: 10_000,
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.projections.getSnapshot().connections["session-1"])
        .toEqual(disconnected);
      expect(reads).toBe(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the cancel response projection immediately", async () => {
    const canceled = taskProjection("session-1", 2, "completed", "canceled task");
    const cancelSessionTask = vi.fn(async () => ({
      ok: true as const,
      value: { status: "applied" as const, projection: canceled },
    }));
    const state = new AcpusClientState(remoteStub({ cancelSessionTask }));

    await expect(state.cancelSessionTask("session-1", 1)).resolves.toMatchObject({
      status: "applied",
    });
    expect(cancelSessionTask).toHaveBeenCalledWith({ sessionId: "session-1", generation: 1 });
    expect(state.projections.getSnapshot().sessions["session-1"]).toBe(canceled);
    expect(state.projections.getSnapshot().connections["session-1"]?.status)
      .toBe("connected");
  });

  it("marks an unconfirmed cancel as disconnected without dropping the task", async () => {
    const state = new AcpusClientState(remoteStub({
      cancelSessionTask: vi.fn(async () => ({
        ok: false as const,
        error: { message: "connection reset" },
      })),
    }));
    await state.readSession("session-1");

    await expect(state.cancelSessionTask("session-1", 1)).rejects.toThrow("connection reset");
    expect(state.projections.getSnapshot().sessions["session-1"]?.revision).toBe(1);
    expect(state.projections.getSnapshot().connections["session-1"]?.status)
      .toBe("disconnected");
  });
});

function remoteStub(overrides: Partial<AcpusRemote> = {}): AcpusRemote {
  return {
    readAgentPresets: vi.fn(async () => ({
      ok: true as const,
      value: { presets: [] },
    })),
    readActivityDetail: vi.fn(async () => ({
      ok: true as const,
      value: { status: "rejected" as const, reason: "node-unavailable" as const },
    })),
    readSessionActivity: vi.fn(async input => ({
      ok: true as const,
      value: projection(input.sessionId, 1),
    })),
    awaitSessionActivityRevision: vi.fn(async input => ({
      ok: true as const,
      value: { revision: input.afterRevision },
    })),
    cancelSessionTask: vi.fn(async input => ({
      ok: true as const,
      value: {
        status: "rejected" as const,
        reason: "task-unavailable" as const,
        projection: projection(input.sessionId, 1),
      },
    })),
    ...overrides,
  };
}

function projection(sessionId: string, revision: number): SessionActivityProjection {
  return { sessionId, revision, tasks: [], tasksTruncated: false };
}

function historyProjection(
  sessionId: string,
  selected: "current" | "review",
): SessionActivityProjection {
  const current = taskProjection(sessionId, 2, "running", "current");
  const review = taskProjection(sessionId, 1, "completed", "review");
  const activity = (selected === "current" ? current : review).task;
  return {
    sessionId,
    revision: 2,
    tasks: [current.tasks[0]!, review.tasks[0]!],
    tasksTruncated: false,
    ...(activity === undefined ? {} : { task: activity }),
  };
}

function threeTaskProjection(
  sessionId: string,
  selected: string,
): SessionActivityProjection {
  const current = taskProjection(sessionId, 3, "running", "current");
  const review = taskProjection(sessionId, 2, "completed", "review");
  const archive = taskProjection(sessionId, 1, "completed", "archive");
  const choices = { current, review, archive } as const;
  const activity = choices[selected as keyof typeof choices]?.task;
  return {
    sessionId,
    revision: 3,
    tasks: [current.tasks[0]!, review.tasks[0]!, archive.tasks[0]!],
    tasksTruncated: false,
    ...(activity === undefined ? {} : { task: activity }),
  };
}

function newAdmissionProjection(
  sessionId: string,
  selected: "review" | "new-task",
): SessionActivityProjection {
  const latest = taskProjection(sessionId, 3, "running", "new-task");
  const current = taskProjection(sessionId, 2, "running", "current");
  const review = taskProjection(sessionId, 1, "completed", "review");
  const activity = selected === "new-task" ? latest.task : review.task;
  return {
    sessionId,
    revision: 3,
    tasks: [latest.tasks[0]!, current.tasks[0]!, review.tasks[0]!],
    tasksTruncated: false,
    ...(activity === undefined ? {} : { task: activity }),
  };
}

function taskProjection(
  sessionId: string,
  revision: number,
  status: "running" | "completed",
  label: string,
): SessionActivityProjection {
  return {
    sessionId,
    revision,
    tasks: [{
      task: { name: label, occurrence: 1 },
      status,
      availability: { status: "available" },
      counts: counts(status),
      startedAt: "2026-08-14T00:00:00.000Z",
      ...(status === "completed" ? { finishedAt: "2026-08-14T00:01:00.000Z" } : {}),
    }],
    tasksTruncated: false,
    task: {
      selector: { name: label, occurrence: 1 },
      generation: revision,
      status,
      availability: { status: "available" },
      counts: counts(status),
      startedAt: "2026-08-14T00:00:00.000Z",
      ...(status === "completed" ? { finishedAt: "2026-08-14T00:01:00.000Z" } : {}),
      tree: [{
        activityId: `node-${revision}`,
        label,
        kind: "agent",
        status,
        children: [],
      }],
    },
  };
}

function counts(status: "running" | "completed") {
  return {
    total: 1,
    notStarted: 0,
    pending: 0,
    running: status === "running" ? 1 : 0,
    awaiting: 0,
    completed: status === "completed" ? 1 : 0,
    failed: 0,
    timedOut: 0,
    canceled: 0,
  };
}
