import type { OwnedProcessError, ProcessExit, OwnedProcess, ProcessHostShape } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { beforeEach, describe, expect, vi } from "vitest";

const removeRejectedArtifact = vi.hoisted(() => vi.fn(async (_path: string) => undefined));
vi.mock("../src/store/path-fence.js", () => ({
  verifyRunDirectoryToken: (token: { runDirectory: { path: string } }) => token.runDirectory.path,
}));
vi.mock("../src/store/run-file.js", () => ({
  verifyRunFile: (_run: unknown, file: { path: string }) => file.path,
  removeRunFile: (_run: unknown, file: { path: string }) => removeRejectedArtifact(file.path),
}));

import { runTaskAttempt } from "../src/execution/task-process.js";

describe("task process Effect boundary", () => {
  let process: FakeProcess;

  beforeEach(() => {
    process = fakeProcess();
    removeRejectedArtifact.mockClear();
  });

  it.effect("times out when spawn exhausts the remaining budget", () => Effect.gen(function* () {
    process.spawnElapsedMs = 11;
    const running = yield* Effect.forkChild(runTaskAttempt(taskInput("slow_spawn", { timeoutMs: 10 })));
    yield* TestClock.adjust(11);
    const result = yield* Fiber.join(running);

    expect(Result.getOrThrow(Result.flip(result))).toMatchObject({ type: "timed_out" });
    expect(process.sent).not.toContainEqual({ type: "abort" });
  }));

  it.effect("rejects completion and artifact registration after the deadline", () => Effect.gen(function* () {
    process.closeOnAbort = false;
    const registerArtifact = vi.fn(() => Effect.void);
    const running = yield* Effect.forkChild(runTaskAttempt(taskInput("late_message", {
      timeoutMs: 10,
      store: { registerArtifact },
    })));
    yield* Effect.promise(() => process.spawned);
    yield* TestClock.adjust(11);
    process.message({
      type: "artifact_register",
      requestId: "artifact_1",
      artifact: artifact("late_message", "late"),
    });
    yield* Effect.promise(() => vi.waitFor(() => expect(removeRejectedArtifact).toHaveBeenCalledOnce()));
    expect(process.sent).toContainEqual({
      type: "artifact_result",
      requestId: "artifact_1",
      ok: false,
      error: "Task attempt is no longer accepting artifacts.",
    });
    process.message({ type: "completed", hasOutput: true, output: { late: true } });
    process.close({ exitCode: 0, signal: null });

    expect(Result.getOrThrow(Result.flip(yield* Fiber.join(running)))).toMatchObject({ type: "timed_out" });
    expect(registerArtifact).not.toHaveBeenCalled();
  }));

  it.effect("escalates timeout termination only after each grace period", () => Effect.gen(function* () {
    process.closeOnAbort = false;
    process.closeOnSignal = false;
    const running = yield* Effect.forkChild(runTaskAttempt(taskInput("hard_stop", { timeoutMs: 10 })));
    yield* Effect.promise(() => process.spawned);

    yield* TestClock.adjust(10);
    expect(process.sent).toContainEqual({ type: "abort" });
    expect(process.signals).toEqual([]);
    yield* TestClock.adjust(999);
    expect(process.signals).toEqual([]);
    yield* TestClock.adjust(1);
    expect(process.signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust(4_999);
    expect(process.signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust(1);
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    process.close({ exitCode: null, signal: "SIGKILL" });

    expect(Result.getOrThrow(Result.flip(yield* Fiber.join(running)))).toMatchObject({ type: "timed_out" });
  }));

  it("maps a spawn failure into TaskAttemptFailure", async () => {
    process.spawnError = processError("spawn", "spawn failed", "ENOENT");

    const result = await run(taskInput("failed_spawn"));

    expect(Result.getOrThrow(Result.flip(result))).toMatchObject({
      type: "failed",
      message: expect.stringContaining("spawn failed"),
    });
  });

  it.effect("lets an exhausted deadline win over a delayed Task failure", () => Effect.gen(function* () {
    const running = yield* Effect.forkChild(runTaskAttempt(taskInput("late_failure", { timeoutMs: 10 })));
    yield* Effect.promise(() => process.spawned);
    yield* TestClock.adjust(11);
    process.message({ type: "failed", message: "late task failure" });
    process.close({ exitCode: 1, signal: null });

    expect(Result.getOrThrow(Result.flip(yield* Fiber.join(running)))).toMatchObject({ type: "timed_out" });
  }));

  it.effect("lets an exhausted deadline override a previously reported completion", () => Effect.gen(function* () {
    const running = yield* Effect.forkChild(runTaskAttempt(taskInput("late_close", { timeoutMs: 10 })));
    yield* Effect.promise(() => process.spawned);
    process.message({ type: "completed", hasOutput: true, output: { early: true } });
    yield* TestClock.adjust(11);
    process.close({ exitCode: 0, signal: null });

    expect(Result.getOrThrow(Result.flip(yield* Fiber.join(running)))).toMatchObject({ type: "timed_out" });
  }));

  it("reports authored Task errors as a single failed message", async () => {
    const running = run(taskInput("failed_task"));
    await process.spawned;
    process.message({ type: "failed", message: "task exploded" });
    process.close({ exitCode: 1, signal: null });

    expect(Result.getOrThrow(Result.flip(await running))).toEqual({ type: "failed", message: "task exploded" });
  });

  it("keeps exit, signal, and bounded process output diagnostics", async () => {
    const running = run(taskInput("abrupt_exit"));
    await process.spawned;
    process.stderr(Buffer.from(`discarded-stderr-${"e".repeat(9_000)}stderr-tail`));
    process.stdout(Buffer.from(`discarded-stdout-${"o".repeat(9_000)}stdout-tail`));
    process.close({ exitCode: 23, signal: "SIGTERM" });

    const failure = Result.getOrThrow(Result.flip(await running));
    expect(failure).toMatchObject({ type: "failed" });
    expect(failure.message).toContain("code 23");
    expect(failure.message).toContain("SIGTERM");
    expect(failure.message).toContain("stderr-tail");
    expect(failure.message).toContain("stdout-tail");
    expect(failure.message).not.toContain("discarded-stderr");
    expect(failure.message).not.toContain("discarded-stdout");
  });

  function run(input: Parameters<typeof runTaskAttempt>[0]) {
    return Effect.runPromise(runTaskAttempt(input));
  }

  function taskInput(
    nodeId: string,
    overrides: Partial<Parameters<typeof runTaskAttempt>[0]> = {},
  ): Parameters<typeof runTaskAttempt>[0] {
    return {
      nodeId,
      cwd: "/repo",
      env: {},
      request: {
        target: { kind: "inline", source: "async () => undefined" },
        input: null,
        workspaceDir: "/repo",
        artifact: {
          run: {
            runId: "run_1",
            runsRoot: { path: "/repo/.acpus", realpath: "/repo/.acpus", filesystemIdentity: "root" },
            runDirectory: { path: "/repo/.acpus/run_1", realpath: "/repo/.acpus/run_1", filesystemIdentity: "run" },
          },
          nodeKey: nodeId,
          attemptId: "attempt_1",
          attempt: 1,
          ownerEpoch: 1,
          paths: {},
        },
      },
      processes: process.service,
      store: { registerArtifact: () => Effect.void },
      ...overrides,
    };
  }
});

type FakeProcess = ReturnType<typeof fakeProcess>;

function fakeProcess() {
  const closed = Deferred.makeUnsafe<ProcessExit, OwnedProcessError>();
  const stdout = Effect.runSync(Queue.unbounded<Uint8Array, OwnedProcessError | Cause.Done>());
  const stderr = Effect.runSync(Queue.unbounded<Uint8Array, OwnedProcessError | Cause.Done>());
  const messages = Effect.runSync(Queue.unbounded<unknown, OwnedProcessError | Cause.Done>());
  const sent: unknown[] = [];
  const signals: NodeJS.Signals[] = [];
  let hasClosed = false;
  let closeOnAbort = true;
  let closeOnSignal = true;
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>(resolve => { resolveSpawned = resolve; });
  const finish = (exit: ProcessExit) => {
    if (hasClosed) return;
    hasClosed = true;
    Queue.endUnsafe(stdout);
    Queue.endUnsafe(stderr);
    Queue.endUnsafe(messages);
    Deferred.doneUnsafe(closed, Effect.succeed(exit));
  };
  const handle: OwnedProcess = {
    pid: 123,
    target: { pid: 123, processGroupId: 123 },
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.fromQueue(stderr),
    messages: Stream.fromQueue(messages),
    closed: Deferred.await(closed),
    send: message => Effect.sync(() => {
      sent.push(message);
      if (closeOnAbort && (message as { type?: unknown }).type === "abort") finish({ exitCode: null, signal: "SIGTERM" });
    }),
    signal: signal => Effect.sync(() => {
      signals.push(signal);
      if (closeOnSignal) finish({ exitCode: null, signal });
    }),
  };
  let spawnElapsedMs = 0;
  let spawnError: OwnedProcessError | undefined;
  const service: ProcessHostShape = {
    spawn: () => Effect.sleep(spawnElapsedMs).pipe(Effect.andThen(Effect.suspend(() => {
      if (spawnError) return Effect.fail(spawnError);
      resolveSpawned();
      return Effect.succeed(handle);
    }))),
    signal: () => Effect.void,
    liveness: () => Effect.succeed("live"),
    startToken: () => Effect.succeed(undefined),
    identityLiveness: () => Effect.succeed("unverified"),
  };
  return {
    get spawnElapsedMs() { return spawnElapsedMs; },
    set spawnElapsedMs(value: number) { spawnElapsedMs = value; },
    get spawnError() { return spawnError; },
    set spawnError(value: OwnedProcessError | undefined) { spawnError = value; },
    get closeOnAbort() { return closeOnAbort; },
    set closeOnAbort(value: boolean) { closeOnAbort = value; },
    get closeOnSignal() { return closeOnSignal; },
    set closeOnSignal(value: boolean) { closeOnSignal = value; },
    sent,
    signals,
    spawned,
    service,
    message: (message: unknown) => { Queue.offerUnsafe(messages, message); },
    stdout: (chunk: Uint8Array) => { Queue.offerUnsafe(stdout, chunk); },
    stderr: (chunk: Uint8Array) => { Queue.offerUnsafe(stderr, chunk); },
    close: finish,
  };
}

function artifact(nodeKey: string, suffix: string) {
  return {
    id: "artifact_1",
    runId: "run_1",
    nodeKey,
    attemptId: "attempt_1",
    attempt: 1,
    ownerEpoch: 1,
    digest: `sha256:${suffix}`,
    size: 1,
    relativePath: `artifacts/${nodeKey}/attempt-1/artifact_1-${suffix}.txt`,
    file: { path: `/repo/.acpus/run_1/artifacts/${nodeKey}/attempt-1/artifact_1-${suffix}.txt` },
  };
}

function processError(operation: OwnedProcessError["operation"], message: string, code?: string): OwnedProcessError {
  return { type: "process", operation, message, ...(code === undefined ? {} : { code }), cause: new Error(message) };
}
