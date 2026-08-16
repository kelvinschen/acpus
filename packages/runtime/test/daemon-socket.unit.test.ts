import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedRunWorkflow, Sha256Digest } from "@acpus/runtime";
import {
  daemonEndpoint,
  requestDaemonControl,
  requestDaemonShutdown,
  requestDaemonStatus,
  requestDaemonStatusProbe,
  requestDaemonSubmitAndObserve,
} from "../src/daemon/client.js";
import { sameRuntimeAuthority } from "../src/daemon/authority.js";
import {
  isDaemonRunStreamFrame,
  type DaemonRunStreamFrame,
  type RuntimeAuthorityIdentity,
} from "../src/daemon/protocol.js";
import { startDaemonServer } from "../src/daemon/server.js";
import { ensureRuntimeLayout, resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import {
  openRuntimeStore,
  type RunDetails,
} from "../src/store/store.js";
import { err, ok, ResultAsync } from "neverthrow";

const runtimeHomeCleanups: Array<() => Promise<void>> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(runtimeHomeCleanups.splice(0).map(cleanup => cleanup()));
});

describe("daemon socket server", () => {
  it("accepts bounded tool titles in inspection pulse frames", () => {
    expect(isDaemonRunStreamFrame({
      kind: "observation",
      observation: {
        kind: "closed",
        reason: "subject-terminal",
        view: {
          ...runInspectionView(),
          tree: [{
            type: "item",
            subject: { label: "Research", kind: "agent" },
            state: { status: "completed" },
            pulse: {
              phase: "tool",
              tool: {
                name: "Search",
                title: "Search something useful",
                state: "completed",
              },
            },
            children: [],
          }],
        },
      },
    })).toBe(true);
  });

  it.skipIf(process.platform === "win32")("binds a private Unix socket inside a private directory", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-mode-");
    const endpoint = daemonEndpoint(workspace);
    const server = await startDaemonServer(workspace, testHandlers());
    try {
      const [parent, socket] = await Promise.all([
        lstat(dirname(endpoint)),
        lstat(endpoint),
      ]);
      expect(parent.isDirectory()).toBe(true);
      expect(parent.mode & 0o777).toBe(0o700);
      expect(socket.isSocket()).toBe(true);
      expect(socket.mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic link at the Unix socket path", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-symlink-");
    const layout = await ensureRuntimeLayout(workspace);
    if (layout.isErr()) throw new Error(layout.error.message);
    const target = join(layout.value.workspaceRoot, "socket-target");
    await writeFile(target, "preserve");
    await symlink(target, layout.value.daemonEndpoint);
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toBeInstanceOf(Error);
      await expect(readFile(target, "utf8")).resolves.toBe("preserve");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link Unix socket parent", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-parent-symlink-");
    const layout = resolveRuntimeLayout(workspace);
    const redirected = join(layout.home, "redirected-workspace");
    await Promise.all([
      mkdir(dirname(layout.workspaceRoot), { recursive: true }),
      mkdir(redirected),
    ]);
    await symlink(redirected, layout.workspaceRoot, "dir");
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toBeInstanceOf(Error);
      await expect(readdir(redirected)).resolves.toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("tracks a connection while its request handler is active", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-");
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    const server = await startDaemonServer(workspace, {
      status: () => ok(daemonStatus()),
      submitAndObserve: testHandlers().submitAndObserve,
      control: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
      shutdown: () => new ResultAsync((async () => {
        shutdownStarted.resolve();
        await releaseShutdown.promise;
        return ok({ status: "shutdown" as const });
      })()),
    });
    let request: ReturnType<typeof requestDaemonShutdown> | undefined;
    try {
      request = requestDaemonShutdown(workspace);
      await shutdownStarted.promise;
      expect(server.activeConnections()).toBe(1);
      releaseShutdown.resolve();
      expect(await request).toEqual(ok({ status: "shutdown" }));
      await waitUntil(() => server.activeConnections() === 0);
      expect(server.activeConnections()).toBe(0);
    } finally {
      releaseShutdown.resolve();
      if (request) await request;
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not abandon an admission while the daemon still owns its outcome", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-admission-wait-");
    const started = deferred();
    const release = deferred();
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      submitAndObserve: async function* () {
        started.resolve();
        await release.promise;
        yield { kind: "admitted", authority: runtimeAuthority(), run: runDetails() };
      },
    });
    vi.useFakeTimers();
    const request = collectStream(requestDaemonSubmitAndObserve(workspace, {
      expectedAuthority: runtimeAuthority(),
      requestId: "admission-wait",
      prepared: preparedRunWorkflow(),
      input: {},
      until: "admitted",
    }));
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(31_000);
      release.resolve();
      expect(await request).toEqual([ok({ kind: "admitted", authority: runtimeAuthority(), run: runDetails() })]);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await request;
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("tracks sockets while a request is still uploading", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-upload-");
    const server = await startDaemonServer(workspace, testHandlers());
    const socket = connect(daemonEndpoint(workspace));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      await waitUntil(() => server.activeConnections() === 1);
      socket.resume();
      socket.end(JSON.stringify({ method: "status" }));
      await new Promise<void>((resolve, reject) => {
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
      expect(server.activeConnections()).toBe(0);
    } finally {
      socket.destroy();
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the status readiness error code", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-readiness-");
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      status: () => err({ code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }),
    });
    try {
      expect(await requestDaemonStatus(workspace)).toEqual(err({ type: "rejected", code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }));
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sanitizes unknown handler failures as internal errors", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-internal-");
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      control: () => {
        throw new Error("private scheduler invariant");
      },
    });
    try {
      expect(await requestDaemonControl(workspace, { requestId: "cancel", type: "cancel", runId: "run_1" })).toEqual(err({
        type: "rejected",
        code: "INTERNAL_ERROR",
        message: "Control 'cancel' could not be applied to run 'run_1'.",
      }));
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("classifies an ENOTDIR socket path as not found", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-enotdir-");
    try {
      const layout = resolveRuntimeLayout(workspace);
      await mkdir(dirname(layout.workspaceRoot), { recursive: true });
      await writeFile(layout.workspaceRoot, "not a directory");
      expect(await requestDaemonStatus(workspace)).toEqual(err({
        type: "transport",
        reason: "not-found",
        method: "status",
        errno: "ENOTDIR",
        message: expect.any(String),
      }));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a live pre-lease socket bound when another server starts", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-prelease-live-");
    const first = await startDaemonServer(workspace, {
      ...testHandlers(),
      status: () => err({ code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }),
    });
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(await requestDaemonStatus(workspace)).toEqual(err({ type: "rejected", code: "EXECUTION_UNAVAILABLE", message: "Daemon is still initializing." }));
    } finally {
      await first.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("releases its connection after detecting an occupied endpoint", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-connected-probe-");
    const endpoint = daemonEndpoint(workspace);
    await mkdir(dirname(endpoint), { recursive: true });
    let acceptedSocket: Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, socket => {
      acceptedSocket = socket;
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const clientModule = pathToFileURL(join(import.meta.dirname, "../src/daemon/client.ts")).href;
      const layoutModule = pathToFileURL(join(import.meta.dirname, "../src/runtime-layout.ts")).href;
      const script = `
        import { probeDaemonEndpoint } from ${JSON.stringify(clientModule)};
        import { setRuntimeHomeForTest } from ${JSON.stringify(layoutModule)};
        const restore = setRuntimeHomeForTest(process.argv[1], process.argv[2]);
        try {
          process.stdout.write(String(await probeDaemonEndpoint(process.argv[1])));
        } finally {
          restore();
        }
      `;
      const result = await execFileAsync(process.execPath, [
        "--conditions=development",
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        script,
        workspace,
        resolveRuntimeLayout(workspace).home,
      ], { timeout: 2_000 });
      expect(result.stdout).toBe("true");
    } finally {
      acceptedSocket?.destroy();
      await closeRawResponseServer(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("ignores an abandoned lock while recovering a stale socket", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-stale-lock-");
    const endpoint = daemonEndpoint(workspace);
    await mkdir(dirname(endpoint), { recursive: true });
    await Promise.all([
      writeFile(endpoint, "stale socket evidence"),
      writeFile(`${endpoint}.lock`, "abandoned arbitration"),
    ]);
    let server: Awaited<ReturnType<typeof startDaemonServer>> | undefined;
    try {
      server = await startDaemonServer(workspace, testHandlers());
      await expect(requestDaemonStatus(workspace)).resolves.toEqual(ok(daemonStatus()));
    } finally {
      await server?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("serializes competing stale socket recovery", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-stale-race-");
    const endpoint = daemonEndpoint(workspace);
    await mkdir(dirname(endpoint), { recursive: true });
    await writeFile(endpoint, "stale socket evidence");

    const starts = await Promise.allSettled([
      startDaemonServer(workspace, testHandlers()),
      startDaemonServer(workspace, testHandlers()),
    ]);
    const servers = starts.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    try {
      expect(servers).toHaveLength(1);
      const failures = starts.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: "EADDRINUSE" });
      await expect(requestDaemonStatus(workspace)).resolves.toEqual(ok(daemonStatus()));
    } finally {
      await Promise.allSettled(servers.map(server => server.close()));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps an occupied socket when pid liveness is unknown", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-unknown-pid-");
    const endpoint = daemonEndpoint(workspace);
    const store = await openRuntimeStore(workspace);
    const authority = store.claimRuntimeAuthority({
      workspaceRealpath: workspace,
      ownerId: "unknown-pid-owner",
      pid: 123,
      protocolVersion: 1,
      packageVersion: "test",
      nodeVersion: process.version,
      execPath: process.execPath,
      idleStopMs: 30_000,
    })._unsafeUnwrap();
    store.close();
    await mkdir(dirname(endpoint), { recursive: true });
    await writeFile(endpoint, "occupied");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(authority.heartbeatAt));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });
    try {
      await expect(startDaemonServer(workspace, testHandlers())).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(readFile(endpoint, "utf8")).resolves.toBe("occupied");
    } finally {
      kill.mockRestore();
      now.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only closed current request shapes", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-protocol-");
    const server = await startDaemonServer(workspace, testHandlers());
    try {
      const invalidRequests = [
        { method: "status", extra: true },
        { method: "unsupported" },
        { method: "control", control: { requestId: "pause", type: "pause", runId: "run_1", target: "node" } },
        { method: "control", control: { requestId: "fork", type: "fork", runId: "run_1", target: "" } },
        { method: "control", control: { requestId: "steer", type: "steer", runId: "run_1", target: "review", instruction: "   " } },
        { method: "control", control: { requestId: "", type: "steer", runId: "run_1", target: "review", instruction: "focus" } },
        { method: "control", control: { requestId: "steer", type: "steer", runId: "run_1", target: "", instruction: "focus" } },
        { method: "control", control: { requestId: "steer", type: "steer", runId: "run_1", target: "   ", instruction: "focus" } },
        { method: "control", control: { requestId: "steer", type: "steer", runId: "run_1", target: "review", instruction: "focus", extra: true } },
      ];
      for (const request of invalidRequests) {
        await expect(sendRawRequest(daemonEndpoint(workspace), request)).resolves.toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      const validSubmission = { method: "submitAndObserve", ...submitInput("admitted") };
      const invalidSubmissions = [
        { ...validSubmission, extra: true },
        { ...validSubmission, requestId: "" },
        { ...validSubmission, until: "terminal" },
        { ...validSubmission, expectedAuthority: { ...runtimeAuthority(), workspaceKey: "workspace-test" } },
        { ...validSubmission, expectedAuthority: { ...runtimeAuthority(), authorityId: "authority-test" } },
        { ...validSubmission, expectedAuthority: { ...runtimeAuthority(), storeBinding: "sha256:not-a-digest" } },
        { ...validSubmission, prepared: { ...preparedRunWorkflow(), extra: true } },
      ];
      for (const request of invalidSubmissions) {
        await expect(sendRawRequest(daemonEndpoint(workspace), request)).resolves.toMatchObject({
          kind: "error",
          phase: "admission",
          outcome: "not-admitted",
          error: { code: "INVALID_REQUEST" },
        });
      }

      const response = await sendRawRequest(daemonEndpoint(workspace), { method: "status" });
      expect(response).toEqual({
        ok: true,
        result: daemonStatus(),
      });
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes every syntactically valid authority mismatch to pre-admission comparison", async () => {
    const workspace = await testWorkspace("acpus-daemon-authority-mismatch-");
    const current = runtimeAuthority();
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      submitAndObserve: async function* (request) {
        if (!sameRuntimeAuthority(request.expectedAuthority, current)) {
          yield {
            kind: "error",
            phase: "authority",
            outcome: "not-admitted",
            error: { code: "AUTHORITY_MISMATCH", message: "authority changed" },
          };
          return;
        }
        yield admittedFrame();
      },
    });
    const mismatches = [
      { ...current, workspaceKey: "c".repeat(32) },
      { ...current, runtimeAbi: 2 },
      { ...current, layoutVersion: 3 },
      { ...current, storageVersion: 11 },
      { ...current, authorityId: "00000000-0000-4000-8000-000000000002" },
      { ...current, storeBinding: `sha256:${"c".repeat(64)}` },
      { ...current, leaseGeneration: 2 },
    ];
    try {
      for (const expectedAuthority of mismatches) {
        const frames = await collectStream(requestDaemonSubmitAndObserve(workspace, {
          ...submitInput("admitted"),
          expectedAuthority: expectedAuthority as RuntimeAuthorityIdentity,
        }));
        expect(frames).toEqual([ok({
          kind: "error",
          phase: "authority",
          outcome: "not-admitted",
          error: { code: "AUTHORITY_MISMATCH", message: "authority changed" },
        })]);
      }
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a response outside the closed envelope", async () => {
    const workspace = await testWorkspace("acpus-daemon-socket-response-");
    const server = await startRawResponseServer(workspace, {
      ok: true,
      result: { status: "shutdown" },
      extra: true,
    });
    try {
      expect(await requestDaemonShutdown(workspace)).toEqual(err({ type: "protocol", stage: "envelope", method: "shutdown", message: "Daemon returned an invalid response." }));
    } finally {
      await closeRawResponseServer(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only closed result shapes", async () => {
    const shutdownWorkspace = await testWorkspace("acpus-daemon-socket-shutdown-result-");
    const shutdownServer = await startRawResponseServer(shutdownWorkspace, {
      ok: true,
      result: { status: "shutdown", extra: true },
    });
    try {
      expect(await requestDaemonShutdown(shutdownWorkspace)).toEqual(err({ type: "protocol", stage: "result", method: "shutdown", message: "Daemon returned an invalid shutdown result." }));
    } finally {
      await closeRawResponseServer(shutdownServer);
      await rm(shutdownWorkspace, { recursive: true, force: true });
    }

    const run = runDetails();
    const invalidControlResults = [
      { type: "pause", state: "applied", run: { id: "run_1", status: "running" } },
      { type: "pause", state: "applied", run: { ...run, status: "unknown" } },
      { type: "pause", state: "applied", run: { ...run, execution: { state: "active", lastStatus: "unknown" } } },
      { type: "pause", state: "applied", run, extra: true },
      { type: "steer", state: "applied", run, steerId: "steer-1", requestedTarget: "review", target: "review~1", fencedAttemptId: "attempt-1", continuation: "queued", instruction: "must not leak" },
      { type: "steer", state: "applied", run, steerId: "steer-1", requestedTarget: "review", target: "review~1", fencedAttemptId: "attempt-1", continuation: "started" },
      { type: "fork", state: "applied", sourceRunId: "run_source", run, unexpected: true },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "raw-string", extra: true },
        run,
      },
    ];
    for (const result of invalidControlResults) {
      const controlWorkspace = await testWorkspace("acpus-daemon-socket-control-result-");
      const controlServer = await startRawResponseServer(controlWorkspace, { ok: true, result });
      try {
        expect((await requestDaemonControl(controlWorkspace, controlIntent(result.type))).isErr()).toBe(true);
      } finally {
        await closeRawResponseServer(controlServer);
        await rm(controlWorkspace, { recursive: true, force: true });
      }
    }

    const mismatchedWorkspace = await testWorkspace("acpus-daemon-socket-control-mismatch-");
    const mismatchedServer = await startRawResponseServer(mismatchedWorkspace, {
      ok: true,
      result: { type: "resume", state: "applied", run },
    });
    try {
      expect(await requestDaemonControl(mismatchedWorkspace, { requestId: "pause", type: "pause", runId: "run_1" })).toEqual(err({
        type: "protocol",
        stage: "result",
        method: "control",
        message: "Daemon returned an invalid pause control for run 'run_1' result.",
      }));
    } finally {
      await closeRawResponseServer(mismatchedServer);
      await rm(mismatchedWorkspace, { recursive: true, force: true });
    }

    const validControlResults = [
      { type: "pause", state: "applied", run },
      { type: "resume", state: "applied", run },
      { type: "retry", state: "applied", run },
      { type: "retry", state: "applied", target: "root", run },
      { type: "cancel", state: "applied", target: "root", run },
      {
        type: "steer",
        state: "applied",
        run,
        steerId: "steer-1",
        requestedTarget: "review",
        target: "review~123456789abc",
        fencedAttemptId: "attempt-1",
        continuation: "queued",
      },
      { type: "fork", state: "applied", sourceRunId: "run_source", run },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "schema", schemaSummary: "{ ok: boolean }" },
        run,
      },
      {
        type: "signal",
        state: "consumed",
        requestedTarget: "approve",
        target: "approve~123456789abc",
        validation: { kind: "raw-string" },
        run,
      },
    ];
    for (const result of validControlResults) {
      const controlWorkspace = await testWorkspace("acpus-daemon-socket-valid-control-result-");
      const controlServer = await startRawResponseServer(controlWorkspace, { ok: true, result });
      try {
        expect(await requestDaemonControl(controlWorkspace, controlIntent(result.type))).toEqual(ok(result));
      } finally {
        await closeRawResponseServer(controlServer);
        await rm(controlWorkspace, { recursive: true, force: true });
      }
    }

    const admissionWorkspace = await testWorkspace("acpus-daemon-socket-admission-result-");
    const admissionServer = await startRawStreamServer(admissionWorkspace, [
      `${JSON.stringify({ kind: "admitted", authority: runtimeAuthority(), run: { id: "run_1", status: "running" } })}\n`,
    ]);
    try {
      expect(await collectStream(requestDaemonSubmitAndObserve(admissionWorkspace, submitInput("admitted"))))
        .toEqual([err(expect.objectContaining({
          type: "protocol",
          stage: "frame",
          reason: "malformed",
          method: "submitAndObserve",
          outcome: "unknown",
        }))]);
    } finally {
      await closeRawResponseServer(admissionServer);
      await rm(admissionWorkspace, { recursive: true, force: true });
    }
  });

  it("distinguishes current, predecessor, and unknown daemon status shapes", async () => {
    const currentWorkspace = await testWorkspace("acpus-daemon-status-current-");
    const currentServer = await startRawResponseServer(currentWorkspace, { ok: true, result: daemonStatus() });
    try {
      await expect(requestDaemonStatusProbe(currentWorkspace)).resolves.toEqual(ok({
        kind: "current",
        status: daemonStatus(),
      }));
    } finally {
      await closeRawResponseServer(currentServer);
      await rm(currentWorkspace, { recursive: true, force: true });
    }

    const predecessorWorkspace = await testWorkspace("acpus-daemon-status-v3-");
    const predecessor = { status: "ok", pid: process.pid, generation: 7, protocolVersion: 3, packageVersion: "old" };
    const predecessorServer = await startRawResponseServer(predecessorWorkspace, { ok: true, result: predecessor });
    try {
      await expect(requestDaemonStatusProbe(predecessorWorkspace)).resolves.toEqual(ok({
        kind: "predecessor",
        status: predecessor,
      }));
    } finally {
      await closeRawResponseServer(predecessorServer);
      await rm(predecessorWorkspace, { recursive: true, force: true });
    }

    const futureWorkspace = await testWorkspace("acpus-daemon-status-future-");
    const futureServer = await startRawResponseServer(futureWorkspace, {
      ok: true,
      result: { status: "ok", pid: process.pid, protocolVersion: 5, packageVersion: "future", authority: {} },
    });
    try {
      await expect(requestDaemonStatusProbe(futureWorkspace)).resolves.toEqual(ok({
        kind: "unknown",
        protocolVersion: 5,
      }));
    } finally {
      await closeRawResponseServer(futureServer);
      await rm(futureWorkspace, { recursive: true, force: true });
    }

    const futureAbiWorkspace = await testWorkspace("acpus-daemon-status-future-abi-");
    const futureAbiServer = await startRawResponseServer(futureAbiWorkspace, {
      ok: true,
      result: {
        ...daemonStatus(),
        authority: { ...runtimeAuthority(), runtimeAbi: 2 },
      },
    });
    try {
      await expect(requestDaemonStatusProbe(futureAbiWorkspace)).resolves.toEqual(ok({
        kind: "unknown",
        protocolVersion: 4,
      }));
    } finally {
      await closeRawResponseServer(futureAbiServer);
      await rm(futureAbiWorkspace, { recursive: true, force: true });
    }
  });

  it("incrementally parses split and coalesced NDJSON frames", async () => {
    const workspace = await testWorkspace("acpus-daemon-stream-chunks-");
    const admitted = admittedFrame();
    const closed = closedFrame();
    const first = `${JSON.stringify(admitted)}\n`;
    const second = `${JSON.stringify(closed)}\n`;
    const server = await startRawStreamServer(workspace, [first.slice(0, 9), `${first.slice(9)}${second}`]);
    try {
      expect(await collectStream(requestDaemonSubmitAndObserve(workspace, submitInput("subject-terminal"))))
        .toEqual([ok(admitted), ok(closed)]);
    } finally {
      await closeRawResponseServer(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies malformed and truncated NDJSON streams without guessing admission", async () => {
    const malformedWorkspace = await testWorkspace("acpus-daemon-stream-malformed-");
    const malformedServer = await startRawStreamServer(malformedWorkspace, ["{not-json}\n"]);
    try {
      expect(await collectStream(requestDaemonSubmitAndObserve(malformedWorkspace, submitInput("admitted"))))
        .toEqual([err(expect.objectContaining({
          type: "protocol",
          reason: "malformed",
          outcome: "unknown",
        }))]);
    } finally {
      await closeRawResponseServer(malformedServer);
      await rm(malformedWorkspace, { recursive: true, force: true });
    }

    const truncatedWorkspace = await testWorkspace("acpus-daemon-stream-truncated-");
    const admitted = admittedFrame();
    const truncatedServer = await startRawStreamServer(truncatedWorkspace, [`${JSON.stringify(admitted)}\n`]);
    try {
      expect(await collectStream(requestDaemonSubmitAndObserve(truncatedWorkspace, submitInput("subject-terminal"))))
        .toEqual([
          ok(admitted),
          err(expect.objectContaining({
            type: "protocol",
            reason: "truncated",
            outcome: "admitted",
            runId: "run_1",
          })),
        ]);
    } finally {
      await closeRawResponseServer(truncatedServer);
      await rm(truncatedWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed nested inspection observation shapes", async () => {
    const malformedObservations = [
      { kind: "attached", view: {} },
      {
        kind: "update",
        changes: [{ subject: { label: "task" }, state: { status: "not-a-status" } }],
      },
      {
        kind: "update",
        changes: [],
        timeline: [{ kind: "activity", at: "2026-08-11T00:00:00.000Z", channel: "thought", summary: "working" }],
      },
      {
        kind: "closed",
        reason: "subject-terminal",
        view: { ...runInspectionView(), tree: [{ type: "item", children: [] }] },
      },
    ];
    for (const observation of malformedObservations) {
      const workspace = await testWorkspace("acpus-daemon-stream-nested-malformed-");
      const admitted = admittedFrame();
      const server = await startRawStreamServer(workspace, [
        `${JSON.stringify(admitted)}\n${JSON.stringify({ kind: "observation", observation })}\n`,
      ]);
      try {
        expect(await collectStream(requestDaemonSubmitAndObserve(workspace, submitInput("subject-terminal"))))
          .toEqual([
            ok(admitted),
            err(expect.objectContaining({
              type: "protocol",
              stage: "frame",
              reason: "malformed",
              outcome: "admitted",
              runId: "run_1",
            })),
          ]);
      } finally {
        await closeRawResponseServer(server);
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });

  it("requires EOF immediately after an error frame", async () => {
    const workspace = await testWorkspace("acpus-daemon-stream-error-eof-");
    const failure = {
      kind: "error",
      phase: "authority",
      outcome: "not-admitted",
      error: { code: "AUTHORITY_MISMATCH", message: "authority changed" },
    } as const;
    const server = await startRawStreamServer(workspace, [
      `${JSON.stringify(failure)}\n${JSON.stringify(admittedFrame())}\n`,
    ]);
    try {
      expect(await collectStream(requestDaemonSubmitAndObserve(workspace, submitInput("admitted"))))
        .toEqual([
          ok(failure),
          err(expect.objectContaining({ type: "protocol", reason: "unexpected" })),
        ]);
    } finally {
      await closeRawResponseServer(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not cancel admission on disconnect and aborts only its observer afterward", async () => {
    const workspace = await testWorkspace("acpus-daemon-stream-detach-");
    const admissionStarted = deferred();
    const releaseAdmission = deferred();
    const observerAborted = deferred();
    let observerSignal: AbortSignal | undefined;
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      submitAndObserve: async function* (_request, signal) {
        observerSignal = signal;
        signal.addEventListener("abort", () => observerAborted.resolve(), { once: true });
        admissionStarted.resolve();
        await releaseAdmission.promise;
        yield admittedFrame();
      },
    });
    const detach = new AbortController();
    const stream = requestDaemonSubmitAndObserve(workspace, submitInput("subject-terminal"), { signal: detach.signal });
    const reading = collectStream(stream);
    try {
      await admissionStarted.promise;
      detach.abort();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(observerSignal?.aborted).toBe(false);
      releaseAdmission.resolve();
      await observerAborted.promise;
      expect(observerSignal?.aborted).toBe(true);
      expect(await reading).toEqual([]);
    } finally {
      releaseAdmission.resolve();
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("flushes large observation frames under socket backpressure", async () => {
    const workspace = await testWorkspace("acpus-daemon-stream-backpressure-");
    const large = "x".repeat(2 * 1024 * 1024);
    const update: DaemonRunStreamFrame = {
      kind: "observation",
      observation: {
        kind: "update",
        changes: [{ subject: { label: large, kind: "task" }, state: { status: "running" } }],
      },
    };
    const server = await startDaemonServer(workspace, {
      ...testHandlers(),
      submitAndObserve: async function* () {
        yield admittedFrame();
        yield update;
        yield closedFrame();
      },
    });
    try {
      const frames = await collectStream(requestDaemonSubmitAndObserve(workspace, submitInput("subject-terminal")));
      expect(frames).toHaveLength(3);
      expect(frames[0]).toEqual(ok(admittedFrame()));
      expect(frames[1]?.isOk() && frames[1].value.kind === "observation"
        ? frames[1].value.observation.kind === "update" && frames[1].value.observation.changes[0]?.subject.label.length
        : 0).toBe(large.length);
      expect(frames[2]).toEqual(ok(closedFrame()));
    } finally {
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function testHandlers(): Parameters<typeof startDaemonServer>[1] {
  return {
    status: () => ok(daemonStatus()),
    submitAndObserve: async function* () {
      yield {
        kind: "error",
        phase: "admission",
        outcome: "not-admitted",
        error: { code: "INTERNAL_ERROR", message: "not used" },
      };
    },
    control: () => err({ code: "INTERNAL_ERROR", message: "not used" }),
    shutdown: () => ok({ status: "shutdown" }),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function preparedRunWorkflow(): PreparedRunWorkflow {
  const digest = `sha256:${"a".repeat(64)}` as Sha256Digest;
  const source = { kind: "workspace", entry: "test.workflow.ts" } as const;
  const ir: PreparedRunWorkflow["ir"] = {
    irVersion: 7,
    name: "test",
    agents: {},
    root: { nodes: [], output: { kind: "object", fields: {} } },
    diagnostics: [],
  };
  return {
    source,
    ir,
    irJson: `${JSON.stringify(ir)}\n`,
    sourceGraphDigest: digest,
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 2,
      workflow: { source, entryDigest: digest },
      ir: { path: "workflow.ir.json", digest },
      sourceGraphDigest: digest,
    },
  };
}

function runDetails(): RunDetails {
  return {
    id: "run_1",
    name: "test",
    status: "running",
    workflowEntry: "test.workflow.ts",
    sourceGraphDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:01.000Z",
    progressVersion: 0,
    input: {},
    hooks: [],
    eventCount: 1,
    nodeCount: 1,
    execution: { state: "active", lastStatus: "running" },
  };
}

function runtimeAuthority(): RuntimeAuthorityIdentity {
  return {
    workspaceKey: "a".repeat(32),
    runtimeAbi: 1,
    layoutVersion: 2,
    storageVersion: 10,
    authorityId: "00000000-0000-4000-8000-000000000001",
    storeBinding: `sha256:${"b".repeat(64)}`,
    leaseGeneration: 1,
  };
}

function daemonStatus() {
  return {
    status: "ok" as const,
    pid: process.pid,
    leaseGeneration: 1,
    protocolVersion: 4 as const,
    packageVersion: "test",
    authority: runtimeAuthority(),
  };
}

function submitInput(until: "admitted" | "subject-terminal" | "decision-boundary") {
  return {
    expectedAuthority: runtimeAuthority(),
    requestId: "request-test",
    prepared: preparedRunWorkflow(),
    input: {},
    until,
  };
}

function admittedFrame(): Extract<DaemonRunStreamFrame, { kind: "admitted" }> {
  return { kind: "admitted", authority: runtimeAuthority(), run: runDetails() };
}

function closedFrame(): DaemonRunStreamFrame {
  return {
    kind: "observation",
    observation: {
      kind: "closed",
      reason: "subject-terminal",
      view: runInspectionView(),
    },
  };
}

function runInspectionView() {
  return {
    kind: "run" as const,
    run: {
      id: "run_1",
      name: "test",
      status: "completed" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      liveness: "terminal" as const,
    },
    counts: { total: 1, completed: 1 },
    tree: [],
  };
}

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function controlIntent(type: string): Parameters<typeof requestDaemonControl>[1] {
  const base = { requestId: type, runId: "run_1" };
  if (type === "signal") return { ...base, type, nodeId: "approve", payload: "ok" };
  if (type === "steer") return { ...base, type, target: "review", instruction: "focus" };
  if (type === "fork") return { ...base, type };
  if (type === "retry" || type === "cancel") return { ...base, type };
  if (type === "pause" || type === "resume") return { ...base, type };
  throw new Error(`Unsupported control type '${type}'.`);
}

async function sendRawRequest(endpoint: string, request: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    socket.once("error", reject);
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.end(JSON.stringify(request)));
  });
}

async function startRawResponseServer(workspace: string, response: unknown): Promise<ReturnType<typeof createServer>> {
  const endpoint = daemonEndpoint(workspace);
  await mkdir(dirname(endpoint), { recursive: true });
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.resume();
    socket.once("end", () => socket.end(JSON.stringify(response)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function startRawStreamServer(workspace: string, chunks: string[]): Promise<ReturnType<typeof createServer>> {
  const endpoint = daemonEndpoint(workspace);
  await mkdir(dirname(endpoint), { recursive: true });
  const server = createServer({ allowHalfOpen: true }, socket => {
    let request = "";
    socket.on("data", chunk => {
      request += Buffer.from(chunk).toString("utf8");
      if (!request.includes("\n")) return;
      socket.removeAllListeners("data");
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeRawResponseServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function testWorkspace(prefix: string): Promise<string> {
  const [workspace, home] = await Promise.all([
    mkdtemp(join(tmpdir(), prefix)),
    mkdtemp(join(tmpdir(), "acpus-daemon-home-")),
  ]);
  const restoreHome = setRuntimeHomeForTest(workspace, home);
  runtimeHomeCleanups.push(async () => {
    restoreHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });
  return workspace;
}
