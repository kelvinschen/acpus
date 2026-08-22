import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import { defineWorkflow } from "@acpus/core";
import { sha256Digest } from "@acpus/core/content-identity";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openWorkspaceRuntime as openWorkspaceRuntimeEffect } from "@acpus/runtime/host";
import { openWorkspaceRuntimeInternal as openWorkspaceRuntimeInternalEffect } from "../src/workspace-runtime.js";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
} from "../src/runtime-layout.js";
import { openRuntimeExclusiveLock } from "../src/runtime-lock-adapter.js";
import {
  readRuntimeDatabaseFormat,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
} from "../src/storage/database.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { tryCaptureRunFile } from "../src/store/run-file.js";
import {
  initializeRuntimeStoreForTest,
  prepareSyntheticWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { completedAgentTurn } from "./support/agent-turn.js";
import {
  createLegacyStore,
  startPredecessorDaemon,
} from "./support/runtime-store-lifecycle.js";
import { treeFingerprint } from "./support/tree-fingerprint.js";
import { testAgentSessionSupervisor } from "./support/agent-session-supervisor.js";
import { admitRunForTest } from "./support/runtime-store.js";

function runResult<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}

function openWorkspaceRuntime(...args: Parameters<typeof openWorkspaceRuntimeEffect>) {
  return runResult(openWorkspaceRuntimeEffect(...args));
}

function openWorkspaceRuntimeInternal(...args: Parameters<typeof openWorkspaceRuntimeInternalEffect>) {
  return runResult(openWorkspaceRuntimeInternalEffect(...args));
}

describe.concurrent("WorkspaceRuntime", () => {
  it("requires an absolute state root", async () => {
    const opened = await openWorkspaceRuntime({ workspace: process.cwd(), stateRoot: "relative" });
    expect(Result.getOrThrow(Result.flip(opened))).toMatchObject({
      type: "runtime-open-failed",
      message: expect.stringContaining("absolute"),
    });
  });

  it("owns admission, bound reads, contention, and clean reacquisition", async () => {
    await withRuntimeWorkspace("workspace-runtime", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const stateRoot = join(workspace, "host-state");
      const opened = await openWorkspaceRuntime({ workspace, stateRoot });
      expect(Result.isSuccess(opened)).toBe(true);
      const runtime = Result.getOrThrow(opened);
      try {
        const isolated = Result.getOrThrow((await openWorkspaceRuntime({
          workspace,
          stateRoot: join(workspace, "other-host-state"),
        })));
        await Effect.runPromise(isolated.close());

        const contention = await openWorkspaceRuntime({ workspace, stateRoot });
        expect(Result.getOrThrow(Result.flip(contention))).toMatchObject({
          type: "runtime-authority-busy",
          pid: process.pid,
        });

        const admitted = Result.getOrThrow((await runResult(runtime.submit({
          requestId: "test-session:root-call",
          prepared,
          input: { ready: true },
        }))));
        expect(admitted).toMatchObject({ status: "pending", name: "cli-valid" });

        expect(Result.getOrThrow((await runResult(runtime.findAdmission("test-session:root-call")))))
          .toMatchObject({ id: admitted.id });
        expect(Result.getOrThrow((await runResult(runtime.inspect({ kind: "run", runId: admitted.id })))))
          .toMatchObject({ kind: "run", run: { id: admitted.id } });
        const db = new DatabaseSync(resolveRuntimeLayout(workspace, { runtimeHome: stateRoot }).databasePath, { readOnly: true });
        try {
          const columns = db.prepare("PRAGMA table_info(runtime_authority)").all()
            .map(column => (column as { name: string }).name);
          expect(columns).toContain("process_start_token");
          expect(columns).not.toContain("owner_kind");
        } finally {
          db.close();
        }
      } finally {
        await Effect.runPromise(runtime.close());
      }

      const reopened = await openWorkspaceRuntime({ workspace, stateRoot });
      const next = Result.getOrThrow(reopened);
      try {
        expect(next.workspace).toBe(workspace);
      } finally {
        await Effect.runPromise(next.close());
      }
    });
  });

  it("maps verified artifact read failures through the WorkspaceRuntime error channel", async () => {
    await withRuntimeWorkspace("workspace-runtime-artifact-read", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      let runId: string;
      let artifactPath: string;
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        const claim = store.scheduler.claimRun(run.id, "artifact-owner", 60_000);
        if (claim === undefined) throw new Error("Expected artifact setup to claim the run.");
        const snapshot = store.scheduler.tryLoadRunSnapshot(run.id);
        const ready = store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: snapshot.version,
          idempotencyKey: "artifact-setup:ready",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            {
              type: "instance.ready",
              payload: {
                runId: run.id,
                nodeKey: "require_ready",
                nodeId: "require_ready",
                instancePath: [{ kind: "node", nodeId: "require_ready" }],
                parentFrameKey: "root",
                readinessSequence: 1,
              },
            },
          ],
        });
        const started = store.scheduler.tryStartAttempt({
          runId: run.id,
          nodeKey: "require_ready",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: ready.version,
          idempotencyKey: "artifact-setup:start",
        });
        if (started.disposition !== "started") throw new Error("Expected artifact setup attempt to start.");
        const bytes = Buffer.from("x");
        const relativePath = "artifacts/require_ready/attempt-1/artifact_verified.txt";
        const runDirectory = store.getRunDir(run.id);
        const runToken = store.getRunDirectoryToken(run.id);
        if (runDirectory === undefined || runToken === undefined) throw new Error("Expected run directory evidence.");
        artifactPath = join(runDirectory, relativePath);
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, bytes);
        store.registerArtifact({
          id: "artifact_verified",
          runId: run.id,
          nodeKey: "require_ready",
          attempt: 1,
          attemptId: started.attemptId,
          ownerEpoch: claim.ownerEpoch,
          digest: sha256Digest(bytes),
          size: bytes.byteLength,
          relativePath,
          file: Result.getOrThrow(tryCaptureRunFile(runToken, artifactPath, "Artifact 'artifact_verified'")),
        });
        store.scheduler.releaseRun(claim);
      } finally {
        store.close();
      }

      const opened = await openWorkspaceRuntimeInternal(workspace, {
        agentSessionSupervisor: testAgentSessionSupervisor(async () => completedAgentTurn("unused")),
      });
      const runtime = Result.getOrThrow(opened);
      try {
        await writeFile(artifactPath!, "changed");
        const read = await runResult(runtime.readArtifact(runId!, "artifact_verified"));
        expect(Result.getOrThrow(Result.flip(read))).toMatchObject({
          type: "runtime-store-unavailable",
          message: expect.stringMatching(/size\/digest verification|changed identity/u),
        });
      } finally {
        await Effect.runPromise(runtime.close());
      }
    });
  });

  it("rejects a lazy submit first executed after the shutdown admission fence", async () => {
    await withRuntimeWorkspace("workspace-runtime-late-submit", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const stateRoot = join(workspace, "host-state");
      const runtime = Result.getOrThrow((await openWorkspaceRuntime({ workspace, stateRoot })));
      const requestId = "late-submit-after-close";
      const lateSubmit = runtime.submit({ requestId, prepared, input: { ready: true } });

      await Effect.runPromise(runtime.close());

      expect(Result.getOrThrow(Result.flip((await runResult(lateSubmit))))).toMatchObject({
        type: "runtime-submit-failed",
        code: "EXECUTION_UNAVAILABLE",
        outcome: "not-admitted",
      });
      const db = new DatabaseSync(resolveRuntimeLayout(workspace, { runtimeHome: stateRoot }).databasePath, { readOnly: true });
      try {
        expect(db.prepare(`
          SELECT COUNT(*) AS count
          FROM run_events
          WHERE idempotency_key = ?
            AND type = 'run.admitted'
        `).get(`admission-request:${requestId}`)).toMatchObject({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  it("repairs an explicitly rooted legacy store without observing the CLI store or daemon", async () => {
    await withRuntimeWorkspace("workspace-runtime-repair", async workspace => {
      const stateRoot = join(workspace, "host-state");
      await createLegacyStore(
        workspace,
        RUNTIME_STORAGE_VERSION - 1,
        undefined,
        { runtimeHome: stateRoot },
      );
      const hostWorkspace = resolveRuntimeWorkspaceLayout(workspace, { runtimeHome: stateRoot });
      const sourceDatabase = await readFile(hostWorkspace.databasePath);

      await initializeRuntimeStoreForTest(workspace);
      const cliWorkspace = resolveRuntimeWorkspaceLayout(workspace);
      const cliStoreBefore = await treeFingerprint(cliWorkspace.workspaceRoot);
      const cliDaemon = await startPredecessorDaemon(workspace);
      try {
        const opened = await openWorkspaceRuntime({ workspace, stateRoot });
        expect(Result.isSuccess(opened)).toBe(true);
        const runtime = Result.getOrThrow(opened);
        await Effect.runPromise(runtime.close());

        const active = resolveRuntimeLayout(workspace, { runtimeHome: stateRoot });
        const generationIds = (await readdir(hostWorkspace.generationsRoot)).sort();
        expect(generationIds).toHaveLength(2);
        const sourceGenerationId = generationIds.find(id => id !== active.generationId);
        if (!sourceGenerationId) throw new Error("Expected one sealed source generation.");
        const source = runtimeLayoutForGeneration(hostWorkspace, sourceGenerationId);
        expect(await readFile(source.databasePath)).toEqual(sourceDatabase);
        expect(await readRuntimeDatabaseFormat(active.databasePath)).toEqual({
          applicationId: RUNTIME_APPLICATION_ID,
          userVersion: RUNTIME_STORAGE_VERSION,
        });
        expect(cliDaemon.statusRequests()).toBe(0);
        expect(cliDaemon.shutdownRequests()).toBe(0);
        expect(await treeFingerprint(cliWorkspace.workspaceRoot)).toBe(cliStoreBefore);
      } finally {
        await cliDaemon.close();
      }
    });
  });

  it("leaves an explicitly rooted newer store byte-for-byte unchanged", async () => {
    await withRuntimeWorkspace("workspace-runtime-unsupported", async workspace => {
      const stateRoot = join(workspace, "host-state");
      await createLegacyStore(
        workspace,
        RUNTIME_STORAGE_VERSION + 1,
        undefined,
        { runtimeHome: stateRoot },
      );
      const before = await treeFingerprint(stateRoot);

      const opened = await openWorkspaceRuntime({ workspace, stateRoot });

      expect(Result.getOrThrow(Result.flip(opened))).toMatchObject({ type: "runtime-store-unsupported" });
      expect(await treeFingerprint(stateRoot)).toBe(before);
    });
  });

  it("releases the opened store and shared lock when later Host startup fails", async () => {
    await withRuntimeWorkspace("workspace-runtime-startup-release", async workspace => {
      const stateRoot = join(workspace, "host-state");
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "config.json"), JSON.stringify({
        hooks: { "run.completed": [{ command: "" }] },
      }));

      const failed = await openWorkspaceRuntime({ workspace, stateRoot });

      expect(Result.getOrThrow(Result.flip(failed))).toMatchObject({
        type: "runtime-open-failed",
        message: expect.stringContaining("Invalid Acpus config"),
      });
      const exclusive = await openRuntimeExclusiveLock(resolveRuntimeLayout(workspace, {
        runtimeHome: stateRoot,
      }));
      await exclusive.release();

      await writeFile(join(workspace, ".acpus", "config.json"), "{}\n");
      const reopened = Result.getOrThrow((await openWorkspaceRuntime({ workspace, stateRoot })));
      await Effect.runPromise(reopened.close());
    });
  });

  it("repairs once when two Hosts concurrently open the same legacy store", async () => {
    await withRuntimeWorkspace("workspace-runtime-concurrent-repair", async workspace => {
      const stateRoot = join(workspace, "host-state");
      await createLegacyStore(
        workspace,
        RUNTIME_STORAGE_VERSION - 1,
        undefined,
        { runtimeHome: stateRoot },
      );

      const opened = await Promise.all([
        openWorkspaceRuntime({ workspace, stateRoot }),
        openWorkspaceRuntime({ workspace, stateRoot }),
      ]);
      const runtimes = opened.flatMap(result => Result.isSuccess(result) ? [result.success] : []);
      try {
        expect(runtimes).toHaveLength(1);
        expect(opened.flatMap(result => Result.isFailure(result) ? [result.failure.type] : []))
          .toEqual(["runtime-authority-busy"]);
        const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace, { runtimeHome: stateRoot });
        expect(await readdir(workspaceLayout.generationsRoot)).toHaveLength(2);
        expect(await readRuntimeDatabaseFormat(
          resolveRuntimeLayout(workspace, { runtimeHome: stateRoot }).databasePath,
        )).toMatchObject({ userVersion: RUNTIME_STORAGE_VERSION });
      } finally {
        await Promise.all(runtimes.map(runtime => Effect.runPromise(runtime.close())));
      }
    });
  });

  it("starts Supervisor cleanup without waiting for blocked sessions and fails closed on unknown settlement", async () => {
    await withRuntimeWorkspace("workspace-runtime-shutdown", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, blockingAgentWorkflow());
      const turnStarted = deferred<void>();
      const turnSettled = deferred<never>();
      const cleanupStarted = deferred<void>();
      const shutdown = vi.fn(() => Effect.sync(() => {
        cleanupStarted.resolve();
        turnSettled.reject(new Error("executor stopped"));
      }));
      const agentSessionSupervisor: AgentSessionSupervisor = testAgentSessionSupervisor(async () => {
        turnStarted.resolve();
        return turnSettled.promise;
      }, shutdown);
      const opened = await openWorkspaceRuntimeInternal(workspace, { agentSessionSupervisor });
      expect(Result.isSuccess(opened)).toBe(true);
      const runtime = Result.getOrThrow(opened);

      Result.getOrThrow((await runResult(runtime.submit({
        requestId: "test-session:blocked-agent",
        prepared,
        input: {},
      }))));
      await turnStarted.promise;

      const closed = Effect.runPromise(runtime.close());
      await cleanupStarted.promise;
      await closed;

      expect(shutdown).toHaveBeenCalledOnce();

      const incidents: unknown[] = [];
      const reopened = await openWorkspaceRuntimeInternal(workspace, {
        onRunIncident: incident => incidents.push(incident),
        agentSessionSupervisor: testAgentSessionSupervisor(async () => completedAgentTurn("reviewed")),
      });
      expect(Result.isSuccess(reopened)).toBe(true);
      const recoveredRuntime = Result.getOrThrow(reopened);
      try {
        const admitted = Result.getOrThrow((await runResult(
          recoveredRuntime.findAdmission("test-session:blocked-agent"),
        )));
        if (admitted === undefined) throw new Error("Expected the interrupted run.");
        let terminalStatus: string | undefined;
        for await (const observed of Stream.toAsyncIterable(Stream.result(recoveredRuntime.observeInspection({
          view: { kind: "run", runId: admitted.id },
          until: "subject-terminal",
        }, AbortSignal.timeout(3_000))))) {
          const value = Result.getOrThrow(observed);
          if (value.kind === "closed" && value.view.kind === "run") {
            terminalStatus = value.view.run.status;
          }
        }
        expect(terminalStatus).toBe("failed");
        expect(incidents).toEqual([]);
      } finally {
        await Effect.runPromise(recoveredRuntime.close());
      }
    });
  });
});

function blockingAgentWorkflow() {
  return defineWorkflow({
    name: "workspace-runtime-blocking-agent",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.reviewer, prompt: "Review." });
    return {};
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
