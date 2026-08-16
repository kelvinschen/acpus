import { describe, expect, it, vi } from "vitest";
import type { StoredRunProjection } from "../src/host/run-projection.js";
import { AcpusProjectionReader } from "../src/remote/reader.js";
import {
  LONG_POLL_MS,
} from "../src/remote/types.js";

describe("Acpus session activity reader", () => {
  it("indexes the latest 50 tasks, filters exact names, and resolves fork selectors", async () => {
    const runs = Array.from({ length: 52 }, (_, index) => storedRun(
      `run-${index + 1}`,
      `2026-08-14T00:00:${String(index).padStart(2, "0")}.000Z`,
      {
        generation: index + 1,
        occurrence: index + 1,
        name: index % 2 === 0 ? "review" : "Review",
        ...(index === 51 ? { forkedFromGeneration: 1 } : {}),
      },
    ));
    const reader = new AcpusProjectionReader(dependencies(runs));

    const projection = await reader.readSessionActivity("session-1", {
      name: "review",
      occurrence: 51,
    });
    const filtered = await reader.readTasks("session-1", "review");

    expect(projection.tasks).toHaveLength(50);
    expect(projection.tasksTruncated).toBe(true);
    expect(projection.tasks[0]).toMatchObject({
      task: { name: "Review", occurrence: 52 },
      forkedFrom: { name: "review", occurrence: 1 },
    });
    expect(projection.task?.selector).toEqual({ name: "review", occurrence: 51 });
    expect(filtered.tasks).toHaveLength(26);
    expect(filtered.tasks.every(task => task.task.name === "review")).toBe(true);
  });

  it("publishes the complete current activity tree without private identity", async () => {
    const older = storedRun("run-old", "2026-08-14T00:00:00.000Z");
    const current = storedRun("run-current", "2026-08-14T00:00:01.000Z", {
      activity: Array.from({ length: 202 }, (_, index) => ({
        key: `private-${index}`,
        activityId: String(index).padStart(32, "0"),
        target: `@private-${index}`,
        label: `Node ${index}`,
        kind: "agent",
        status: "running" as const,
        startedAt: "2026-08-14T00:00:01.000Z",
        agent: {
          name: "codex",
          phase: "tool" as const,
          tool: {
            name: "Search",
            title: "Search something useful",
            state: "running" as const,
          },
          telemetry: {
            inputTokens: 12_000,
            outputTokens: 2_400,
            contextWindow: { used: 12_000, size: 32_000 },
          },
        },
        children: [],
      })),
    });
    const reader = new AcpusProjectionReader(dependencies([older, current]));

    const projection = await reader.readSessionActivity("session-1");

    expect(projection).toMatchObject({ sessionId: "session-1", revision: 7 });
    expect(projection.task?.tree).toHaveLength(202);
    expect(projection.task).not.toHaveProperty("runId");
    expect(projection.task).not.toHaveProperty("name");
    expect(projection.tasks[0]).not.toHaveProperty("runId");
    expect(projection.tasks[0]).not.toHaveProperty("workspace");
    expect(projection.tasks[0]).not.toHaveProperty("generation");
    expect(projection.task?.tree[0]).not.toHaveProperty("key");
    expect(projection.task?.tree[0]).not.toHaveProperty("target");
    expect(projection.task?.tree[0]).toHaveProperty("activityId", "00000000000000000000000000000000");
    expect(projection.task?.tree[0]).toMatchObject({
      agent: {
        name: "codex",
        phase: "tool",
        tool: {
          name: "Search",
          title: "Search something useful",
          state: "running",
        },
        telemetry: {
          inputTokens: 12_000,
          outputTokens: 2_400,
          contextWindow: { used: 12_000, size: 32_000 },
        },
      },
    });
  });

  it("uses only the Client activity wait channel", async () => {
    let revision = 1;
    const waitForActivityRevision = vi.fn(async () => undefined);
    const reader = new AcpusProjectionReader({
      sessions: {
        readSession: vi.fn(async sessionId => ({ sessionId, revision, runs: [] })),
        waitForActivityRevision,
      },
    });

    expect(LONG_POLL_MS).toBe(200_000);
    await expect(reader.awaitSessionActivityRevision("session-1", 1, undefined, 1))
      .resolves.toEqual({ revision: 1 });
    expect(waitForActivityRevision).toHaveBeenCalledOnce();

    revision = 2;
    await expect(reader.awaitSessionActivityRevision("session-1", 1))
      .resolves.toEqual({ revision: 2 });
  });

  it("aborts a pending activity wait with its caller", async () => {
    const waitForActivityRevision = vi.fn(async (_sessionId, _after, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const reader = new AcpusProjectionReader({
      sessions: {
        readSession: vi.fn(async sessionId => ({ sessionId, revision: 2, runs: [] })),
        waitForActivityRevision,
      },
    });
    const controller = new AbortController();
    const pending = reader.awaitSessionActivityRevision("session-1", 2, controller.signal);
    await vi.waitFor(() => expect(waitForActivityRevision).toHaveBeenCalledOnce());
    controller.abort(new Error("session closed"));

    await expect(pending).rejects.toThrow("session closed");
  });

  it("normalizes structured caller abort reasons to an Error", async () => {
    const waitForActivityRevision = vi.fn(async (_sessionId, _after, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const reader = new AcpusProjectionReader({
      sessions: {
        readSession: vi.fn(async sessionId => ({ sessionId, revision: 2, runs: [] })),
        waitForActivityRevision,
      },
    });
    const controller = new AbortController();
    const pending = reader.awaitSessionActivityRevision("session-1", 2, controller.signal);
    await vi.waitFor(() => expect(waitForActivityRevision).toHaveBeenCalledOnce());
    controller.abort({ message: "DSH session exited" });

    await expect(pending).rejects.toEqual(expect.objectContaining({
      name: "Error",
      message: "DSH session exited",
    }));
  });

});

function dependencies(runs: StoredRunProjection[]) {
  return {
    sessions: {
      readSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        revision: 7,
        runs,
      })),
      waitForActivityRevision: vi.fn(),
    },
  };
}

function storedRun(
  runId: string,
  createdAt: string,
  overrides: Partial<StoredRunProjection> = {},
): StoredRunProjection {
  return {
    runId,
    workspace: "/workspace",
    admissionRequestId: `private-task-${runId}`,
    generation: runId === "run-current" ? 2 : 1,
    occurrence: 1,
    name: `Task ${runId}`,
    status: "running",
    counts: { total: 1, running: 1 },
    createdAt,
    updatedAt: createdAt,
    activity: [],
    ...overrides,
  };
}
