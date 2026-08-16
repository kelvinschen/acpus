import type { ManagedAcpExecutor } from "@acpus/agent-executor";
import { defineWorkflow } from "@acpus/core";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openWorkspaceRuntime } from "@acpus/runtime/host";
import { openWorkspaceRuntimeInternal } from "../src/workspace-runtime.js";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runtimeLayoutForGeneration,
} from "../src/runtime-layout.js";
import {
  readRuntimeDatabaseFormat,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
} from "../src/storage/database.js";
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

describe.concurrent("WorkspaceRuntime", () => {
  it("requires an absolute state root", async () => {
    const opened = await openWorkspaceRuntime({ workspace: process.cwd(), stateRoot: "relative" });
    expect(opened._unsafeUnwrapErr()).toMatchObject({
      type: "runtime-open-failed",
      message: expect.stringContaining("absolute"),
    });
  });

  it("owns admission, bound reads, contention, and clean reacquisition", async () => {
    await withRuntimeWorkspace("workspace-runtime", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const stateRoot = join(workspace, "host-state");
      const opened = await openWorkspaceRuntime({ workspace, stateRoot });
      expect(opened.isOk()).toBe(true);
      const runtime = opened._unsafeUnwrap();
      try {
        const isolated = (await openWorkspaceRuntime({
          workspace,
          stateRoot: join(workspace, "other-host-state"),
        }))._unsafeUnwrap();
        await isolated.close();

        const contention = await openWorkspaceRuntime({ workspace, stateRoot });
        expect(contention._unsafeUnwrapErr()).toMatchObject({
          type: "runtime-authority-busy",
          pid: process.pid,
        });

        const admitted = (await runtime.submit({
          requestId: "test-session:root-call",
          prepared,
          input: { ready: true },
        }))._unsafeUnwrap();
        expect(admitted).toMatchObject({ status: "pending", name: "cli-valid" });

        expect((await runtime.findAdmission("test-session:root-call"))._unsafeUnwrap())
          .toMatchObject({ id: admitted.id });
        expect((await runtime.inspect({ kind: "run", runId: admitted.id }))._unsafeUnwrap())
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
        await runtime.close();
      }

      const reopened = await openWorkspaceRuntime({ workspace, stateRoot });
      const next = reopened._unsafeUnwrap();
      try {
        expect(next.workspace).toBe(workspace);
      } finally {
        await next.close();
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
        expect(opened.isOk()).toBe(true);
        const runtime = opened._unsafeUnwrap();
        await runtime.close();

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

      expect(opened._unsafeUnwrapErr()).toMatchObject({ type: "runtime-store-unsupported" });
      expect(await treeFingerprint(stateRoot)).toBe(before);
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
      const runtimes = opened.flatMap(result => result.isOk() ? [result.value] : []);
      try {
        expect(runtimes).toHaveLength(1);
        expect(opened.flatMap(result => result.isErr() ? [result.error.type] : []))
          .toEqual(["runtime-authority-busy"]);
        const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace, { runtimeHome: stateRoot });
        expect(await readdir(workspaceLayout.generationsRoot)).toHaveLength(2);
        expect(await readRuntimeDatabaseFormat(
          resolveRuntimeLayout(workspace, { runtimeHome: stateRoot }).databasePath,
        )).toMatchObject({ userVersion: RUNTIME_STORAGE_VERSION });
      } finally {
        await Promise.all(runtimes.map(runtime => runtime.close()));
      }
    });
  });

  it("starts managed ACP cleanup without waiting for blocked sessions", async () => {
    await withRuntimeWorkspace("workspace-runtime-shutdown", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, blockingAgentWorkflow());
      const turnStarted = deferred<void>();
      const turnSettled = deferred<never>();
      const shutdown = vi.fn(async () => turnSettled.reject(new Error("executor stopped")));
      const managedAcpExecutor: ManagedAcpExecutor = {
        withAttempt: async (_input, use) => use({
          runTurn: async () => {
            turnStarted.resolve();
            return turnSettled.promise;
          },
        }),
        shutdown,
      };
      const opened = await openWorkspaceRuntimeInternal(workspace, { managedAcpExecutor });
      expect(opened.isOk()).toBe(true);
      const runtime = opened._unsafeUnwrap();

      (await runtime.submit({
        requestId: "test-session:blocked-agent",
        prepared,
        input: {},
      }))._unsafeUnwrap();
      await turnStarted.promise;

      const closed = runtime.close();
      await new Promise(resolve => setTimeout(resolve, 50));
      const cleanupStartedPromptly = shutdown.mock.calls.length === 1;
      await closed;

      expect(cleanupStartedPromptly).toBe(true);

      const incidents: unknown[] = [];
      const reopened = await openWorkspaceRuntimeInternal(workspace, {
        onRunIncident: incident => incidents.push(incident),
        managedAcpExecutor: {
          withAttempt: async (_input, use) => use({
            runTurn: async () => completedAgentTurn("reviewed"),
          }),
          shutdown: async () => undefined,
        },
      });
      expect(reopened.isOk()).toBe(true);
      const recoveredRuntime = reopened._unsafeUnwrap();
      try {
        const admitted = (await recoveredRuntime.findAdmission("test-session:blocked-agent"))
          ._unsafeUnwrap();
        if (admitted === undefined) throw new Error("Expected the interrupted run.");
        let terminalStatus: string | undefined;
        for await (const observed of recoveredRuntime.observeInspection({
          view: { kind: "run", runId: admitted.id },
          until: "subject-terminal",
        }, AbortSignal.timeout(3_000))) {
          const value = observed._unsafeUnwrap();
          if (value.kind === "closed" && value.view.kind === "run") {
            terminalStatus = value.view.run.status;
          }
        }
        expect(terminalStatus).toBe("completed");
        expect(incidents).toEqual([]);
      } finally {
        await recoveredRuntime.close();
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
