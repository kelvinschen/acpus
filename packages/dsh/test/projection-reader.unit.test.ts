import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { AcpusMode } from "../src/host/mode.js";
import type { StoredRunProjection } from "../src/host/run-projection.js";
import { AcpusProjectionReader } from "../src/remote/reader.js";

describe("Acpus session activity reader", () => {
  it.effect("indexes the latest 50 tasks, filters exact names, and resolves fork selectors", () => Effect.gen(function* () {
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

    const projection = yield* reader.readSessionActivity("session-1", {
      name: "review",
      occurrence: 51,
    });
    const filtered = yield* reader.readTasks("session-1", "review");

    expect(projection.tasks).toHaveLength(50);
    expect(projection.tasksTruncated).toBe(true);
    expect(projection.tasks[0]).toMatchObject({
      task: { name: "Review", occurrence: 52 },
      forkedFrom: { name: "review", occurrence: 1 },
    });
    expect(projection.task?.selector).toEqual({ name: "review", occurrence: 51 });
    expect(filtered.tasks).toHaveLength(26);
    expect(filtered.tasks.every(task => task.task.name === "review")).toBe(true);
  }));

  it.effect("publishes the complete current activity tree without private identity", () => Effect.gen(function* () {
    const older = storedRun("run-old", "2026-08-14T00:00:00.000Z");
    const current = storedRun("run-current", "2026-08-14T00:00:01.000Z", {
      unavailable: {
        reason: "workspace-unavailable",
        detail: "Restore the original path and retry.",
        detectedAt: "2026-08-14T00:00:02.000Z",
      },
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

    const projection = yield* reader.readSessionActivity("session-1");

    expect(projection).toMatchObject({ sessionId: "session-1", revision: 7 });
    expect(projection.task?.tree).toHaveLength(202);
    expect(projection.task?.availability).toEqual({
      status: "unavailable",
      reason: "workspace-unavailable",
      workspace: "/workspace",
      detail: "Restore the original path and retry.",
      detectedAt: "2026-08-14T00:00:02.000Z",
    });
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
  }));

  it.effect("uses Effect time for the 200 second Client activity wait", () => Effect.gen(function* () {
    let revision = 1;
    const started = yield* Deferred.make<void>();
    const waitForActivityRevision = vi.fn(() => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => {
        revision = 2;
      })),
    ));
    const readSession = vi.fn((sessionId: string) => Effect.succeed({
      sessionId,
      revision,
      runs: [],
    }));
    const reader = new AcpusProjectionReader({
      sessions: { readSession, waitForActivityRevision },
    });

    const pending = yield* Effect.forkChild(
      reader.awaitSessionActivityRevision("session-1", 1),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(199_999);
    expect(readSession).toHaveBeenCalledOnce();
    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(pending)).toEqual({ revision: 2 });
    expect(waitForActivityRevision).toHaveBeenCalledOnce();

    revision = 3;
    expect(yield* reader.awaitSessionActivityRevision("session-1", 1))
      .toEqual({ revision: 3 });
    expect(waitForActivityRevision).toHaveBeenCalledOnce();
  }));

  it("normalizes structured caller abort reasons at the Typert boundary", async () => {
    const started = Deferred.makeUnsafe<void>();
    const mode = Object.create(AcpusMode.prototype) as AcpusMode;
    Object.assign(mode, {
      projections: {
        awaitSessionActivityRevision: vi.fn(() => Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
        )),
      },
    });
    const controller = new AbortController();
    const pending = mode.awaitSessionActivityRevision({
      sessionId: "session-1",
      afterRevision: 2,
    }, controller.signal);
    await Effect.runPromise(Deferred.await(started));
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
      readSession: vi.fn((sessionId: string) => Effect.succeed({
        sessionId,
        revision: 7,
        runs,
      })),
      waitForActivityRevision: vi.fn(() => Effect.never),
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
