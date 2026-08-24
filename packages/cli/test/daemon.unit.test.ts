import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { settle } from "./effect.js";

const mock = vi.hoisted(() => ({
  awaitRuntimeStoreOffline: vi.fn(),
  getRun: vi.fn(),
  inspectRuntimeStore: vi.fn(),
  probeDaemonEndpoint: vi.fn(),
  repairRuntimeStore: vi.fn(),
  requestDaemonControl: vi.fn(),
  requestDaemonStatusProbe: vi.fn(),
  requestDaemonSubmitAndObserve: vi.fn(),
  requestPredecessorDaemonShutdown: vi.fn(),
  spawn: vi.fn(),
  tryLoadRuntimeConfiguration: vi.fn(),
  unref: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("@acpus/runtime", () => ({
  awaitRuntimeStoreOffline: mock.awaitRuntimeStoreOffline,
  getRun: mock.getRun,
  inspectRuntimeStore: mock.inspectRuntimeStore,
  probeDaemonEndpoint: mock.probeDaemonEndpoint,
  repairRuntimeStore: mock.repairRuntimeStore,
  requestDaemonControl: mock.requestDaemonControl,
  requestDaemonStatusProbe: mock.requestDaemonStatusProbe,
  requestDaemonSubmitAndObserve: mock.requestDaemonSubmitAndObserve,
  requestPredecessorDaemonShutdown: mock.requestPredecessorDaemonShutdown,
  tryLoadRuntimeConfiguration: mock.tryLoadRuntimeConfiguration,
}));

import {
  ensureRuntimeAuthority,
  sendDaemonControl,
  sendDaemonSubmitAndObserve,
} from "../src/daemon/client.js";

const authorityA = authority("authority-a", 7);
const authorityB = authority("authority-b", 8);

describe("CLI Runtime authority client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: mock.unref }));
    mock.awaitRuntimeStoreOffline.mockReturnValue(Effect.succeed(undefined));
    mock.getRun.mockReturnValue(Effect.succeed(undefined));
    mock.inspectRuntimeStore.mockReturnValue(Effect.succeed({ state: "ready" }));
    mock.probeDaemonEndpoint.mockReturnValue(Effect.succeed(false));
    mock.repairRuntimeStore.mockReturnValue(Effect.succeed({ changed: false }));
    mock.requestPredecessorDaemonShutdown.mockReturnValue(Effect.succeed({ status: "shutdown" }));
    mock.tryLoadRuntimeConfiguration.mockReturnValue(Result.succeed({}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["admission", "control"] as const)(
    "reuses a matching authority for %s without a lifecycle probe",
    async mode => {
      mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));

      const ready = await settle(ensureRuntimeAuthority("/workspace", mode));

      expect(ready).toEqual(Result.succeed(authorityA));
      expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
      expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
      expect(mock.spawn).not.toHaveBeenCalled();
    },
  );

  it.effect("polls authority at 100ms without probing early", () => Effect.gen(function* () {
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityB)));

    const waiting = yield* Effect.forkChild(
      Effect.result(ensureRuntimeAuthority("/workspace", "admission")),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();

    yield* TestClock.adjust(99);
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(waiting.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(waiting)).toEqual(Result.succeed(authorityB));
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledTimes(2);
  }));

  it.effect("stops authority polling at the 30 second deadline", () => Effect.gen(function* () {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.fail({
      type: "rejected",
      code: "EXECUTION_UNAVAILABLE",
      message: "Daemon is initializing.",
    }));

    const waiting = yield* Effect.forkChild(
      Effect.result(ensureRuntimeAuthority("/workspace", "admission")),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust(29_999);
    expect(waiting.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(waiting)).toEqual(Result.fail({
      type: "daemon-start-timeout",
      message: "Runtime authority did not become ready within 30 seconds.",
    }));
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledTimes(300);
  }));

  it.effect("waits the 5 second grace after a detached daemon exits", () => Effect.gen(function* () {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.fail(transportFailure("not-found", "socket missing")));

    const waiting = yield* Effect.forkChild(
      Effect.result(ensureRuntimeAuthority("/workspace", "admission")),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    const child = mock.spawn.mock.results[0]!.value as EventEmitter;
    child.emit("exit", 2, null);

    yield* TestClock.adjust(4_999);
    expect(waiting.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust(1);
    const exit = yield* Fiber.join(waiting);
    expect(exit).toMatchObject({ failure: { type: "daemon-exited-before-ready", exitCode: 2 } });
    expect(mock.spawn).toHaveBeenCalledOnce();
  }));

  it.effect("stops probing and spawning when authority wait is aborted", () => Effect.gen(function* () {
    const controller = new AbortController();
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.fail({
      type: "rejected",
      code: "EXECUTION_UNAVAILABLE",
      message: "Daemon is initializing.",
    }));
    const waiting = yield* Effect.forkChild(
      Effect.result(ensureRuntimeAuthority("/workspace", "admission", { signal: controller.signal })),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();

    controller.abort();
    expect(yield* Fiber.join(waiting)).toEqual(Result.fail({
      type: "authority-wait-aborted",
      message: "Runtime authority wait was interrupted.",
    }));
    yield* TestClock.adjust(1_000);
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.spawn).not.toHaveBeenCalled();
  }));

  it("retires an idle v3 daemon before preparing the store and starting v4", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValueOnce(Effect.fail(transportFailure("not-found", "socket retired")))
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityB)));

    const ready = settle(ensureRuntimeAuthority("/workspace", "admission"));
    await vi.advanceTimersByTimeAsync(200);

    expect(await ready).toEqual(Result.succeed(authorityB));
    expect(mock.requestPredecessorDaemonShutdown).toHaveBeenCalledOnce();
    expect(mock.awaitRuntimeStoreOffline).toHaveBeenCalledWith("/workspace");
    expect(mock.inspectRuntimeStore).toHaveBeenCalledWith("/workspace");
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it("reports update blocked when an accepted v3 shutdown never releases its endpoint", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValue(Effect.fail(transportFailure("not-found", "v3 endpoint stopped answering status")));
    mock.probeDaemonEndpoint.mockReturnValue(Effect.succeed(true));

    const ready = settle(ensureRuntimeAuthority("/workspace", "admission"));
    await vi.advanceTimersByTimeAsync(30_100);

    expect(await ready).toMatchObject({
      failure: {
        type: "runtime-update-blocked",
        message: expect.stringContaining("did not release its endpoint"),
      },
    });
    expect(mock.requestPredecessorDaemonShutdown).toHaveBeenCalledOnce();
    expect(mock.awaitRuntimeStoreOffline).not.toHaveBeenCalled();
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("reports update blocked when the retired v3 store cannot reach the offline barrier", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValueOnce(Effect.fail(transportFailure("not-found", "socket retired")));
    mock.awaitRuntimeStoreOffline.mockReturnValueOnce(Effect.fail({
      type: "busy",
      message: "Timed out waiting for runtime users to release the shared lock.",
    }));

    const ready = settle(ensureRuntimeAuthority("/workspace", "admission"));
    await vi.advanceTimersByTimeAsync(100);

    expect(await ready).toMatchObject({
      failure: {
        type: "runtime-update-blocked",
        message: expect.stringContaining("has not released the store safely"),
      },
    });
    expect(mock.awaitRuntimeStoreOffline).toHaveBeenCalledWith("/workspace");
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("leaves an active v3 daemon untouched and reports update blocked", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed({
      kind: "predecessor",
      status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
    }));
    mock.requestPredecessorDaemonShutdown.mockReturnValue(Effect.fail(
      rejectedFailure("CONTROL_CONFLICT", "Runtime users are still active."),
    ));

    const ready = await settle(ensureRuntimeAuthority("/workspace", "admission"));

    expect(Result.isFailure(ready)).toBe(true);
    if (Result.isFailure(ready)) {
      expect(ready.failure).toMatchObject({ type: "runtime-update-blocked" });
      expect(ready.failure.message).toContain("active work");
    }
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("does not shut down or spawn around a future daemon", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed({ kind: "unknown", protocolVersion: 5 }));

    const ready = await settle(ensureRuntimeAuthority("/workspace", "admission"));

    expect(Result.isFailure(ready)).toBe(true);
    if (Result.isFailure(ready)) {
      expect(ready.failure).toMatchObject({ type: "runtime-update-blocked" });
      expect(ready.failure.message).toContain("protocol v5");
    }
    expect(mock.requestPredecessorDaemonShutdown).not.toHaveBeenCalled();
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("automatically repairs an offline older store for admission", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.fail(transportFailure("not-found", "socket missing")))
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityA)));
    mock.inspectRuntimeStore.mockReturnValueOnce(Effect.succeed({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValueOnce(Effect.succeed({ changed: true }));

    const ready = settle(ensureRuntimeAuthority("/workspace", "admission"));
    await vi.advanceTimersByTimeAsync(100);

    expect(await ready).toEqual(Result.succeed(authorityA));
    expect(mock.repairRuntimeStore).toHaveBeenCalledWith("/workspace");
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      repairFailure: { type: "unreadable", message: "Transition source identity changed." },
      expectedType: "runtime-store-unreadable",
      nextStep: "acpus doctor'",
    },
    {
      repairFailure: { type: "failed", message: "Published generation validation failed." },
      expectedType: "runtime-store-repair-failed",
      nextStep: "acpus doctor --fix",
    },
  ] as const)("maps a $repairFailure.type admission repair failure to $expectedType", async testCase => {
    mock.requestDaemonStatusProbe.mockReturnValueOnce(Effect.fail(transportFailure("not-found", "socket missing")));
    mock.inspectRuntimeStore.mockReturnValueOnce(Effect.succeed({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValueOnce(Effect.fail(testCase.repairFailure));

    const ready = await settle(ensureRuntimeAuthority("/workspace", "admission"));

    expect(Result.isFailure(ready)).toBe(true);
    if (Result.isFailure(ready)) {
      expect(ready.failure.type).toBe(testCase.expectedType);
      expect(ready.failure.message).toContain(testCase.nextStep);
    }
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("requires explicit Doctor repair for controls on an older store", async () => {
    mock.requestDaemonStatusProbe.mockReturnValueOnce(Effect.fail(transportFailure("not-found", "socket missing")));
    mock.inspectRuntimeStore.mockReturnValueOnce(Effect.succeed({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));

    const ready = await settle(ensureRuntimeAuthority("/workspace", "control"));

    expect(Result.isFailure(ready)).toBe(true);
    if (Result.isFailure(ready)) {
      expect(ready.failure).toMatchObject({ type: "runtime-store-repair-required" });
      expect(ready.failure.message).toContain("acpus doctor --fix");
    }
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("dispatches a control only after binding the current authority", async () => {
    const intent = { requestId: "cli:control", type: "pause", runId: "run_1" } as const;
    const applied = { type: "pause", state: "applied", run: runDetails() } as const;
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
    mock.requestDaemonControl.mockReturnValue(Effect.succeed(applied));

    const result = await settle(sendDaemonControl("/workspace", intent));

    expect(result).toEqual(Result.succeed(applied));
    expect(mock.requestDaemonControl).toHaveBeenCalledWith("/workspace", intent);
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
  });

  it("reuses one admission requestId after an authority mismatch", async () => {
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityA)))
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityB)));
    mock.requestDaemonSubmitAndObserve
      .mockReturnValueOnce(stream(Result.succeed({
        kind: "error",
        phase: "authority",
        outcome: "not-admitted",
        error: { code: "AUTHORITY_MISMATCH", message: "Authority changed." },
      })))
      .mockReturnValueOnce(stream(Result.succeed({ kind: "admitted", authority: authorityB, run: runDetails() })));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:stable-request",
      prepared: {} as never,
      input: {},
      until: "admitted",
    }));

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(Result.succeed({ kind: "admitted", authority: authorityB, run: runDetails() }));
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledTimes(2);
    expect(mock.requestDaemonSubmitAndObserve.mock.calls[0]![1]).toMatchObject({
      expectedAuthority: authorityA,
      requestId: "cli:stable-request",
    });
    expect(mock.requestDaemonSubmitAndObserve.mock.calls[1]![1]).toMatchObject({
      expectedAuthority: authorityB,
      requestId: "cli:stable-request",
    });
  });

  it("reuses one admission requestId after a pre-admission transport loss", async () => {
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityA)))
      .mockReturnValueOnce(Effect.succeed(currentProbe(authorityB)));
    mock.requestDaemonSubmitAndObserve
      .mockReturnValueOnce(stream(Result.fail({
        type: "transport",
        reason: "io",
        method: "submitAndObserve",
        outcome: "unknown",
        message: "Connection was lost before admission was reported.",
      })))
      .mockReturnValueOnce(stream(Result.succeed({ kind: "admitted", authority: authorityB, run: runDetails() })));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:stable-transport-request",
      prepared: {} as never,
      input: {},
      until: "admitted",
    }));

    expect(results).toEqual([Result.succeed({ kind: "admitted", authority: authorityB, run: runDetails() })]);
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledTimes(2);
    expect(mock.requestDaemonSubmitAndObserve.mock.calls.map(call => call[1].requestId)).toEqual([
      "cli:stable-transport-request",
      "cli:stable-transport-request",
    ]);
  });

  it.each(["malformed", "truncated"] as const)(
    "surfaces a pre-admission %s stream as a protocol failure without retrying",
    async reason => {
      mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
      mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(Result.fail({
        type: "protocol",
        stage: reason === "malformed" ? "frame" : "stream",
        reason,
        method: "submitAndObserve",
        outcome: "unknown",
        message: `Daemon stream ${reason}.`,
      })));

      const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
        requestId: "cli:protocol-failure",
        prepared: {} as never,
        input: {},
        until: "admitted",
      }));

      expect(results).toHaveLength(1);
      expect(Result.isFailure(results[0]!)).toBe(true);
      if (Result.isFailure(results[0]!)) {
        expect(results[0]!.failure).toMatchObject({
          type: "daemon-stream-protocol-failed",
          failure: { type: "protocol", reason },
          message: `Daemon stream ${reason}.`,
        });
      }
      expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
      expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
    },
  );

  it("surfaces a post-admission error frame with its daemon code and message", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      Result.succeed({ kind: "admitted", authority: authorityA, run: runDetails() }),
      Result.succeed({
        kind: "error",
        phase: "observation",
        outcome: "admitted",
        runId: "run_1",
        error: { code: "STORE_ERROR", message: "Observation connection failed." },
      }),
    ));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:observation-error",
      prepared: {} as never,
      input: {},
      until: "subject-terminal",
    }));

    expect(results).toHaveLength(2);
    expect(Result.isSuccess(results[0]!)).toBe(true);
    expect(results[1]).toEqual(Result.fail({
      type: "request-failed",
      method: "submitAndObserve",
      code: "STORE_ERROR",
      runId: "run_1",
      message: "Observation connection failed.",
    }));
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });

  it("keeps a malformed post-admission frame as a protocol failure", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      Result.succeed({ kind: "admitted", authority: authorityA, run: runDetails() }),
      Result.fail({
        type: "protocol",
        stage: "frame",
        reason: "malformed",
        method: "submitAndObserve",
        outcome: "admitted",
        runId: "run_1",
        message: "Daemon returned a malformed observation frame.",
      }),
    ));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:malformed-observation",
      prepared: {} as never,
      input: {},
      until: "subject-terminal",
    }));

    expect(results).toHaveLength(2);
    expect(Result.isSuccess(results[0]!)).toBe(true);
    expect(Result.isFailure(results[1]!)).toBe(true);
    if (Result.isFailure(results[1]!)) {
      expect(results[1]!.failure).toMatchObject({
        type: "daemon-stream-protocol-failed",
        failure: { reason: "malformed", outcome: "admitted", runId: "run_1" },
      });
    }
  });

  it("does not retry a non-mismatch authority error", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(Result.succeed({
      kind: "error",
      phase: "authority",
      outcome: "not-admitted",
      error: { code: "INVALID_REQUEST", message: "Invalid authority envelope." },
    })));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:invalid-authority",
      prepared: {} as never,
      input: {},
      until: "admitted",
    }));

    expect(results).toEqual([Result.fail({
      type: "request-failed",
      method: "submitAndObserve",
      code: "INVALID_REQUEST",
      message: "Invalid authority envelope.",
    })]);
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });

  it("classifies a stream ending after admission as authority lost", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(Effect.succeed(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      Result.succeed({ kind: "admitted", authority: authorityA, run: runDetails() }),
    ));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:admitted-request",
      prepared: {} as never,
      input: {},
      until: "subject-terminal",
    }));

    expect(results).toHaveLength(2);
    expect(Result.isSuccess(results[0]!)).toBe(true);
    expect(Result.isFailure(results[1]!)).toBe(true);
    if (Result.isFailure(results[1]!)) {
      expect(results[1]!.failure).toMatchObject({ type: "runtime-authority-lost", runId: "run_1" });
      expect(results[1]!.failure.message).toContain("acpus runs inspect run_1 --follow");
    }
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });
});

function authority(authorityId: string, leaseGeneration: number) {
  return {
    workspaceKey: "workspace-key",
    runtimeAbi: 5 as const,
    layoutVersion: 2 as const,
    storageVersion: 19 as const,
    authorityId,
    leaseGeneration,
  };
}

function currentProbe(identity: ReturnType<typeof authority>) {
  return {
    kind: "current" as const,
    status: {
      status: "ok" as const,
      pid: 42,
      leaseGeneration: identity.leaseGeneration,
      protocolVersion: 10 as const,
      packageVersion: "0.13.3",
      authority: identity,
    },
  };
}

function runDetails() {
  return {
    id: "run_1",
    name: "workflow",
    status: "pending" as const,
    workflowEntry: "workflow.ts",
    sourceGraphDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 0,
    execution: { state: "inactive" as const, lastStatus: "pending" as const },
  };
}

function transportFailure(reason: "not-found" | "refused", message: string) {
  return { type: "transport" as const, reason, method: "status" as const, message };
}

function rejectedFailure(code: "CONTROL_CONFLICT", message: string) {
  return { type: "rejected" as const, code, message };
}

function stream(...results: Array<Result.Result<unknown, unknown>>) {
  return Stream.fromIterable(results).pipe(Stream.mapEffect(result => Result.isFailure(result)
    ? Effect.fail(result.failure)
    : Effect.succeed(result.success)));
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
