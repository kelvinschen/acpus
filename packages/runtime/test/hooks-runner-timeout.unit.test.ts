import type {
  OwnedProcessError,
  ProcessExit,
  OwnedProcess,
  ProcessHostShape,
} from "@acpus/owned-process";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { LoadedHookConfig } from "../src/hooks/config.js";
import type { HookContext } from "../src/hooks/dispatch.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { createHookRunner } from "../src/hooks/runner.js";

describe("hook runner timeout arbitration", () => {
  it.effect("counts process acquisition time against the hook timeout", () => {
    const time = { nowMs: 0 };
    const fake = fakeProcesses(time, { spawnElapsedMs: 11, closeOnSignal: true });
    return Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([hook("10ms")], journal, fake.service, {
        now: () => new Date(0),
      });

      runner.trigger("run.completed", context());
      yield* fake.spawned;
      yield* runner.drain();

      expect(journal.entries).toEqual([expect.objectContaining({ status: "timed_out", error: "timeout" })]);
    }).pipe(Effect.provideService(Clock.Clock, fakeClock(time)));
  });

  it.effect.each(["close", "error"] as const)(
    "lets an expired deadline win when %s arrives before the sleep callback",
    event => {
      const time = { nowMs: 0 };
      const fake = fakeProcesses(time);
      return Effect.gen(function*() {
        const journal = journalWriter();
        const runner = yield* createHookRunner([hook("10ms")], journal, fake.service, {
          now: () => new Date(0),
        });

        runner.trigger("run.completed", context());
        yield* fake.spawned;
        time.nowMs = 11;
        if (event === "close") fake.close({ exitCode: 0, signal: null });
        else fake.fail(processFailure("lifecycle", "late failure"));
        yield* runner.drain();

        expect(journal.entries).toEqual([expect.objectContaining({ status: "timed_out", error: "timeout" })]);
      }).pipe(Effect.provideService(Clock.Clock, fakeClock(time)));
    },
  );

  it.effect("records a process acquisition failure as a terminal hook result", () => {
    const time = { nowMs: 0 };
    const fake = fakeProcesses(time, { spawnError: processFailure("spawn", "spawn failed") });
    return Effect.gen(function*() {
      const journal = journalWriter();
      const runner = yield* createHookRunner([hook("10ms")], journal, fake.service, {
        now: () => new Date(0),
      });

      runner.trigger("run.completed", context());
      yield* runner.drain();

      expect(journal.entries).toEqual([expect.objectContaining({ status: "failed", error: "spawn failed" })]);
    }).pipe(Effect.provideService(Clock.Clock, fakeClock(time)));
  });

  it.effect("escalates SIGTERM to SIGKILL only after the termination grace period", () => Effect.gen(function*() {
    const fake = fakeProcesses({ nowMs: 0 });
    const journal = journalWriter();
    const runner = yield* createHookRunner([hook("10ms")], journal, fake.service, {
      now: () => new Date(0),
    });

    runner.trigger("run.completed", context());
    yield* fake.spawned;
    const draining = yield* Effect.forkChild(runner.drain());
    yield* TestClock.adjust(10);
    expect(fake.signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust(1_999);
    expect(fake.signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust(1);
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    fake.close({ exitCode: null, signal: "SIGKILL" });
    yield* Fiber.join(draining);

    expect(journal.entries).toEqual([expect.objectContaining({ status: "timed_out", error: "timeout" })]);
  }));

  it.effect("settles admitted hooks when the owning Scope closes", () => {
    const time = { nowMs: 0 };
    const fake = fakeProcesses(time);
    return Effect.gen(function*() {
      const scope = yield* Scope.make();
      const runner = yield* Scope.provide(scope)(
        createHookRunner([hook("10ms")], journalWriter(), fake.service),
      );

      runner.trigger("run.completed", context());
      runner.trigger("run.completed", context());
      expect(runner.activeCount()).toBe(2);

      yield* Scope.close(scope, Exit.void);

      expect(runner.activeCount()).toBe(0);
      yield* runner.drain();
    }).pipe(Effect.provideService(Clock.Clock, fakeClock(time)));
  });
});

function fakeClock(time: { nowMs: number }): Clock.Clock {
  const millis = () => time.nowMs;
  const nanos = () => BigInt(time.nowMs) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: duration => Duration.toMillis(duration) <= 0 ? Effect.void : Effect.never,
  };
}

function fakeProcesses(
  time: { nowMs: number },
  options: { spawnElapsedMs?: number; spawnError?: OwnedProcessError; closeOnSignal?: boolean } = {},
): {
  service: ProcessHostShape;
  spawned: Effect.Effect<OwnedProcess>;
  signals: NodeJS.Signals[];
  close(exit: ProcessExit): void;
  fail(error: OwnedProcessError): void;
} {
  const closed = Deferred.makeUnsafe<ProcessExit, OwnedProcessError>();
  const spawned = Deferred.makeUnsafe<OwnedProcess>();
  const signals: NodeJS.Signals[] = [];
  const handle: OwnedProcess = {
    pid: 42,
    target: { pid: 42 },
    stdout: Stream.empty,
    stderr: Stream.empty,
    messages: Stream.empty,
    closed: Deferred.await(closed),
    send: () => Effect.void,
    signal: signal => Effect.sync(() => {
      signals.push(signal);
      if (options.closeOnSignal) {
        Deferred.doneUnsafe(closed, Effect.succeed({ exitCode: null, signal }));
      }
    }),
  };
  const service: ProcessHostShape = {
    spawn: () => Effect.suspend(() => {
      time.nowMs += options.spawnElapsedMs ?? 0;
      if (options.spawnError !== undefined) return Effect.fail(options.spawnError);
      Deferred.doneUnsafe(spawned, Effect.succeed(handle));
      return Effect.succeed(handle);
    }),
    signal: () => Effect.void,
    liveness: () => Effect.succeed("live"),
    startToken: () => Effect.succeed(undefined),
    identityLiveness: () => Effect.succeed("unverified"),
  };
  return {
    service,
    spawned: Deferred.await(spawned),
    signals,
    close: exit => {
      Deferred.doneUnsafe(closed, Effect.succeed(exit));
    },
    fail: error => {
      Deferred.doneUnsafe(closed, Effect.fail(error));
    },
  };
}

function processFailure(operation: OwnedProcessError["operation"], message: string): OwnedProcessError {
  return { type: "process", operation, message, cause: new Error(message) };
}

function hook(timeout: string): LoadedHookConfig {
  return {
    event: "run.completed",
    command: "hook-command",
    source: "project",
    sourcePath: "/workspace/.acpus/config.json",
    definitionIndex: 0,
    effectiveId: "hook",
    id: "hook",
    timeout,
  };
}

function context(): HookContext {
  return {
    event: "run.completed",
    eventSequence: 42,
    run: {
      id: "run_1",
      workflowName: "release",
      workflowPath: "/workspace/workflow.ts",
      workspaceDir: "/workspace",
      status: "completed",
    },
  };
}

function journalWriter(): { entries: HookJournalEntry[]; writeHookJournal(entry: HookJournalEntry): void } {
  return {
    entries: [],
    writeHookJournal(entry) {
      this.entries.push(entry);
    },
  };
}
