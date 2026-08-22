import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import {
  DurableSupervisorStateStore,
  type AdmittedRunLink,
  type RunLink,
} from "../src/host/run-links.js";
import type { StoredRunProjection } from "../src/host/run-projection.js";
import { deriveNotice } from "../src/host/notices.js";
import { run } from "./effect.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable supervisor state", () => {
  it("allocates stable session-local occurrences and preserves fork ancestry", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const first = await run(store.provisional(linkInput({ admissionRequestId: "first" })));
    const admittedFirst = await run(store.admitted(first.admissionRequestId, { id: "run-1", name: "review" }));
    const replay = await run(store.admitted(first.admissionRequestId, { id: "run-1", name: "review" }));
    const second = await run(store.provisional(linkInput({
      admissionRequestId: "second",
      forkedFromGeneration: admittedFirst.generation,
    })));
    const admittedSecond = await run(store.admitted(second.admissionRequestId, { id: "run-2", name: "review" }));
    const other = await run(store.provisional(linkInput({ admissionRequestId: "other" })));
    const admittedOther = await run(store.admitted(other.admissionRequestId, { id: "run-3", name: "audit" }));

    expect(replay.occurrence).toBe(1);
    expect(admittedSecond).toMatchObject({ occurrence: 2, forkedFromGeneration: 1 });
    expect(admittedOther.occurrence).toBe(1);
  });

  it("increments only semantic projection revisions and inserts notices atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const path = join(root, "state.json");
    const store = new DurableSupervisorStateStore(path);
    const link = await run(store.provisional(linkInput()));
    const admitted = await run(store.admitted(link.admissionRequestId, { id: "run-1", name: "Example run" }));
    const projection = storedProjection({ generation: admitted.generation, occurrence: admitted.occurrence });

    await expect(run(store.commitObservation({ link: admitted, projection }))).resolves.toEqual({
      revision: 1,
      projectionChanged: true,
      noticeInserted: false,
      wakeWaiters: true,
    });
    await expect(run(store.commitObservation({
      link: admitted,
      projection: structuredClone(projection),
    }))).resolves.toEqual({
      revision: 1,
      projectionChanged: false,
      noticeInserted: false,
      wakeWaiters: false,
    });

    const derived = deriveNotice({
      runId: projection.runId,
      task: { name: "Example run", occurrence: 1 },
      status: "awaiting",
      updatedAt: "2026-08-14T00:00:01.000Z",
      actionRequired: {
        kind: "signal",
        signal: "approval",
        prompt: "Approve?",
        expected: "boolean",
      },
    });
    if (derived === undefined) throw new Error("Expected a notice.");
    const notice = {
      id: derived.id,
      parentSessionId: admitted.parentSessionId,
      workspace: admitted.workspace,
      runId: "run-1",
      task: { name: "Example run", occurrence: 1 },
      kind: "signal" as const,
      projectionUpdatedAt: "2026-08-14T00:00:01.000Z",
      signal: {
        selector: "approval",
        prompt: "Approve?",
        expected: "boolean",
      },
    };
    const awaiting = {
      ...projection,
      status: "awaiting" as const,
      updatedAt: notice.projectionUpdatedAt,
      actionRequirement: notice.signal,
    };
    await expect(run(store.commitObservation({
      link: admitted,
      projection: awaiting,
      notice,
    }))).resolves.toEqual({
      revision: 2,
      projectionChanged: true,
      noticeInserted: true,
      wakeWaiters: true,
    });
    await expect(run(store.commitObservation({
      link: admitted,
      projection: awaiting,
      notice,
    }))).resolves.toEqual({
      revision: 2,
      projectionChanged: false,
      noticeInserted: false,
      wakeWaiters: false,
    });

    expect(await run(store.pendingNotices())).toEqual([notice]);
    await run(store.markNoticeDelivered(notice.id));
    expect(await run(store.pendingNotices())).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      kind: "acpus_dsh_supervisor_state",
      version: 1,
      sessions: [{ sessionId: "session-1", revision: 2 }],
      notices: [{ id: notice.id, deliveredAt: expect.any(String) }],
    });
  });

  it("tracks non-terminal availability without reopening terminal history", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const admitted = await admittedLink(store, "session-1", "run-1");
    await run(store.commitObservation({ link: admitted, projection: storedProjection() }));

    await expect(run(store.setRunUnavailable({
      link: admitted,
      unavailable: {
        reason: "workspace-unavailable",
        detail: "Restore the original path.",
        detectedAt: "2026-08-17T00:00:00.000Z",
      },
    }))).resolves.toEqual({ revision: 2, changed: true });
    await expect(run(store.setRunUnavailable({
      link: admitted,
      unavailable: {
        reason: "workspace-unavailable",
        detail: "A later probe returned the same reason.",
        detectedAt: "2026-08-17T00:01:00.000Z",
      },
    }))).resolves.toEqual({ revision: 2, changed: false });
    expect((await run(store.readSession("session-1"))).runs[0]?.unavailable).toEqual({
      reason: "workspace-unavailable",
      detail: "Restore the original path.",
      detectedAt: "2026-08-17T00:00:00.000Z",
    });

    await expect(run(store.setRunUnavailable({ link: admitted }))).resolves.toEqual({
      revision: 3,
      changed: true,
    });
    await run(store.commitObservation({
      link: admitted,
      projection: storedProjection({
        status: "completed",
        updatedAt: "2026-08-17T00:02:00.000Z",
      }),
    }));

    expect(await run(store.listReconciliationLinks())).toEqual([]);
  });

  it("keeps independent monotonic revisions per parent session", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const first = await admittedLink(store, "session-1", "run-1");
    const second = await admittedLink(store, "session-2", "run-2");

    await run(store.commitObservation({
      link: first,
      projection: storedProjection({ runId: "run-1" }),
    }));
    await run(store.commitObservation({
      link: second,
      projection: storedProjection({ runId: "run-2" }),
    }));
    await run(store.commitObservation({
      link: first,
      projection: storedProjection({
        runId: "run-1",
        updatedAt: "2026-08-14T00:00:02.000Z",
      }),
    }));

    expect((await run(store.readSession("session-1"))).revision).toBe(2);
    expect((await run(store.readSession("session-2"))).revision).toBe(1);
  });

  it("authorizes session reads through current links and rebinds link identity", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const admitted = await admittedLink(store, "session-1", "run-1");
    await run(store.commitObservation({
      link: admitted,
      projection: storedProjection({
        workspace: "/stale",
        admissionRequestId: "stale-admission",
      }),
    }));

    await expect(run(store.readSession("session-1"))).resolves.toMatchObject({
      runs: [{
        runId: "run-1",
        workspace: "/workspace",
        admissionRequestId: "admission-run-1",
      }],
    });
    await expect(run(store.readSession("other-session"))).resolves.toEqual({
      sessionId: "other-session",
      revision: 0,
      runs: [],
    });
  });

  it("preserves an active node start across activity-only projection updates", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const admitted = await admittedLink(store, "session-1", "run-1");
    const first = storedProjection({
      activity: [activityNode("2026-08-14T00:00:01.000Z", "read")],
    });
    await run(store.commitObservation({ link: admitted, projection: first }));
    await run(store.commitObservation({
      link: admitted,
      projection: {
        ...first,
        updatedAt: "2026-08-14T00:00:05.000Z",
        activity: [activityNode("2026-08-14T00:00:05.000Z", "bash")],
      },
    }));

    expect((await run(store.readSession("session-1"))).runs[0]?.activity[0]).toMatchObject({
      startedAt: "2026-08-14T00:00:01.000Z",
      agent: { tool: { name: "bash", state: "running" } },
    });
  });

  it("emits one notice for one terminal episode when its projection timestamp settles", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const admitted = await admittedLink(store, "session-1", "run-1");
    await run(store.commitObservation({ link: admitted, projection: storedProjection() }));
    const first = terminalNotice("notice-first", "2026-08-14T00:00:01.000Z");
    const settled = terminalNotice("notice-settled", "2026-08-14T00:00:02.000Z");

    await expect(run(store.commitObservation({
      link: admitted,
      projection: storedProjection({ status: "completed", updatedAt: first.projectionUpdatedAt }),
      notice: first,
    }))).resolves.toMatchObject({ noticeInserted: true });
    await expect(run(store.commitObservation({
      link: admitted,
      projection: storedProjection({ status: "completed", updatedAt: settled.projectionUpdatedAt }),
      notice: settled,
    }))).resolves.toMatchObject({
      projectionChanged: true,
      noticeInserted: false,
    });
    expect(await run(store.pendingNotices())).toEqual([first]);
  });

  it("persists exact-generation cancel intent before settlement and emits one user attention", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const path = join(root, "state.json");
    const store = new DurableSupervisorStateStore(path);
    const admitted = await admittedLink(store, "session-1", "run-1");
    await run(store.commitObservation({ link: admitted, projection: storedProjection() }));

    const stale = await run(store.prepareCancel({
      sessionId: "session-1",
      generation: admitted.generation + 1,
      actor: "user",
    }));
    expect(stale).toEqual({ status: "rejected", reason: "task-unavailable" });

    const prepared = await run(store.prepareCancel({
      sessionId: "session-1",
      generation: admitted.generation,
      actor: "user",
    }));
    expect(prepared).toMatchObject({ status: "ready", control: { status: "pending" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      controls: [{ status: "pending", generation: admitted.generation }],
    });
    if (prepared.status !== "ready") throw new Error("Expected prepared cancel.");

    await run(store.settleCancel({
      controlId: prepared.control.id,
      outcome: "applied",
      taskStatus: "canceled",
    }));
    await run(store.settleCancel({
      controlId: prepared.control.id,
      outcome: "applied",
      taskStatus: "canceled",
    }));

    expect(await run(store.pendingControls())).toEqual([]);
    expect(await run(store.pendingNotices())).toEqual([
      expect.objectContaining({
        kind: "user-control",
        control: {
          actor: "user",
          operation: "cancel",
          outcome: "applied",
          taskStatus: "canceled",
        },
      }),
    ]);
  });

  it("suppresses the generic canceled notice after either cancel actor records intent", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const admitted = await admittedLink(store, "session-1", "run-1");
    await run(store.commitObservation({ link: admitted, projection: storedProjection() }));
    await run(store.prepareCancel({
      sessionId: "session-1",
      generation: admitted.generation,
      actor: "model",
      requestId: "tool-call-1",
    }));

    await run(store.commitObservation({
      link: admitted,
      projection: storedProjection({ status: "canceled", updatedAt: "2026-08-14T00:00:02.000Z" }),
      notice: {
        id: "terminal-canceled",
        parentSessionId: "session-1",
        workspace: "/workspace",
        runId: "run-1",
        task: { name: "Example run", occurrence: 1 },
        kind: "canceled",
        projectionUpdatedAt: "2026-08-14T00:00:02.000Z",
      },
    }));

    expect(await run(store.pendingNotices())).toEqual([]);
  });

  it("serializes concurrent mutations without losing session generations", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const store = new DurableSupervisorStateStore(join(root, "state.json"));
    const links = await run(Effect.forEach(
      Array.from({ length: 12 }, (_, index) => index + 1),
      index => store.provisional(linkInput({ admissionRequestId: `admission-${index}` })),
      { concurrency: "unbounded" },
    ));

    expect(links.map(link => link.generation).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect((await run(store.listLinks())).map(link => link.admissionRequestId).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `admission-${index + 1}`).sort(),
    );
  });

  it("rolls back a failed persistence mutation and accepts the next mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const stateDirectory = join(root, "state");
    const store = new DurableSupervisorStateStore(join(stateDirectory, "state.json"));
    await run(store.readSession("session-1"));
    await writeFile(stateDirectory, "blocks the state directory");

    await expect(run(store.provisional(linkInput()))).rejects.toMatchObject({
      code: "ACPUS_RUN_LINK_WRITE_FAILED",
    });
    await rm(stateDirectory);

    await expect(run(store.provisional(linkInput()))).resolves.toMatchObject({ generation: 1 });
    await expect(run(store.listLinks())).resolves.toHaveLength(1);
  });

  it("finishes an accepted persistence mutation after its fiber is interrupted", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-state-"));
    const path = join(root, "state.json");
    const store = new DurableSupervisorStateStore(path);
    await run(store.readSession("session-1"));
    const mutation = (store as unknown as { mutation: Semaphore.Semaphore }).mutation;

    await run(Effect.gen(function* () {
      yield* mutation.take(1);
      const fiber = yield* Effect.forkChild(store.provisional(linkInput()));
      yield* Effect.yieldNow;
      const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* mutation.release(1);
      yield* Fiber.join(interrupter);
      yield* Fiber.await(fiber);
    }));

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      links: [{ admissionRequestId: "admission-1", generation: 1 }],
    });
  });
});

function terminalNotice(id: string, projectionUpdatedAt: string) {
  return {
    id,
    parentSessionId: "session-1",
    workspace: "/workspace",
    runId: "run-1",
    task: { name: "Example run", occurrence: 1 },
    kind: "completed" as const,
    projectionUpdatedAt,
  };
}

function activityNode(startedAt: string, tool: string) {
  return {
    key: "@111111111111",
    activityId: "11111111111111111111111111111111",
    target: "@111111111111",
    label: "Review",
    kind: "agent",
    status: "running" as const,
    startedAt,
    agent: { phase: "tool" as const, turn: 1, tool: { name: tool, state: "running" as const } },
    children: [],
  };
}

async function admittedLink(
  store: DurableSupervisorStateStore,
  sessionId: string,
  runId: string,
): Promise<AdmittedRunLink> {
  const provisional = await run(store.provisional(linkInput({
    admissionRequestId: `admission-${runId}`,
    parentSessionId: sessionId,
  })));
  return run(store.admitted(provisional.admissionRequestId, { id: runId, name: "Example run" }));
}

function linkInput(
  overrides: Partial<Omit<RunLink, "runId" | "generation">> = {},
): Omit<RunLink, "runId" | "generation"> {
  return {
    workspace: "/workspace",
    admissionRequestId: "admission-1",
    parentSessionId: "session-1",
    ...overrides,
  };
}

function storedProjection(
  overrides: Partial<StoredRunProjection> = {},
): StoredRunProjection {
  return {
    runId: "run-1",
    workspace: "/workspace",
    admissionRequestId: "admission-1",
    generation: 1,
    occurrence: 1,
    name: "Example run",
    status: "running",
    counts: {
      total: 1,
      completed: 0,
      failed: 0,
      running: 1,
      awaiting: 0,
      timedOut: 0,
      cancelled: 0,
      mixed: 0,
    },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    activity: [],
    ...overrides,
  };
}
