import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedProcessError, OwnedProcess, ProcessLiveness, ProcessHostShape } from "@acpus/owned-process";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { openProcessCapsule, type ProcessCapsuleOpenInput } from "../src/process-capsule.js";
import { createAgentSessionSupervisor } from "../src/session-supervisor.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type ProcessCapsuleTerminal,
} from "../src/worker-protocol.js";

type FakeChildMessage = AcpWorkerChildMessage extends infer Message
  ? Message extends AcpWorkerChildMessage
    ? Omit<Message, "protocolVersion" | "hostId" | "sessionLeaseId">
    : never
  : never;

describe("Process Capsule lifecycle", () => {
  it.live("runs semantic cleanup before the Process adapter fallback on Scope close", () =>
    withRoot(root => Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "dead" });
      const scope = yield* Scope.make("sequential");
      yield* Scope.provide(scope)(openProcessCapsule(openInput(root), fake.service));

      yield* Scope.close(scope, Exit.void);

      expect(fake.events).toEqual(["send:open", "semantic:close", "adapter:release"]);
      expect(yield* Effect.promise(() => readdir(join(root, "workers")))).toEqual([]);
    })));

  it.live("returns typed degraded evidence while still closing the owning Scope", () =>
    withRoot(root => Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "unverified" });
      const scope = yield* Scope.make("sequential");
      const capsule = yield* Scope.provide(scope)(openProcessCapsule(openInput(root), fake.service));

      const closed = yield* Effect.result(capsule.close("lease_settled"));

      expect(Result.isFailure(closed) && closed.failure).toMatchObject({
        type: "cleanup_unverified",
        evidence: { state: "unverified" },
      });
      expect(fake.events).toEqual(["send:open", "semantic:close", "adapter:release"]);
      const [manifestName] = yield* Effect.promise(() => readdir(join(root, "workers")));
      const manifest = JSON.parse(yield* Effect.promise(() => readFile(join(root, "workers", manifestName!), "utf8"))) as {
        state: { phase: string };
      };
      expect(manifest.state.phase).toBe("degraded");
    })));

  it.live("cleans a spawned worker when acquire aborts before readiness", () =>
    withRoot(root => Effect.gen(function*() {
      const fake = yield* fakeProcesses({ autoReady: false, closeLiveness: "dead" });
      const scope = yield* Scope.make("sequential");
      const controller = new AbortController();
      const opening = yield* Effect.forkChild(Effect.result(Scope.provide(scope)(
        openProcessCapsule(openInput(root, controller.signal), fake.service),
      )));

      yield* fake.spawned;
      controller.abort();
      const opened = yield* Fiber.join(opening);
      yield* Scope.close(scope, Exit.void);

      expect(Result.isFailure(opened) && opened.failure).toMatchObject({ type: "cancelled" });
      expect(fake.events).toEqual(["send:open", "semantic:close", "adapter:release"]);
      expect(yield* Effect.promise(() => readdir(join(root, "workers")))).toEqual([]);
    })));

  it.live("quarantines residual ownership when acquire abort cleanup is unverified", () =>
    withRoot(root => Effect.scoped(Effect.gen(function*() {
      const fake = yield* fakeProcesses({ autoReady: false, closeLiveness: "unverified" });
      const supervisor = yield* createAgentSessionSupervisor({
        workersRoot: join(root, "workers"),
        sessionStateDirectoryForRun: runId => join(root, "runs", runId),
        owner: { epoch: 1, pid: process.pid },
      }, fake.service);
      const controller = new AbortController();
      const opening = yield* Effect.forkChild(Effect.exit(supervisor.withSessionLease(
        leaseInput(root, controller.signal),
        () => Effect.void,
      )));

      yield* fake.spawned;
      controller.abort();
      yield* Fiber.join(opening);

      const reacquired = yield* Effect.result(supervisor.withSessionLease(
        leaseInput(root, new AbortController().signal),
        () => Effect.void,
      ));
      expect(Result.isFailure(reacquired) && reacquired.failure).toMatchObject({
        type: "acquire",
        error: {
          type: "session_quarantined",
          agentSessionId: "session",
          evidence: { state: "unverified" },
        },
      });
      expect(fake.events.filter(event => event === "send:open")).toHaveLength(1);
    }))));

  it.effect("keeps the first cancellation policy and sends cancel once", () =>
    Effect.scoped(withRoot(root => Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "dead" });
      const capsule = yield* openProcessCapsule(openInput(root), fake.service);
      expect((yield* fake.nextSent).type).toBe("open");
      const controller = new AbortController();
      const running = yield* Effect.forkChild(capsule.runTurn({
        turnId: "turn",
        prompt: "work",
        signal: controller.signal,
        inactivityFailAfterMs: 10,
        onEvent: () => Result.succeed(undefined),
      }));
      expect((yield* fake.nextSent).type).toBe("run");

      yield* TestClock.adjust(10);
      const cancel = yield* fake.nextSent;
      expect(cancel).toMatchObject({ type: "cancel", turnId: "turn", reason: "inactivity" });
      controller.abort();
      yield* Effect.yieldNow;
      expect(fake.sent.filter(message => message.type === "cancel")).toHaveLength(1);

      yield* fake.emit({ type: "terminal", turnId: "turn", terminal: cancelledTerminal() });
      const settlement = yield* Fiber.join(running);
      expect(settlement.policy).toMatchObject({ type: "inactivity", failAfterMs: 10 });
    }))));

  it.effect("rejects a concurrent second Turn without sending it", () =>
    Effect.scoped(withRoot(root => Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "dead" });
      const capsule = yield* openProcessCapsule(openInput(root), fake.service);
      yield* fake.nextSent;
      const first = yield* Effect.forkChild(capsule.runTurn(turnInput("first")));
      expect(yield* fake.nextSent).toMatchObject({ type: "run", turnId: "first" });

      const second = yield* capsule.runTurn(turnInput("second"));
      expect(second.finalResponse).toBe("");
      expect(second).not.toHaveProperty("terminal");
      expect(fake.sent.filter(message => message.type === "run")).toHaveLength(1);

      yield* fake.emit({ type: "terminal", turnId: "first", terminal: completedTerminal() });
      expect((yield* Fiber.join(first)).terminal).toEqual(completedTerminal());
    }))));

  it.effect("faults the capsule on wrong-Turn, duplicate-terminal, and post-terminal IPC", () =>
    Effect.forEach(["wrong-turn", "duplicate-terminal", "post-terminal"] as const, scenario =>
      Effect.scoped(withRoot(root => Effect.gen(function*() {
        const fake = yield* fakeProcesses({ closeLiveness: "dead" });
        const capsule = yield* openProcessCapsule(openInput(root), fake.service);
        yield* fake.nextSent;
        const running = yield* Effect.forkChild(capsule.runTurn(turnInput("turn")));
        yield* fake.nextSent;

        if (scenario === "wrong-turn") {
          yield* fake.emit({
            type: "event",
            turnId: "other",
            event: { type: "message", channel: "assistant", content: { type: "text", text: "wrong" } },
          });
          expect((yield* Fiber.join(running)).capsuleError).toMatchObject({ code: "ipc_protocol" });
          return;
        }

        const terminal = completedTerminal();
        yield* fake.emit({ type: "terminal", turnId: "turn", terminal });
        expect((yield* Fiber.join(running)).terminal).toEqual(terminal);
        yield* fake.emit(scenario === "duplicate-terminal"
          ? { type: "terminal", turnId: "turn", terminal }
          : {
              type: "event",
              turnId: "turn",
              event: { type: "message", channel: "assistant", content: { type: "text", text: "late" } },
            });
        yield* Effect.yieldNow;

        const afterFault = yield* capsule.runTurn(turnInput("next"));
        expect(afterFault.capsuleError).toMatchObject({ code: "ipc_protocol" });
        expect(fake.sent.filter(message => message.type === "run")).toHaveLength(1);
      }))),
    ).pipe(Effect.asVoid));

  it.live("preserves use and cleanup failures together", () =>
    withRoot(root => Effect.scoped(Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "unverified" });
      const supervisor = yield* createAgentSessionSupervisor(supervisorOptions(root), fake.service);

      const settled = yield* Effect.result(supervisor.withSessionLease(
        leaseInput(root, new AbortController().signal),
        () => Effect.fail("use failed"),
      ));

      expect(Result.isFailure(settled) && settled.failure).toMatchObject({
        type: "use_and_cleanup",
        use: "use failed",
        cleanup: { type: "cleanup_unverified" },
      });
    }))));

  it.live("does not commit until every Session is neutralized", () =>
    withRoot(root => Effect.scoped(Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "unverified" });
      const supervisor = yield* createAgentSessionSupervisor(supervisorOptions(root), fake.service);
      const entered = Deferred.makeUnsafe<void>();
      const leased = yield* Effect.forkChild(Effect.result(supervisor.withSessionLease(
        leaseInput(root, new AbortController().signal),
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )));
      yield* Deferred.await(entered);
      let commits = 0;

      const neutralized = yield* Effect.result(supervisor.withSessionsNeutralized({
        sessions: [{ runId: "run", agentSessionId: "session" }],
        signal: new AbortController().signal,
      }, () => {
        commits += 1;
        return Result.succeed("committed");
      }));

      expect(Result.isFailure(neutralized) && neutralized.failure).toMatchObject({ type: "neutralize" });
      expect(commits).toBe(0);
      yield* Fiber.join(leased);
    }))));

  it.live("neutralizes an active Session lease before committing", () =>
    withRoot(root => Effect.scoped(Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "dead" });
      const supervisor = yield* createAgentSessionSupervisor(supervisorOptions(root), fake.service);
      const leased = yield* Effect.forkChild(Effect.exit(supervisor.withSessionLease(
        leaseInput(root, new AbortController().signal),
        lease => lease.runTurn(turnInput("active")),
      )));
      expect((yield* fake.nextSent).type).toBe("open");
      expect(yield* fake.nextSent).toMatchObject({ type: "run", turnId: "active" });
      let commits = 0;

      const neutralized = yield* Effect.result(supervisor.withSessionsNeutralized({
        sessions: [{ runId: "run", agentSessionId: "session" }],
        signal: new AbortController().signal,
      }, evidence => {
        commits += 1;
        expect(evidence).toEqual([expect.objectContaining({
          session: { runId: "run", agentSessionId: "session" },
        })]);
        return Result.succeed("committed");
      }));

      expect(Result.isSuccess(neutralized) && neutralized.success).toBe("committed");
      expect(commits).toBe(1);
      expect(Exit.isFailure(yield* Fiber.join(leased))).toBe(true);
      expect(fake.events).toEqual(["send:open", "semantic:close", "adapter:release"]);
    }))));

  it.live("interrupts an active lease callback before shutdown returns", () =>
    withRoot(root => Effect.scoped(Effect.gen(function*() {
      const fake = yield* fakeProcesses({ closeLiveness: "dead" });
      const supervisor = yield* createAgentSessionSupervisor(supervisorOptions(root), fake.service);
      const entered = Deferred.makeUnsafe<void>();
      let interrupted = false;
      const leased = yield* Effect.forkChild(Effect.exit(supervisor.withSessionLease(
        leaseInput(root, new AbortController().signal),
        () => Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => {
            interrupted = true;
          })),
        ),
      )));
      yield* Deferred.await(entered);

      const shutdown = yield* Effect.result(supervisor.shutdown());

      expect(Result.isSuccess(shutdown)).toBe(true);
      expect(interrupted).toBe(true);
      expect(Exit.isFailure(yield* Fiber.join(leased))).toBe(true);
      expect(fake.events).toEqual(["send:open", "semantic:close", "adapter:release"]);
    }))));
});

function withRoot<A, E, R>(
  use: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "acpus-capsule-lifecycle-"))),
    root => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.orDie),
  ).pipe(Effect.flatMap(use));
}

function fakeProcesses(options: {
  autoReady?: boolean;
  closeLiveness: ProcessLiveness;
}): Effect.Effect<Readonly<{
  service: ProcessHostShape;
  spawned: Effect.Effect<OwnedProcess>;
  events: string[];
  sent: AcpWorkerParentMessage[];
  nextSent: Effect.Effect<AcpWorkerParentMessage>;
  emit(message: FakeChildMessage): Effect.Effect<void>;
}>> {
  return Effect.gen(function*() {
    const messages = yield* Queue.unbounded<unknown, OwnedProcessError | Cause.Done>();
    const outbound = yield* Queue.unbounded<AcpWorkerParentMessage>();
    const closed = Deferred.makeUnsafe<Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>, OwnedProcessError>();
    const spawned = Deferred.makeUnsafe<OwnedProcess>();
    const events: string[] = [];
    const sent: AcpWorkerParentMessage[] = [];
    let liveness: ProcessLiveness = "live";
    let identity: { hostId: string; sessionLeaseId: string } | undefined;

    const handle: OwnedProcess = {
      pid: 42,
      target: { pid: 42, processGroupId: 42 },
      stdout: Stream.empty,
      stderr: Stream.empty,
      messages: Stream.fromQueue(messages),
      closed: Deferred.await(closed),
      send: value => Effect.sync(() => {
        const message = value as AcpWorkerParentMessage;
        sent.push(message);
        Queue.offerUnsafe(outbound, message);
        if (message.type === "open") {
          events.push("send:open");
          identity = { hostId: message.input.hostId, sessionLeaseId: message.input.sessionLeaseId };
          if (options.autoReady !== false) {
            Queue.offerUnsafe(messages, {
              type: "ready",
              protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
              ...identity,
              projectionRef: "projection",
            });
          }
          return;
        }
        if (message.type !== "close") return;
        events.push("semantic:close");
        liveness = options.closeLiveness;
        if (identity !== undefined) {
          Queue.offerUnsafe(messages, {
            type: "closed",
            protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
            ...identity,
          });
        }
        Deferred.doneUnsafe(closed, Effect.succeed({ exitCode: 0, signal: null }));
        Queue.endUnsafe(messages);
      }),
      signal: () => Effect.void,
    };
    const service: ProcessHostShape = {
      spawn: () => Effect.acquireRelease(
        Effect.sync(() => {
          Deferred.doneUnsafe(spawned, Effect.succeed(handle));
          return handle;
        }),
        () => Effect.sync(() => {
          events.push("adapter:release");
        }),
      ),
      signal: () => Effect.void,
      liveness: () => Effect.sync(() => liveness),
      startToken: () => Effect.succeed("worker-start"),
      identityLiveness: () => Effect.succeed(
        liveness === "unverified" ? "unverified" : liveness === "dead" ? "absent" : "match",
      ),
    };
    return {
      service,
      spawned: Deferred.await(spawned),
      events,
      sent,
      nextSent: Queue.take(outbound),
      emit: (message: FakeChildMessage) => Effect.sync(() => {
        if (identity === undefined) throw new Error("fake capsule has not opened");
        Queue.offerUnsafe(messages, {
          ...message,
          protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
          ...identity,
        });
      }),
    };
  });
}

function turnInput(turnId: string) {
  return {
    turnId,
    prompt: "work",
    signal: new AbortController().signal,
    onEvent: () => Result.succeed(undefined),
  };
}

function completedTerminal(): ProcessCapsuleTerminal {
  return { type: "provider_result", result: { status: "completed", stopReason: "end_turn" } };
}

function cancelledTerminal(): ProcessCapsuleTerminal {
  return { type: "provider_result", result: { status: "cancelled", stopReason: "cancelled" } };
}

function supervisorOptions(root: string) {
  return {
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: (runId: string) => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  };
}

function openInput(root: string, signal = new AbortController().signal): ProcessCapsuleOpenInput {
  return {
    options: {
      workersRoot: join(root, "workers"),
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { epoch: 1, pid: process.pid },
    },
    owner: { epoch: 1, pid: process.pid },
    attempt: {
      runId: "run",
      nodeKey: "node",
      attemptId: "attempt",
      ownerEpoch: 1,
      signal,
    },
    session: {
      agentSessionId: "session",
      sessionOpenMode: "new_or_empty",
      agent: { kind: "command", command: "unused" },
      cwd: root,
      env: {},
      permissionMode: "deny-all",
      configuration: { options: {} },
    },
    sessionLeaseId: "lease",
    resolvedLaunch: { kind: "command", command: "unused" },
  };
}

function leaseInput(root: string, signal: AbortSignal) {
  const input = openInput(root, signal);
  return { attempt: input.attempt, session: input.session };
}
