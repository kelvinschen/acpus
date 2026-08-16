import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, errAsync, ok, okAsync } from "neverthrow";

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

const authorityA = authority("authority-a", 7, "a");
const authorityB = authority("authority-b", 8, "b");

describe("CLI Runtime authority client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: mock.unref }));
    mock.awaitRuntimeStoreOffline.mockReturnValue(okAsync(undefined));
    mock.getRun.mockReturnValue(okAsync(undefined));
    mock.inspectRuntimeStore.mockReturnValue(okAsync({ state: "ready" }));
    mock.probeDaemonEndpoint.mockResolvedValue(false);
    mock.repairRuntimeStore.mockReturnValue(okAsync({ changed: false }));
    mock.requestPredecessorDaemonShutdown.mockReturnValue(okAsync({ status: "shutdown" }));
    mock.tryLoadRuntimeConfiguration.mockReturnValue(ok({}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["admission", "control"] as const)(
    "reuses a matching authority for %s without a lifecycle probe",
    async mode => {
      mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));

      const ready = await ensureRuntimeAuthority("/workspace", mode);

      expect(ready).toEqual(ok(authorityA));
      expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
      expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
      expect(mock.spawn).not.toHaveBeenCalled();
    },
  );

  it("retires an idle v3 daemon before preparing the store and starting v4", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(okAsync({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "socket retired")))
      .mockReturnValueOnce(okAsync(currentProbe(authorityB)));

    const ready = ensureRuntimeAuthority("/workspace", "admission");
    await vi.advanceTimersByTimeAsync(200);

    expect(await ready).toEqual(ok(authorityB));
    expect(mock.requestPredecessorDaemonShutdown).toHaveBeenCalledOnce();
    expect(mock.awaitRuntimeStoreOffline).toHaveBeenCalledWith("/workspace");
    expect(mock.inspectRuntimeStore).toHaveBeenCalledWith("/workspace");
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledOnce();
  });

  it("reports update blocked when an accepted v3 shutdown never releases its endpoint", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(okAsync({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValue(errAsync(transportFailure("not-found", "v3 endpoint stopped answering status")));
    mock.probeDaemonEndpoint.mockResolvedValue(true);

    const ready = ensureRuntimeAuthority("/workspace", "admission");
    await vi.advanceTimersByTimeAsync(30_100);

    expect(await ready).toMatchObject({
      error: {
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
      .mockReturnValueOnce(okAsync({
        kind: "predecessor",
        status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
      }))
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "socket retired")));
    mock.awaitRuntimeStoreOffline.mockReturnValueOnce(errAsync({
      type: "busy",
      message: "Timed out waiting for runtime users to release the shared lock.",
    }));

    const ready = ensureRuntimeAuthority("/workspace", "admission");
    await vi.advanceTimersByTimeAsync(100);

    expect(await ready).toMatchObject({
      error: {
        type: "runtime-update-blocked",
        message: expect.stringContaining("has not released the store safely"),
      },
    });
    expect(mock.awaitRuntimeStoreOffline).toHaveBeenCalledWith("/workspace");
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("leaves an active v3 daemon untouched and reports update blocked", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync({
      kind: "predecessor",
      status: { status: "ok", pid: 41, generation: 6, protocolVersion: 3, packageVersion: "0.13.3" },
    }));
    mock.requestPredecessorDaemonShutdown.mockReturnValue(errAsync(
      rejectedFailure("CONTROL_CONFLICT", "Runtime users are still active."),
    ));

    const ready = await ensureRuntimeAuthority("/workspace", "admission");

    expect(ready.isErr()).toBe(true);
    if (ready.isErr()) {
      expect(ready.error).toMatchObject({ type: "runtime-update-blocked" });
      expect(ready.error.message).toContain("active work");
    }
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("does not shut down or spawn around a future daemon", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync({ kind: "unknown", protocolVersion: 5 }));

    const ready = await ensureRuntimeAuthority("/workspace", "admission");

    expect(ready.isErr()).toBe(true);
    if (ready.isErr()) {
      expect(ready.error).toMatchObject({ type: "runtime-update-blocked" });
      expect(ready.error.message).toContain("protocol v5");
    }
    expect(mock.requestPredecessorDaemonShutdown).not.toHaveBeenCalled();
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("automatically repairs an offline older store for admission", async () => {
    vi.useFakeTimers();
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")))
      .mockReturnValueOnce(okAsync(currentProbe(authorityA)));
    mock.inspectRuntimeStore.mockReturnValueOnce(okAsync({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValueOnce(okAsync({ changed: true }));

    const ready = ensureRuntimeAuthority("/workspace", "admission");
    await vi.advanceTimersByTimeAsync(100);

    expect(await ready).toEqual(ok(authorityA));
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
    mock.requestDaemonStatusProbe.mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")));
    mock.inspectRuntimeStore.mockReturnValueOnce(okAsync({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));
    mock.repairRuntimeStore.mockReturnValueOnce(errAsync(testCase.repairFailure));

    const ready = await ensureRuntimeAuthority("/workspace", "admission");

    expect(ready.isErr()).toBe(true);
    if (ready.isErr()) {
      expect(ready.error.type).toBe(testCase.expectedType);
      expect(ready.error.message).toContain(testCase.nextStep);
    }
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("requires explicit Doctor repair for controls on an older store", async () => {
    mock.requestDaemonStatusProbe.mockReturnValueOnce(errAsync(transportFailure("not-found", "socket missing")));
    mock.inspectRuntimeStore.mockReturnValueOnce(okAsync({
      state: "repairable",
      message: "Runtime store repair is required.",
    }));

    const ready = await ensureRuntimeAuthority("/workspace", "control");

    expect(ready.isErr()).toBe(true);
    if (ready.isErr()) {
      expect(ready.error).toMatchObject({ type: "runtime-store-repair-required" });
      expect(ready.error.message).toContain("acpus doctor --fix");
    }
    expect(mock.repairRuntimeStore).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it("dispatches a control only after binding the current authority", async () => {
    const intent = { requestId: "cli:control", type: "pause", runId: "run_1" } as const;
    const applied = { type: "pause", state: "applied", run: runDetails() } as const;
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
    mock.requestDaemonControl.mockReturnValue(okAsync(applied));

    const result = await sendDaemonControl("/workspace", intent);

    expect(result).toEqual(ok(applied));
    expect(mock.requestDaemonControl).toHaveBeenCalledWith("/workspace", intent);
    expect(mock.inspectRuntimeStore).not.toHaveBeenCalled();
  });

  it("reuses one admission requestId after an authority mismatch", async () => {
    mock.requestDaemonStatusProbe
      .mockReturnValueOnce(okAsync(currentProbe(authorityA)))
      .mockReturnValueOnce(okAsync(currentProbe(authorityB)));
    mock.requestDaemonSubmitAndObserve
      .mockReturnValueOnce(stream(ok({
        kind: "error",
        phase: "authority",
        outcome: "not-admitted",
        error: { code: "AUTHORITY_MISMATCH", message: "Authority changed." },
      })))
      .mockReturnValueOnce(stream(ok({ kind: "admitted", authority: authorityB, run: runDetails() })));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:stable-request",
      prepared: {} as never,
      input: {},
      until: "admitted",
    }));

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(ok({ kind: "admitted", authority: authorityB, run: runDetails() }));
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
      .mockReturnValueOnce(okAsync(currentProbe(authorityA)))
      .mockReturnValueOnce(okAsync(currentProbe(authorityB)));
    mock.requestDaemonSubmitAndObserve
      .mockReturnValueOnce(stream(err({
        type: "transport",
        reason: "io",
        method: "submitAndObserve",
        outcome: "unknown",
        message: "Connection was lost before admission was reported.",
      })))
      .mockReturnValueOnce(stream(ok({ kind: "admitted", authority: authorityB, run: runDetails() })));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:stable-transport-request",
      prepared: {} as never,
      input: {},
      until: "admitted",
    }));

    expect(results).toEqual([ok({ kind: "admitted", authority: authorityB, run: runDetails() })]);
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledTimes(2);
    expect(mock.requestDaemonSubmitAndObserve.mock.calls.map(call => call[1].requestId)).toEqual([
      "cli:stable-transport-request",
      "cli:stable-transport-request",
    ]);
  });

  it.each(["malformed", "truncated"] as const)(
    "surfaces a pre-admission %s stream as a protocol failure without retrying",
    async reason => {
      mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
      mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(err({
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
      expect(results[0]?.isErr()).toBe(true);
      if (results[0]?.isErr()) {
        expect(results[0].error).toMatchObject({
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
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      ok({ kind: "admitted", authority: authorityA, run: runDetails() }),
      ok({
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
    expect(results[0]?.isOk()).toBe(true);
    expect(results[1]).toEqual(err({
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
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      ok({ kind: "admitted", authority: authorityA, run: runDetails() }),
      err({
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
    expect(results[0]?.isOk()).toBe(true);
    expect(results[1]?.isErr()).toBe(true);
    if (results[1]?.isErr()) {
      expect(results[1].error).toMatchObject({
        type: "daemon-stream-protocol-failed",
        failure: { reason: "malformed", outcome: "admitted", runId: "run_1" },
      });
    }
  });

  it("does not retry a non-mismatch authority error", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(ok({
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

    expect(results).toEqual([err({
      type: "request-failed",
      method: "submitAndObserve",
      code: "INVALID_REQUEST",
      message: "Invalid authority envelope.",
    })]);
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });

  it("classifies a stream ending after admission as authority lost", async () => {
    mock.requestDaemonStatusProbe.mockReturnValue(okAsync(currentProbe(authorityA)));
    mock.requestDaemonSubmitAndObserve.mockReturnValue(stream(
      ok({ kind: "admitted", authority: authorityA, run: runDetails() }),
    ));

    const results = await collect(sendDaemonSubmitAndObserve("/workspace", {
      requestId: "cli:admitted-request",
      prepared: {} as never,
      input: {},
      until: "subject-terminal",
    }));

    expect(results).toHaveLength(2);
    expect(results[0]?.isOk()).toBe(true);
    expect(results[1]?.isErr()).toBe(true);
    if (results[1]?.isErr()) {
      expect(results[1].error).toMatchObject({ type: "runtime-authority-lost", runId: "run_1" });
      expect(results[1].error.message).toContain("acpus runs inspect run_1 --follow");
    }
    expect(mock.requestDaemonStatusProbe).toHaveBeenCalledOnce();
    expect(mock.requestDaemonSubmitAndObserve).toHaveBeenCalledOnce();
  });
});

function authority(authorityId: string, leaseGeneration: number, digestChar: string) {
  return {
    workspaceKey: "workspace-key",
    runtimeAbi: 1 as const,
    layoutVersion: 2 as const,
    storageVersion: 10 as const,
    authorityId,
    storeBinding: `sha256:${digestChar.repeat(64)}` as const,
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
      protocolVersion: 4 as const,
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

function stream(...results: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* results;
  })();
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
